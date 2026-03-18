/**
 * sidepanel.js — Side Panel UI Logic
 * Features: dual audio (You/Guest), split transcript, meeting prep briefing, dynamic nudges.
 */

const BACKEND_URL = 'https://meeting-copilot-iota.vercel.app';
const INTERROGATIVE_STARTERS = /^(what|how|when|where|why|who|which|can|could|do|does|did|is|are|was|were|will|would|should|shall)\b/i;
const DEBOUNCE_MS = 3000;
const NUDGE_INTERVAL_MS = 50000; // 50 seconds

// ── State ─────────────────────────────────────────────────────────────────────
let isRecording = false;
let transcriptBuffer = []; // { text, timestamp, speaker }
let currentInterim = { you: '', guest: '' };
let queryDebounceTimer = null;
let lastQueryTime = 0;
let timerInterval = null;
let recordingStart = null;
let suggestionHistory = [];

// Tab audio capture state (guest speaker)
let tabAudioContext = null;
let tabWorkletNode = null;
let tabMediaStream = null;
let tabSocket = null;

// Mic capture state (you)
let micAudioContext = null;
let micWorkletNode = null;
let micMediaStream = null;
let micSocket = null;

// Meeting Prep state
let agendaItems = []; // { item, keywords, covered, coveredAt }
let dismissedNudges = [];
let nudgeInterval = null;

// ── DOM Refs ──────────────────────────────────────────────────────────────────
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const manualBtn = document.getElementById('manualBtn');
const clearBtn = document.getElementById('clearBtn');
const copyBtn = document.getElementById('copyBtn');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const historyToggle = document.getElementById('historyToggle');

const transcriptEl = document.getElementById('transcript');
const suggestionSection = document.getElementById('suggestionSection');
const suggestionText = document.getElementById('suggestionText');
const sourceLabel = document.getElementById('sourceLabel');
const spinner = document.getElementById('spinner');
const historySection = document.getElementById('historySection');
const historyList = document.getElementById('historyList');
const apiSetup = document.getElementById('apiSetup');
const deepgramKeyInput = document.getElementById('deepgramKeyInput');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const timerEl = document.getElementById('timer');

// Meeting Prep refs
const meetingPrepToggle = document.getElementById('meetingPrepToggle');
const meetingPrepBody = document.getElementById('meetingPrepBody');
const agendaText = document.getElementById('agendaText');
const generateBriefBtn = document.getElementById('generateBriefBtn');
const prepInputArea = document.getElementById('prepInputArea');
const briefingCard = document.getElementById('briefingCard');
const briefingContent = document.getElementById('briefingContent');
const agendaChecklist = document.getElementById('agendaChecklist');

const micBanner = document.getElementById('micBanner');
const micAllowBtn = document.getElementById('micAllowBtn');

// Nudge refs
const nudgesSection = document.getElementById('nudgesSection');
const nudgesList = document.getElementById('nudgesList');
const nudgeSpinner = document.getElementById('nudgeSpinner');

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['deepgramKey'], (result) => {
  if (result.deepgramKey) {
    apiSetup.style.display = 'none';
  }
  deepgramKeyInput.value = result.deepgramKey || '';
});

// ── Button Handlers ───────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const key = deepgramKeyInput.value.trim();
  if (!key) {
    apiSetup.style.display = 'block';
    deepgramKeyInput.focus();
    return;
  }
  chrome.storage.local.set({ deepgramKey: key });
  apiSetup.style.display = 'none';
  await startListening(key);
});

stopBtn.addEventListener('click', stopListening);

manualBtn.addEventListener('click', () => {
  const recentText = getRecentTranscript();
  if (recentText) triggerQuery(recentText, recentText);
});

clearBtn.addEventListener('click', () => {
  transcriptBuffer = [];
  currentInterim = { you: '', guest: '' };
  transcriptEl.innerHTML = '<p class="placeholder-text">Transcript will appear here when you start listening...</p>';
});

copyBtn.addEventListener('click', () => {
  const text = suggestionText.textContent;
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    });
  }
});

saveKeyBtn.addEventListener('click', () => {
  const key = deepgramKeyInput.value.trim();
  if (key) {
    chrome.storage.local.set({ deepgramKey: key });
    apiSetup.style.display = 'none';
  }
});

micAllowBtn.addEventListener('click', async () => {
  const key = deepgramKeyInput.value.trim();
  if (key) {
    micAllowBtn.disabled = true;
    await startMicCapture(key);
    micAllowBtn.disabled = false;
  }
});

