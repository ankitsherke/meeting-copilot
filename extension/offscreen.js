/**
 * offscreen.js — Audio capture + Deepgram transcription
 * Captures tab audio (speaker=guest) AND microphone (speaker=you).
 * Two independent Deepgram WebSocket connections, one per stream.
 */

let DEEPGRAM_KEY = '';

// ── Tab audio state ────────────────────────────────────────────────────────────
let tabAudioContext = null;
let tabWorkletNode = null;
let tabMediaStream = null;
let tabSocket = null;

// ── Mic audio state ────────────────────────────────────────────────────────────
let micAudioContext = null;
let micWorkletNode = null;
let micMediaStream = null;
let micSocket = null;

let isRunning = false;

// ── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'START_STREAM':
      DEEPGRAM_KEY = msg.deepgramKey || '';
      startTabCapture(msg.streamId).catch(e => {
        console.error('[OFFSCREEN] Tab capture start failed:', e);
        notifyStatus('error', e.message);
      });
      break;

    case 'STOP_STREAM':
      stopCapture();
      sendResponse({ success: true });
      break;

    case 'KEEPALIVE':
      sendResponse({ type: 'KEEPALIVE_ACK' });
      break;
  }
});

// ── Tab Audio Capture ─────────────────────────────────────────────────────────

async function startTabCapture(streamId) {
  if (isRunning) return;

  if (!DEEPGRAM_KEY) {
    notifyStatus('error', 'Deepgram API key not set.');
    return;
  }

  notifyStatus('connecting', 'Connecting to transcription service...');

  // 1. Get tab audio stream
  tabMediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // 2. AudioContext at native sample rate
  tabAudioContext = new AudioContext();
  const nativeSampleRate = tabAudioContext.sampleRate;
  console.log('[OFFSCREEN] Tab AudioContext sample rate:', nativeSampleRate);

  // 3. Load AudioWorklet
  await tabAudioContext.audioWorklet.addModule(
    chrome.runtime.getURL('audio-processor.js')
  );

  // 4. Build audio graph
  const source = tabAudioContext.createMediaStreamSource(tabMediaStream);
  tabWorkletNode = new AudioWorkletNode(tabAudioContext, 'pcm-processor');

  // Route to: (a) worklet → Deepgram, (b) destination → keeps tab audio audible
  source.connect(tabWorkletNode);
  source.connect(tabAudioContext.destination);

  // Worklet needs an output node to stay active (silent dest)
  const silentDest = tabAudioContext.createMediaStreamDestination();
  tabWorkletNode.connect(silentDest);

  // 5. PCM buffers → Deepgram WebSocket
  tabWorkletNode.port.onmessage = (e) => {
    if (tabSocket && tabSocket.readyState === WebSocket.OPEN) {
      tabSocket.send(e.data);
    }
  };

  // 6. Open Deepgram WebSocket for tab (guest)
  tabSocket = openDeepgramSocket(nativeSampleRate, 'guest');

  isRunning = true;
}

// ── Mic Audio Capture ─────────────────────────────────────────────────────────

async function startMicCapture() {
  try {
    micMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    console.warn('[OFFSCREEN] Mic access denied:', e);
    notifyStatus('mic_denied', 'Mic access denied — showing guest audio only.');
    return;
  }

  micAudioContext = new AudioContext();
  const micSampleRate = micAudioContext.sampleRate;
  console.log('[OFFSCREEN] Mic AudioContext sample rate:', micSampleRate);

  // Must addModule per AudioContext — worklet registration is context-scoped
  await micAudioContext.audioWorklet.addModule(
    chrome.runtime.getURL('audio-processor.js')
  );

  const micSource = micAudioContext.createMediaStreamSource(micMediaStream);
  micWorkletNode = new AudioWorkletNode(micAudioContext, 'pcm-processor');

  // Do NOT route mic to destination — no playback feedback
  const silentDest = micAudioContext.createMediaStreamDestination();
  micSource.connect(micWorkletNode);
  micWorkletNode.connect(silentDest);

  micWorkletNode.port.onmessage = (e) => {
    if (micSocket && micSocket.readyState === WebSocket.OPEN) {
      micSocket.send(e.data);
    }
  };

  micSocket = openDeepgramSocket(micSampleRate, 'you');
}

// ── Stop ──────────────────────────────────────────────────────────────────────

function stopCapture() {
  isRunning = false;

  // Stop tab pipeline
  tabWorkletNode?.port.postMessage('stop');
  tabWorkletNode?.disconnect();
  tabWorkletNode = null;

  tabMediaStream?.getTracks().forEach(t => t.stop());
  tabMediaStream = null;

  if (tabSocket) { tabSocket.close(); tabSocket = null; }
  if (tabAudioContext) { tabAudioContext.close(); tabAudioContext = null; }

  // Stop mic pipeline
  micWorkletNode?.port.postMessage('stop');
  micWorkletNode?.disconnect();
  micWorkletNode = null;

  micMediaStream?.getTracks().forEach(t => t.stop());
  micMediaStream = null;

  if (micSocket) { micSocket.close(); micSocket = null; }
  if (micAudioContext) { micAudioContext.close(); micAudioContext = null; }

  notifyStatus('stopped', 'Stopped listening.');
}

// ── Deepgram WebSocket ────────────────────────────────────────────────────────

function openDeepgramSocket(sampleRate, speaker) {
  console.log(`[OFFSCREEN] Opening Deepgram socket (${speaker}) at ${sampleRate}Hz`);
  console.log('[OFFSCREEN] Using Deepgram key:', DEEPGRAM_KEY ? DEEPGRAM_KEY.slice(0, 8) + '...' : 'EMPTY — key not set!');

  const url = `wss://api.deepgram.com/v1/listen`
    + `?model=nova-2`
    + `&encoding=linear16`
    + `&sample_rate=${sampleRate}`
    + `&channels=1`
    + `&smart_format=true`
    + `&interim_results=true`;

  // Browser WebSocket cannot set Authorization headers — use Sec-WebSocket-Protocol for auth
  const socket = new WebSocket(url, ['token', DEEPGRAM_KEY]);

  socket.onopen = () => {
    console.log(`[OFFSCREEN] Deepgram connected (${speaker})`);
    if (speaker === 'guest') notifyStatus('recording', 'Listening...');
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const alt = data?.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      const transcript = alt.transcript.trim();
      if (!transcript) return;

      chrome.runtime.sendMessage({
        type: 'TRANSCRIPT',
        speaker,
        text: transcript,
        isFinal: data.is_final === true
      });
    } catch (e) {
      console.error(`[OFFSCREEN] Parse error (${speaker}):`, e);
    }
  };

  socket.onerror = (e) => {
    console.error(`[OFFSCREEN] Deepgram error (${speaker}):`, e);
    if (speaker === 'guest') notifyStatus('error', 'Transcription connection error.');
  };

  socket.onclose = (e) => {
    // 1005 = no status code present — normal when we call socket.close() ourselves
    if (e.code === 1005) return;
    console.warn(`[OFFSCREEN] Deepgram closed (${speaker}):`, e.code, e.reason);
    if (isRunning && speaker === 'guest') {
      notifyStatus('error', `Connection closed (${e.code}). Refresh to reconnect.`);
    }
  };

  return socket;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function notifyStatus(state, message) {
  chrome.runtime.sendMessage({ type: 'STATUS', state, message });
}
