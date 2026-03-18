/**
 * request-mic-permission.js — Mic capture popup
 * Runs in a real popup window (not side panel), so Chrome shows the mic permission prompt.
 * Owns the full mic pipeline: getUserMedia → AudioWorklet → Deepgram WebSocket.
 * Sends TRANSCRIPT messages back to the side panel via window.opener.postMessage.
 */

const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const hint = document.getElementById('hint');

let audioContext, workletNode, mediaStream, socket;

function setStatus(state, text, hintText) {
  dot.className = 'dot' + (state === 'active' ? ' active' : state === 'error' ? ' error' : '');
  statusText.textContent = text;
  if (hintText !== undefined) hint.textContent = hintText;
}

// Signal to side panel that this popup is loaded and ready
window.addEventListener('load', () => {
  window.opener?.postMessage({ type: 'MIC_READY' }, '*');
});

// Receive START / STOP from side panel
window.addEventListener('message', async (event) => {
  if (!event.data) return;
  if (event.data.type === 'START') await startCapture(event.data.deepgramKey);
  if (event.data.type === 'STOP') { stopCapture(); window.close(); }
});

async function startCapture(deepgramKey) {
  setStatus('', 'Requesting microphone…', 'Click Allow in the prompt above.');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    setStatus('error', 'Mic access denied', 'Check browser mic permissions and retry.');
    window.opener?.postMessage({ type: 'MIC_ERROR', error: e.message }, '*');
    return;
  }

  setStatus('', 'Connecting to transcription…', 'Keep this window open during the meeting.');

  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));

  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
  const silentDest = audioContext.createMediaStreamDestination();
  source.connect(workletNode);
  workletNode.connect(silentDest); // no mic playback — Deepgram only

  const url = `wss://api.deepgram.com/v1/listen`
    + `?model=nova-2&encoding=linear16`
    + `&sample_rate=${audioContext.sampleRate}`
    + `&channels=1&smart_format=true&interim_results=true`;

  socket = new WebSocket(url, ['token', deepgramKey]);

  workletNode.port.onmessage = (e) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(e.data);
  };

  socket.onopen = () => {
    setStatus('active', '🎤 Listening (You)', 'Keep this window open during the meeting.');
    window.opener?.postMessage({ type: 'MIC_STARTED' }, '*');
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const alt = data?.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;
      window.opener?.postMessage({
        type: 'TRANSCRIPT',
        text: alt.transcript.trim(),
        isFinal: data.is_final === true,
        speaker: 'you'
      }, '*');
    } catch (_) {}
  };

  socket.onerror = () => setStatus('error', 'Connection error', 'Deepgram WebSocket failed.');
  socket.onclose = (e) => {
    if (e.code !== 1005) setStatus('error', `Disconnected (${e.code})`, 'Refresh to reconnect.');
  };
}

function stopCapture() {
  workletNode?.port.postMessage('stop');
  workletNode?.disconnect();
  workletNode = null;
  mediaStream?.getTracks().forEach(t => t.stop());
  mediaStream = null;
  if (socket) { socket.close(); socket = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
}

// Notify side panel if the user manually closes this popup
window.addEventListener('beforeunload', () => {
  window.opener?.postMessage({ type: 'MIC_POPUP_CLOSED' }, '*');
});