historyToggle.addEventListener('click', () => {
  historyList.classList.toggle('hidden');
  historyToggle.textContent = historyList.classList.contains('hidden') ? '▼' : '▲';
});

meetingPrepToggle.addEventListener('click', () => {
  meetingPrepBody.classList.toggle('hidden');
  meetingPrepToggle.textContent = meetingPrepBody.classList.contains('hidden') ? '▼' : '▲';
});

generateBriefBtn.addEventListener('click', () => {
  const agenda = agendaText.value.trim();
  if (agenda) triggerBrief(agenda);
});

// ── Start / Stop ──────────────────────────────────────────────────────────────
async function startListening(deepgramKey) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus('error', 'No active tab found');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      tabId: tab.id
    });

    if (response?.error) {
      setStatus('error', response.error);
      return;
    }

    isRecording = true;
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    manualBtn.classList.remove('hidden');

    prepInputArea.classList.add('hidden');

    if (response.streamId) {
      startTabCapture(response.streamId, response.deepgramKey || deepgramKey);
    }

    startMicCapture(deepgramKey);

    recordingStart = Date.now();
    timerInterval = setInterval(updateTimer, 1000);

    if (agendaItems.length > 0) startNudgeRefresh();

  } catch (e) {
    setStatus('error', e.message);
  }
}

async function stopListening() {
  isRecording = false;

  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });

  stopBtn.classList.add('hidden');
  manualBtn.classList.add('hidden');
  startBtn.classList.remove('hidden');

  prepInputArea.classList.remove('hidden');

  clearInterval(timerInterval);
  timerEl.textContent = '';
  setStatus('idle', 'Stopped');

  stopTabCapture();
  stopMicCapture();

  if (nudgeInterval) {
    clearInterval(nudgeInterval);
    nudgeInterval = null;
  }
}

// ── Tab Capture (guest speaker) ───────────────────────────────────────────────
async function startTabCapture(streamId, deepgramKey) {
  try {
    tabMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (e) {
    console.error('[SP] Tab capture failed:', e.name, e.message);
    setStatus('error', `Tab capture failed: ${e.message}`);
    return;
  }

  tabAudioContext = new AudioContext();
  await tabAudioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));

  const source = tabAudioContext.createMediaStreamSource(tabMediaStream);
  tabWorkletNode = new AudioWorkletNode(tabAudioContext, 'pcm-processor');

  // Side panel is a visible page — destination routes to real speakers
  source.connect(tabAudioContext.destination);
  source.connect(tabWorkletNode);

  const silentDest = tabAudioContext.createMediaStreamDestination();
  tabWorkletNode.connect(silentDest);

  const url = `wss://api.deepgram.com/v1/listen`
    + `?model=nova-2&encoding=linear16`
    + `&sample_rate=${tabAudioContext.sampleRate}`
    + `&channels=1&smart_format=true&interim_results=true`;

  tabSocket = new WebSocket(url, ['token', deepgramKey]);

  tabWorkletNode.port.onmessage = (e) => {
    if (tabSocket && tabSocket.readyState === WebSocket.OPEN) tabSocket.send(e.data);
  };

  tabSocket.onopen = () => {
    console.log('[SP] Guest Deepgram connected');
    setStatus('recording', 'Listening...');
  };

  tabSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const alt = data?.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;
      handleTranscript(alt.transcript.trim(), data.is_final === true, 'guest');
    } catch (e) {
      console.error('[SP] Guest parse error:', e);
    }
  };

  tabSocket.onerror = (e) => console.error('[SP] Guest Deepgram error:', e);
  tabSocket.onclose = (e) => {
    if (e.code !== 1005) console.warn('[SP] Guest Deepgram closed:', e.code, e.reason);
  };
}

function stopTabCapture() {
  tabWorkletNode?.port.postMessage('stop');
  tabWorkletNode?.disconnect();
  tabWorkletNode = null;

  tabMediaStream?.getTracks().forEach(t => t.stop());
  tabMediaStream = null;

  if (tabSocket) { tabSocket.close(); tabSocket = null; }
  if (tabAudioContext) { tabAudioContext.close(); tabAudioContext = null; }
}

