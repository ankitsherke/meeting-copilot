/**
 * background.js — Service Worker
 * Gets the tab capture stream ID and passes it to the side panel.
 * All audio processing now runs in the side panel (visible page = real audio output).
 */

let recordingTabId = null;

// ── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START_CAPTURE':
      handleStartCapture(msg.tabId).then(sendResponse).catch(e => {
        console.error('[BG] Start capture error:', e);
        sendResponse({ error: e.message });
      });
      return true;

    case 'STOP_CAPTURE':
      recordingTabId = null;
      sendResponse({ success: true });
      return true;

    case 'INJECT_MIC_IFRAME':
      injectMicPermissionIframe(msg.tabId).then(sendResponse).catch(e => {
        sendResponse({ error: e.message });
      });
      return true;
  }
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Capture Flow ──────────────────────────────────────────────────────────────

// ── Mic Permission Iframe ──────────────────────────────────────────────────────
// Side panels can't show the mic permission prompt. Instead we inject a hidden
// iframe (from the extension's own origin) into the active tab. Extension iframes
// CAN show the prompt, and once granted Chrome caches it for the extension so the
// side panel's subsequent getUserMedia call succeeds.

async function injectMicPermissionIframe(tabId) {
  const iframeSrc = chrome.runtime.getURL('request-mic-permission.html');
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (src) => {
      if (document.getElementById('__copilot_mic_iframe')) return;
      const iframe = document.createElement('iframe');
      iframe.id = '__copilot_mic_iframe';
      iframe.setAttribute('hidden', 'hidden');
      iframe.setAttribute('allow', 'microphone');
      iframe.src = src;
      document.body.appendChild(iframe);
    },
    args: [iframeSrc]
  });
  return { success: true };
}

// ── Capture Flow ──────────────────────────────────────────────────────────────

async function handleStartCapture(tabId) {
  recordingTabId = tabId;

  const { deepgramKey } = await chrome.storage.local.get(['deepgramKey']);

  // Get stream ID and return it to the side panel.
  // Side panel will call getUserMedia with this ID — it's a visible page,
  // so AudioContext.destination routes to real speakers.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  return { success: true, streamId, deepgramKey: deepgramKey || '' };
}