// ── Mic Capture ───────────────────────────────────────────────────────────────
async function startMicCapture(deepgramKey) {
  try {
    micMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micBanner.classList.add('hidden');
  } catch (e) {
    console.warn('[SP] Mic access denied:', e.name, e.message);
    micBanner.classList.remove('hidden');
    micBanner.querySelector('span').textContent = '🎤 Mic access needed for "You" transcription.';
    micAllowBtn.textContent = 'Allow Mic';
    micAllowBtn.disabled = false;
    setStatus('recording', 'Listening... (mic denied — guest only)');
    return;
  }

  micAudioContext = new AudioContext();
  await micAudioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));

  const source = micAudioContext.createMediaStreamSource(micMediaStream);
  micWorkletNode = new AudioWorkletNode(micAudioContext, 'pcm-processor');
  const silentDest = micAudioContext.createMediaStreamDestination();
  source.connect(micWorkletNode);
  micWorkletNode.connect(silentDest);

  micWorkletNode.port.onmessage = (e) => {
    if (micSocket?.readyState === WebSocket.OPEN) micSocket.send(e.data);
  };

  const url = `wss://api.deepgram.com/v1/listen`
    + `?model=nova-2&encoding=linear16`
    + `&sample_rate=${micAudioContext.sampleRate}`
    + `&channels=1&smart_format=true&interim_results=true`;

  micSocket = new WebSocket(url, ['token', deepgramKey]);

  micSocket.onopen = () => micBanner.classList.add('hidden');
  micSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const alt = data?.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;
      handleTranscript(alt.transcript.trim(), data.is_final === true, 'you');
    } catch (_) {}
  };
  micSocket.onerror = (e) => console.error('[SP] Mic WS error:', e);
  micSocket.onclose = (e) => { if (e.code !== 1005) console.warn('[SP] Mic WS closed:', e.code); };
}

function stopMicCapture() {
  micWorkletNode?.port.postMessage('stop');
  micWorkletNode?.disconnect();
  micWorkletNode = null;
  micMediaStream?.getTracks().forEach(t => t.stop());
  micMediaStream = null;
  if (micSocket) { micSocket.close(); micSocket = null; }
  if (micAudioContext) { micAudioContext.close(); micAudioContext = null; }
}

// ── Message Listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  // Ignore direct messages from offscreen.html — background relays them.
  // Without this filter, every message arrives twice.
  if (sender.url?.includes('offscreen.html')) return;

  switch (msg.type) {
    case 'TRANSCRIPT':
      handleTranscript(msg.text, msg.isFinal, msg.speaker || 'guest');
      break;
    case 'STATUS':
      handleStatus(msg.state, msg.message);
      break;
  }
});

// ── Transcript Rendering ──────────────────────────────────────────────────────
function handleTranscript(text, isFinal, speaker) {
  if (!text) return;

  const placeholder = transcriptEl.querySelector('.placeholder-text');
  if (placeholder) placeholder.remove();

  if (isFinal) {
    transcriptBuffer.push({ text, timestamp: Date.now(), speaker });
    currentInterim[speaker] = '';
    renderTranscript();

    // Auto-question detection: guest utterances only
    if (speaker === 'guest') scheduleQuestionCheck(text);

    // Agenda coverage check
    if (agendaItems.length > 0) checkAgendaCoverage(text);
  } else {
    currentInterim[speaker] = text;
    renderTranscript();
  }
}

function renderTranscript() {
  let html = '';

  for (const entry of transcriptBuffer) {
    const isYou = entry.speaker === 'you';
    html += `<div class="transcript-entry ${isYou ? 'transcript-you' : 'transcript-guest'}">
      <span class="transcript-speaker">${isYou ? 'You' : 'Guest'}</span>
      <span class="transcript-text">${escapeHtml(entry.text)}</span>
    </div>`;
  }

  // Show current interim per speaker
  if (currentInterim.guest) {
    html += `<div class="transcript-entry transcript-guest">
      <span class="transcript-speaker">Guest</span>
      <span class="transcript-text transcript-interim">${escapeHtml(currentInterim.guest)}</span>
    </div>`;
  }
  if (currentInterim.you) {
    html += `<div class="transcript-entry transcript-you">
      <span class="transcript-speaker">You</span>
      <span class="transcript-text transcript-interim">${escapeHtml(currentInterim.you)}</span>
    </div>`;
  }

  transcriptEl.innerHTML = html;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ── Question Detection ────────────────────────────────────────────────────────
function scheduleQuestionCheck(text) {
  if (queryDebounceTimer) clearTimeout(queryDebounceTimer);

  queryDebounceTimer = setTimeout(() => {
    if (isQuestion(text)) {
      const now = Date.now();
      if (now - lastQueryTime > DEBOUNCE_MS) {
        lastQueryTime = now;
        triggerQuery(text, getRecentTranscript());
      }
    }
  }, 1000);
}

function isQuestion(text) {
  const trimmed = text.trim();
  return trimmed.endsWith('?') || INTERROGATIVE_STARTERS.test(trimmed);
}

function getRecentTranscript(seconds = 60) {
  const cutoff = Date.now() - seconds * 1000;
  const recent = transcriptBuffer
    .filter(s => s.timestamp > cutoff)
    .map(s => `${s.speaker === 'you' ? 'You' : 'Guest'}: ${s.text}`)
    .join('\n');
  return recent || transcriptBuffer.slice(-10).map(s => `${s.speaker === 'you' ? 'You' : 'Guest'}: ${s.text}`).join('\n');
}

// ── Backend Query ─────────────────────────────────────────────────────────────
async function triggerQuery(question, transcript) {
  showSuggestionSection(true);
  suggestionText.textContent = '';
  sourceLabel.textContent = '';
  spinner.classList.remove('hidden');
  copyBtn.disabled = true;

  let fullText = '';

  try {
    const response = await fetch(`${BACKEND_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, query: question })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const payload = JSON.parse(line.slice(6));

          if (payload.text) {
            fullText += payload.text;
            suggestionText.textContent = fullText;
          }

          if (payload.done) {
            spinner.classList.add('hidden');
            copyBtn.disabled = false;
            if (payload.sources?.length) {
              if (payload.fallback) {
                sourceLabel.textContent = '🌐 General Knowledge (not in KB)';
                sourceLabel.className = 'source-label source-fallback';
              } else {
                sourceLabel.textContent = `Sources: ${payload.sources.join(', ')}`;
                sourceLabel.className = 'source-label';
              }
            }
            addToHistory(fullText, payload.sources || [], payload.fallback);
          }

          if (payload.error) {
            suggestionText.textContent = `Error: ${payload.error}`;
            spinner.classList.add('hidden');
          }
        } catch (e) {
          // Skip malformed SSE line
        }
      }
    }

  } catch (e) {
    spinner.classList.add('hidden');
    suggestionText.textContent = `Could not reach backend: ${e.message}`;
    console.error('[SP] Query error:', e);
  }
}

// ── Suggestion Display ────────────────────────────────────────────────────────
function showSuggestionSection(visible) {
  suggestionSection.style.display = visible ? 'flex' : 'none';
}

function addToHistory(text, sources, fallback = false) {
  if (!text.trim()) return;

  suggestionHistory.unshift({ text, sources, fallback });
  historySection.style.display = 'flex';

  const sourceHtml = sources.length
    ? `<div class="history-source ${fallback ? 'source-fallback' : ''}">
        ${fallback ? '🌐 General Knowledge' : `Sources: ${sources.join(', ')}`}
       </div>`
    : '';

  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `<div>${escapeHtml(text)}</div>${sourceHtml}`;
  historyList.prepend(item);

  while (historyList.children.length > 10) {
    historyList.removeChild(historyList.lastChild);
  }
}

// ── Meeting Prep: Brief Generation ───────────────────────────────────────────
async function triggerBrief(agenda) {
  generateBriefBtn.textContent = '⏳ Generating...';
  generateBriefBtn.disabled = true;
  briefingCard.classList.add('hidden');
  agendaChecklist.classList.add('hidden');

  try {
    const res = await fetch(`${BACKEND_URL}/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agenda })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Render briefing card
    let briefHtml = '';
    if (data.key_facts?.length) {
      briefHtml += `<div class="brief-section-title">Key Facts</div><ul class="brief-list">`;
      briefHtml += data.key_facts.map(f => `<li>${escapeHtml(f)}</li>`).join('');
      briefHtml += `</ul>`;
    }
    if (data.likely_questions?.length) {
      briefHtml += `<div class="brief-section-title">Likely Questions</div>`;
      briefHtml += data.likely_questions.map(qa =>
        `<div class="brief-qa">
          <div class="brief-q">Q: ${escapeHtml(qa.q)}</div>
          <div class="brief-a">A: ${escapeHtml(qa.a)}</div>
        </div>`
      ).join('');
    }
    briefingContent.innerHTML = briefHtml;
    briefingCard.classList.remove('hidden');

    // Build agenda items state
    agendaItems = (data.agenda_items || []).map(ai => ({
      item: typeof ai === 'string' ? ai : ai.item,
      keywords: (typeof ai === 'string' ? [] : (ai.keywords || [])).map(k => k.toLowerCase()),
      covered: false,
      coveredAt: null
    }));

    renderAgendaChecklist();
    agendaChecklist.classList.remove('hidden');

    // Show nudges section and kick off first refresh if meeting is live
    nudgesSection.classList.remove('hidden');
    if (isRecording) startNudgeRefresh();

  } catch (e) {
    briefingContent.innerHTML = `<div class="brief-error">Failed to generate brief: ${escapeHtml(e.message)}</div>`;
    briefingCard.classList.remove('hidden');
    console.error('[SP] Brief error:', e);
  } finally {
    generateBriefBtn.textContent = 'Generate Brief';
    generateBriefBtn.disabled = false;
  }
}

// ── Agenda Checklist ──────────────────────────────────────────────────────────
function renderAgendaChecklist() {
  if (!agendaItems.length) return;

  let html = '<div class="checklist-title">Agenda</div>';
  agendaItems.forEach((ag, i) => {
    const timeStr = ag.coveredAt ? ` <span class="covered-time">${ag.coveredAt}</span>` : '';
    html += `<label class="checklist-row ${ag.covered ? 'covered' : ''}">
      <input type="checkbox" ${ag.covered ? 'checked' : ''} data-idx="${i}" class="agenda-checkbox" />
      <span class="checklist-text">${escapeHtml(ag.item)}</span>${timeStr}
    </label>`;
  });
  agendaChecklist.innerHTML = html;

  // Allow manual toggle
  agendaChecklist.querySelectorAll('.agenda-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      agendaItems[idx].covered = e.target.checked;
      agendaItems[idx].coveredAt = e.target.checked ? getCurrentTime() : null;
      renderAgendaChecklist();
      if (isRecording) refreshNudges();
    });
  });
}

function checkAgendaCoverage(transcriptText) {
  const lower = transcriptText.toLowerCase();
  let changed = false;

  agendaItems.forEach(ag => {
    if (ag.covered || !ag.keywords.length) return;
    const matchCount = ag.keywords.filter(kw => lower.includes(kw)).length;
    if (matchCount >= 2) {
      ag.covered = true;
      ag.coveredAt = getCurrentTime();
      changed = true;
    }
  });

  if (changed) {
    renderAgendaChecklist();
    if (isRecording) refreshNudges();
  }
}

// ── Nudges ────────────────────────────────────────────────────────────────────
function startNudgeRefresh() {
  if (nudgeInterval) clearInterval(nudgeInterval);
  refreshNudges();
  nudgeInterval = setInterval(refreshNudges, NUDGE_INTERVAL_MS);
}

async function refreshNudges() {
  if (!isRecording) return;
  nudgeSpinner.classList.remove('hidden');

  try {
    const res = await fetch(`${BACKEND_URL}/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: getRecentTranscript(120),
        agenda_items: agendaItems.map(a => ({
          item: a.item,
          keywords: a.keywords,
          covered: a.covered
        })),
        current_nudges: dismissedNudges
      })
    });

    if (!res.ok) return;
    const data = await res.json();
    renderNudges((data.nudges || []).slice(0, 3));
  } catch (e) {
    console.warn('[SP] Nudge refresh failed:', e);
  } finally {
    nudgeSpinner.classList.add('hidden');
  }
}

function renderNudges(nudges) {
  if (!nudges.length) return;

  nudgesSection.classList.remove('hidden');
  const typeIcon = { agenda_gap: '🎯', talking_point: '💡', steer: '🔄' };

  nudgesList.innerHTML = nudges.map((n, i) => `
    <div class="nudge-card" data-idx="${i}">
      <span class="nudge-icon">${typeIcon[n.type] || '💡'}</span>
      <span class="nudge-text">${escapeHtml(n.text)}</span>
      <button class="nudge-dismiss" data-idx="${i}" title="Dismiss">×</button>
    </div>
  `).join('');

  nudgesList.querySelectorAll('.nudge-dismiss').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const card = nudgesList.querySelector(`.nudge-card[data-idx="${idx}"]`);
      if (card) {
        dismissedNudges.push(nudges[idx].text);
        card.remove();
      }
    });
  });
}

// ── Status ────────────────────────────────────────────────────────────────────
function handleStatus(state, message) {
  setStatus(state, message);
}

function setStatus(state, message) {
  statusLabel.textContent = message || state;
  statusDot.className = 'status-dot';

  switch (state) {
    case 'recording': statusDot.classList.add('recording'); break;
    case 'connected': statusDot.classList.add('connected'); break;
    case 'error':     statusDot.classList.add('error'); break;
    default:          break;
  }
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function updateTimer() {
  if (!recordingStart) return;
  const elapsed = Math.floor((Date.now() - recordingStart) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
}

function getCurrentTime() {
  if (!recordingStart) return '';
  const elapsed = Math.floor((Date.now() - recordingStart) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
