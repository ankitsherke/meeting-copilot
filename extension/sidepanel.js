/**
 * sidepanel.js — Side Panel UI Logic
 * v2: Theme engine, priority nudge queue, 8 nudge types, enhanced checklist,
 *     objection/silence/closing detectors, post-meeting report.
 */

const BACKEND_URL = 'https://meeting-copilot-iota.vercel.app';
const INTERROGATIVE_STARTERS = /^(what|how|when|where|why|who|which|can|could|do|does|did|is|are|was|were|will|would|should|shall)\b/i;
const DEBOUNCE_MS = 3000;
const NUDGE_FLUSH_INTERVAL_MS = 15000; // check queue every 15s
const NUDGE_BACKEND_INTERVAL_MS = 60000; // backend nudge call every 60s

// ── State ─────────────────────────────────────────────────────────────────────
let isRecording = false;
let transcriptBuffer = []; // { text, timestamp, speaker }
let currentInterim = { you: '', guest: '' };
let queryDebounceTimer = null;
let lastQueryTime = 0;
let timerInterval = null;
let recordingStart = null;
let suggestionHistory = [];

// Theme & checklist state
let activeTheme = null;
let checklistItems = []; // { id, label, description, autoDetectPatterns, priority, nudgeIfMissedAfter, covered, coveredAt }

// Nudge engine
const nudgeQueue = new NudgeQueue();
let nudgeFlushInterval = null;
let nudgeBackendInterval = null;
let nudgesUsedCount = 0;
let nudgesDismissedCount = 0;
let pinnedNudges = [];
let closingCueFired = false;

// Silence detection
let silenceTimer = null;
let lastSpeechTime = 0;
let lastUserSpeechTime = 0;

// Post-meeting
let meetingEndTime = null;

// Guest context
let activeGuest = null;  // loaded guest object from GuestContext

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

// ── Nudge type metadata ───────────────────────────────────────────────────────
const NUDGE_META = {
  kb_answer:          { icon: '📚', label: 'KB Answer',     badge: 'nudge-badge-kb_answer' },
  checklist_reminder: { icon: '☑️', label: 'Checklist',     badge: 'nudge-badge-checklist_reminder' },
  objection_handler:  { icon: '🛡️', label: 'Objection',    badge: 'nudge-badge-objection_handler' },
  silence_prompt:     { icon: '🤫', label: 'Silence',       badge: 'nudge-badge-silence_prompt' },
  goal_drift_alert:   { icon: '🎯', label: 'Drift Alert',   badge: 'nudge-badge-goal_drift_alert' },
  closing_cue:        { icon: '⏱️', label: 'Closing',      badge: 'nudge-badge-closing_cue' },
  context_recall:     { icon: '🔄', label: 'Context',       badge: 'nudge-badge-context_recall' },
  sentiment_shift:    { icon: '💭', label: 'Sentiment',     badge: 'nudge-badge-sentiment_shift' },
};

// ── DOM Refs ──────────────────────────────────────────────────────────────────
const startBtn         = document.getElementById('startBtn');
const stopBtn          = document.getElementById('stopBtn');
const manualBtn        = document.getElementById('manualBtn');
const clearBtn         = document.getElementById('clearBtn');
const copyBtn          = document.getElementById('copyBtn');
const saveKeyBtn       = document.getElementById('saveKeyBtn');
const historyToggle    = document.getElementById('historyToggle');

const transcriptEl     = document.getElementById('transcript');
const suggestionSection = document.getElementById('suggestionSection');
const suggestionText   = document.getElementById('suggestionText');
const sourceLabel      = document.getElementById('sourceLabel');
const spinner          = document.getElementById('spinner');
const historySection   = document.getElementById('historySection');
const historyList      = document.getElementById('historyList');
const apiSetup         = document.getElementById('apiSetup');
const deepgramKeyInput = document.getElementById('deepgramKeyInput');
const statusDot        = document.getElementById('statusDot');
const statusLabel      = document.getElementById('statusLabel');
const timerEl          = document.getElementById('timer');

// Meeting prep refs
const meetingPrepToggle  = document.getElementById('meetingPrepToggle');
const meetingPrepBody    = document.getElementById('meetingPrepBody');
const agendaText         = document.getElementById('agendaText');
const generateBriefBtn   = document.getElementById('generateBriefBtn');
const prepInputArea      = document.getElementById('prepInputArea');
const briefingCard       = document.getElementById('briefingCard');
const briefingContent    = document.getElementById('briefingContent');
const agendaChecklist    = document.getElementById('agendaChecklist');
const meetingPrepSection = document.getElementById('meetingPrepSection');

const micBanner   = document.getElementById('micBanner');
const micAllowBtn = document.getElementById('micAllowBtn');

// Nudge refs
const nudgesSection = document.getElementById('nudgesSection');
const nudgesList    = document.getElementById('nudgesList');
const nudgeSpinner  = document.getElementById('nudgeSpinner');

// Theme selector refs
const themeSelector = document.getElementById('themeSelector');
const themePills    = document.getElementById('themePills');

// Post-meeting refs
const postMeetingPanel  = document.getElementById('postMeetingPanel');
const statDuration      = document.getElementById('statDuration');
const statChecklist     = document.getElementById('statChecklist');
const statNudgesUsed    = document.getElementById('statNudgesUsed');
const generateReportBtn = document.getElementById('generateReportBtn');
const reportOutput      = document.getElementById('reportOutput');
const reportContent     = document.getElementById('reportContent');
const copyReportBtn     = document.getElementById('copyReportBtn');

// Settings refs
const settingsToggle    = document.getElementById('settingsToggle');
const settingsPanel     = document.getElementById('settingsPanel');
const notionKeyInput    = document.getElementById('notionKeyInput');
const saveNotionKeyBtn  = document.getElementById('saveNotionKeyBtn');
const notionDbInput     = document.getElementById('notionDbInput');
const saveNotionDbBtn   = document.getElementById('saveNotionDbBtn');
const notionTestBtn     = document.getElementById('notionTestBtn');
const notionCreateDbBtn = document.getElementById('notionCreateDbBtn');
const notionStatus      = document.getElementById('notionStatus');
const notionPushBtn     = document.getElementById('notionPushBtn');
const notionPushStatus  = document.getElementById('notionPushStatus');

// Guest context refs
const guestNameInput    = document.getElementById('guestNameInput');
const guestSuggestions  = document.getElementById('guestSuggestions');
const guestContextCard  = document.getElementById('guestContextCard');
const guestContextName  = document.getElementById('guestContextName');
const guestContextMeta  = document.getElementById('guestContextMeta');
const guestContextClear = document.getElementById('guestContextClear');
const guestContextBody  = document.getElementById('guestContextBody');
const guestSaveRow      = document.getElementById('guestSaveRow');
const guestSaveInput    = document.getElementById('guestSaveInput');
const saveGuestBtn      = document.getElementById('saveGuestBtn');
const guestSaveConfirm  = document.getElementById('guestSaveConfirm');

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['deepgramKey', 'activeThemeId', 'notionKey', 'notionDatabaseId'], (result) => {
  if (result.deepgramKey) {
    apiSetup.classList.add('hidden');
  }
  deepgramKeyInput.value    = result.deepgramKey || '';
  notionKeyInput.value      = result.notionKey ? '••••••••' : '';
  notionDbInput.value       = result.notionDatabaseId || '';

  const themeId = result.activeThemeId || 'counselling';
  loadTheme(themeId);
  renderThemeSelector();

  // Flush any pending Notion retry queue
  if (result.notionKey && result.notionDatabaseId) {
    NotionSync.flushRetryQueue(result.notionKey, result.notionDatabaseId).then(({ succeeded }) => {
      if (succeeded > 0) console.log(`[Notion] Flushed ${succeeded} queued report(s)`);
    });
  }
});

// ── Settings Panel ─────────────────────────────────────────────────────────────

settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

saveKeyBtn.addEventListener('click', () => {
  const key = deepgramKeyInput.value.trim();
  if (!key) return;
  chrome.storage.local.set({ deepgramKey: key }, () => {
    apiSetup.classList.add('hidden');
    settingsPanel.classList.add('hidden');
  });
});

saveNotionKeyBtn.addEventListener('click', () => {
  const key = notionKeyInput.value.trim();
  if (!key || key === '••••••••') return;
  chrome.storage.local.set({ notionKey: key }, () => {
    notionKeyInput.value = '••••••••';
    _showNotionStatus('Notion key saved.', 'success');
  });
});

saveNotionDbBtn.addEventListener('click', () => {
  const dbId = notionDbInput.value.trim();
  chrome.storage.local.set({ notionDatabaseId: dbId }, () => {
    _showNotionStatus('Database ID saved.', 'success');
  });
});

notionTestBtn.addEventListener('click', async () => {
  notionTestBtn.disabled = true;
  notionTestBtn.textContent = 'Testing...';
  try {
    const key = await _getNotionKey();
    if (!key) { _showNotionStatus('Enter and save your Notion key first.', 'error'); return; }
    const name = await NotionSync.testConnection(key);
    _showNotionStatus(`Connected as: ${name}`, 'success');
  } catch (e) {
    _showNotionStatus(`Connection failed: ${e.message}`, 'error');
  } finally {
    notionTestBtn.disabled = false;
    notionTestBtn.textContent = 'Test connection';
  }
});

notionCreateDbBtn.addEventListener('click', async () => {
  const parentPageId = prompt('Paste the ID of an existing Notion page to create the database inside:');
  if (!parentPageId) return;
  notionCreateDbBtn.disabled = true;
  notionCreateDbBtn.textContent = 'Creating...';
  try {
    const key = await _getNotionKey();
    if (!key) { _showNotionStatus('Enter and save your Notion key first.', 'error'); return; }
    const dbId = await NotionSync.createDatabase(key, parentPageId.trim());
    notionDbInput.value = dbId;
    chrome.storage.local.set({ notionDatabaseId: dbId });
    _showNotionStatus('Database created! ID saved.', 'success');
  } catch (e) {
    _showNotionStatus(`Failed: ${e.message}`, 'error');
  } finally {
    notionCreateDbBtn.disabled = false;
    notionCreateDbBtn.textContent = 'Auto-create DB';
  }
});

function _showNotionStatus(msg, type) {
  notionStatus.textContent = msg;
  notionStatus.className = `settings-notion-status ${type}`;
  notionStatus.classList.remove('hidden');
  setTimeout(() => notionStatus.classList.add('hidden'), 4000);
}

async function _getNotionKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('notionKey', d => resolve(d.notionKey || null));
  });
}

async function _getNotionDb() {
  return new Promise(resolve => {
    chrome.storage.local.get('notionDatabaseId', d => resolve(d.notionDatabaseId || null));
  });
}

// ── Notion Push (post-meeting) ─────────────────────────────────────────────────

notionPushBtn.addEventListener('click', async () => {
  notionPushBtn.disabled = true;
  notionPushBtn.textContent = 'Pushing...';
  notionPushStatus.classList.add('hidden');

  try {
    const key    = await _getNotionKey();
    const dbId   = await _getNotionDb();
    if (!key || !dbId) {
      _showNotionPushStatus('Configure Notion in Settings (⚙) first.', 'error');
      return;
    }

    const covered  = checklistItems.filter(i => i.covered).length;
    const reportData = {
      apiKey:        key,
      databaseId:    dbId,
      guestName:     activeGuest?.name || guestSaveInput.value.trim() || '',
      themeName:     activeTheme?.name || 'General',
      themeId:       activeTheme?.id || '',
      date:          new Date().toISOString().slice(0, 10),
      duration:      getMeetingDuration(),
      goalAchieved:  document.getElementById('goalAchievedCheck')?.checked || false,
      checklistScore:`${covered}/${checklistItems.length}`,
      reportMarkdown: reportContent.textContent,
    };

    await NotionSync.pushReport(reportData);
    _showNotionPushStatus('✓ Saved to Notion', 'success');
    notionPushBtn.textContent = 'Pushed ✓';
  } catch (e) {
    // Enqueue for retry
    try {
      const key  = await _getNotionKey();
      const dbId = await _getNotionDb();
      if (key && dbId) {
        const covered = checklistItems.filter(i => i.covered).length;
        await NotionSync.enqueueRetry({
          apiKey: key, databaseId: dbId,
          guestName: activeGuest?.name || '',
          themeName: activeTheme?.name || 'General',
          themeId: activeTheme?.id || '',
          date: new Date().toISOString().slice(0, 10),
          duration: getMeetingDuration(),
          goalAchieved: document.getElementById('goalAchievedCheck')?.checked || false,
          checklistScore: `${covered}/${checklistItems.length}`,
          reportMarkdown: reportContent.textContent,
        });
        _showNotionPushStatus('Push failed — queued for retry.', 'error');
      }
    } catch (_) {}
    notionPushBtn.disabled = false;
    notionPushBtn.textContent = 'Push to Notion';
    console.error('[Notion] Push failed:', e);
  }
});

function _showNotionPushStatus(msg, type) {
  notionPushStatus.textContent = msg;
  notionPushStatus.className = `notion-push-status ${type}`;
  notionPushStatus.classList.remove('hidden');
}

// ── Guest Context Engine ───────────────────────────────────────────────────────

let guestSearchDebounce = null;

guestNameInput.addEventListener('input', () => {
  clearTimeout(guestSearchDebounce);
  const q = guestNameInput.value.trim();
  if (q.length < 2) {
    guestSuggestions.classList.add('hidden');
    guestSuggestions.innerHTML = '';
    return;
  }
  guestSearchDebounce = setTimeout(async () => {
    const matches = await GuestContext.search(q);
    if (!matches.length) {
      guestSuggestions.classList.add('hidden');
      return;
    }
    guestSuggestions.innerHTML = matches.map(g => {
      const lastMeeting = g.meetings[g.meetings.length - 1];
      const meta = [g.company, g.role].filter(Boolean).join(' · ') || (lastMeeting ? lastMeeting.date : 'No meetings yet');
      return `<div class="guest-suggestion-item" data-id="${g.id}">
        <span class="guest-suggestion-name">${escapeHtml(g.name)}</span>
        <span class="guest-suggestion-meta">${escapeHtml(meta)} · ${g.meetings.length} meeting${g.meetings.length !== 1 ? 's' : ''}</span>
      </div>`;
    }).join('');
    guestSuggestions.classList.remove('hidden');

    guestSuggestions.querySelectorAll('.guest-suggestion-item').forEach(item => {
      item.addEventListener('click', async () => {
        const guest = await GuestContext.getGuest(item.dataset.id);
        if (guest) selectGuest(guest);
        guestSuggestions.classList.add('hidden');
      });
    });
  }, 300);
});

// Hide suggestions when clicking outside
document.addEventListener('click', (e) => {
  if (!guestNameInput.contains(e.target) && !guestSuggestions.contains(e.target)) {
    guestSuggestions.classList.add('hidden');
  }
});

guestContextClear.addEventListener('click', () => {
  activeGuest = null;
  guestNameInput.value = '';
  guestContextCard.classList.add('hidden');
  guestContextBody.innerHTML = '';
});

function selectGuest(guest) {
  activeGuest = guest;
  guestNameInput.value = guest.name;
  guestContextName.textContent = guest.name;

  const metaParts = [guest.company, guest.role].filter(Boolean);
  guestContextMeta.textContent = metaParts.length ? metaParts.join(' · ') : `${guest.meetings.length} past meeting${guest.meetings.length !== 1 ? 's' : ''}`;

  renderGuestHistory(guest);
  guestContextCard.classList.remove('hidden');

  // Pre-fill guest save input in post-meeting panel
  guestSaveInput.value = guest.name;
}

function renderGuestHistory(guest) {
  if (!guest.meetings.length) {
    guestContextBody.innerHTML = '<p style="font-size:12px;color:#6b7280;margin:0">No past meetings recorded.</p>';
    return;
  }

  // Show last 3 meetings, most recent first
  const recent = [...guest.meetings].reverse().slice(0, 3);
  guestContextBody.innerHTML = recent.map(m => {
    const goalBadge = m.goalAchieved
      ? '<span class="guest-past-badge">Goal ✓</span>'
      : '<span class="guest-past-badge missed">Goal ✗</span>';
    const actionsHtml = m.actionItems && m.actionItems.length
      ? `<div class="guest-past-actions">Open actions: ${escapeHtml(m.actionItems.slice(0, 2).join('; '))}</div>`
      : '';
    return `<div class="guest-past-meeting">
      <div class="guest-past-meeting-header">
        <span class="guest-past-date">${m.date} · ${m.theme || 'General'} · ${m.duration || '—'}</span>
        ${goalBadge}
      </div>
      ${m.summary ? `<div class="guest-past-summary">${escapeHtml(m.summary)}</div>` : ''}
      ${actionsHtml}
    </div>`;
  }).join('');
}

// Save guest after meeting
saveGuestBtn.addEventListener('click', async () => {
  const name = guestSaveInput.value.trim();
  if (!name) return;

  const duration = getMeetingDuration();
  const covered  = checklistItems.filter(i => i.covered).length;
  const goalAchieved = document.getElementById('goalAchievedCheck')?.checked || false;
  const summary = reportContent.textContent.slice(0, 400) || agendaText.value.slice(0, 400);

  // Extract action items from report text (lines starting with bullet patterns)
  const actionItems = (reportContent.textContent.match(/^\*\*\[.*?\]\*\*.*$/gm) || []).slice(0, 5);

  const guest = await GuestContext.getOrCreate(name);
  await GuestContext.addMeeting(guest.id, {
    theme: activeTheme?.id || '',
    duration,
    goalAchieved,
    summary,
    actionItems,
    checklistScore: `${covered}/${checklistItems.length}`,
  });

  guestSaveInput.disabled = true;
  saveGuestBtn.disabled = true;
  guestSaveConfirm.classList.remove('hidden');
  activeGuest = await GuestContext.getGuest(guest.id);
});

// ── Theme Engine ──────────────────────────────────────────────────────────────
function loadTheme(themeId) {
  activeTheme = getThemeById(themeId);
  initChecklistFromTheme();
  renderAgendaChecklist();
}

function renderThemeSelector() {
  themePills.innerHTML = BUILT_IN_THEMES.map(t => `
    <button class="theme-pill ${t.id === activeTheme?.id ? 'active' : ''}" data-theme="${t.id}">
      <span class="theme-pill-icon">${t.icon}</span>
      <span>${t.name}</span>
    </button>
  `).join('');

  themePills.querySelectorAll('.theme-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const themeId = btn.dataset.theme;
      chrome.storage.local.set({ activeThemeId: themeId });
      loadTheme(themeId);
      renderThemeSelector();
    });
  });
}

function initChecklistFromTheme() {
  if (!activeTheme) return;
  checklistItems = activeTheme.checklist.map(item => ({
    ...item,
    covered: false,
    coveredAt: null
  }));
}

// ── Button Handlers ───────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const key = deepgramKeyInput.value.trim();
  if (!key) {
    settingsPanel.classList.remove('hidden');
    deepgramKeyInput.focus();
    return;
  }
  chrome.storage.local.set({ deepgramKey: key });
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

// (saveKeyBtn handler is in the Settings Panel section above)

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
  meetingPrepToggle.textContent = meetingPrepBody.classList.contains('hidden') ? 'Brief ▾' : 'Brief ▴';
});

generateBriefBtn.addEventListener('click', () => {
  const agenda = agendaText.value.trim();
  if (agenda) triggerBrief(agenda);
});

copyReportBtn.addEventListener('click', () => {
  const text = reportContent.textContent;
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      copyReportBtn.textContent = 'Copied!';
      setTimeout(() => (copyReportBtn.textContent = 'Copy Report'), 1500);
    });
  }
});

generateReportBtn.addEventListener('click', () => {
  triggerReport();
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
    closingCueFired = false;
    nudgesUsedCount = 0;
    nudgesDismissedCount = 0;
    nudgeQueue.reset();

    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    manualBtn.classList.remove('hidden');

    prepInputArea.classList.add('hidden');
    meetingPrepSection.classList.add('hidden');
    themeSelector.classList.add('hidden');
    postMeetingPanel.classList.add('hidden');

    nudgesSection.classList.remove('hidden');
    if (checklistItems.length > 0) agendaChecklist.classList.remove('hidden');

    if (response.streamId) {
      startTabCapture(response.streamId, response.deepgramKey || deepgramKey);
    }

    startMicCapture(deepgramKey);

    recordingStart = Date.now();
    lastSpeechTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);

    // Start nudge flush loop (checks queue every 15s)
    nudgeFlushInterval = setInterval(flushNudgeQueue, NUDGE_FLUSH_INTERVAL_MS);

    // Start backend nudge refresh loop
    if (checklistItems.length > 0 || activeTheme) {
      nudgeBackendInterval = setInterval(refreshNudges, NUDGE_BACKEND_INTERVAL_MS);
      // First backend nudge call after 30s
      setTimeout(refreshNudges, 30000);
    }

    // Start silence detector
    startSilenceDetector();

    // Start periodic local checks (checklist reminders, closing cue)
    nudgeBackendInterval && clearInterval(nudgeBackendInterval);
    nudgeBackendInterval = setInterval(() => {
      refreshNudges();
      checkChecklistReminders();
      checkClosingCue();
    }, NUDGE_BACKEND_INTERVAL_MS);

  } catch (e) {
    setStatus('error', e.message);
  }
}

async function stopListening() {
  isRecording = false;
  meetingEndTime = Date.now();

  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });

  stopBtn.classList.add('hidden');
  manualBtn.classList.add('hidden');
  startBtn.classList.remove('hidden');

  prepInputArea.classList.remove('hidden');
  meetingPrepSection.classList.remove('hidden');
  themeSelector.classList.remove('hidden');

  nudgesSection.classList.add('hidden');
  nudgesList.innerHTML = '<p class="nudge-empty">Listening for conversation context...</p>';

  clearInterval(timerInterval);
  clearInterval(nudgeFlushInterval);
  clearInterval(nudgeBackendInterval);
  nudgeFlushInterval = null;
  nudgeBackendInterval = null;

  stopSilenceDetector();

  timerEl.textContent = '';
  setStatus('idle', 'Stopped');

  stopTabCapture();
  stopMicCapture();

  // Show post-meeting panel
  showPostMeetingPanel();
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

  tabSocket.onopen  = () => setStatus('recording', 'Listening...');
  tabSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const alt = data?.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;
      handleTranscript(alt.transcript.trim(), data.is_final === true, 'guest');
    } catch (_) {}
  };
  tabSocket.onerror = (e) => console.error('[SP] Tab WS error:', e);
  tabSocket.onclose = (e) => { if (e.code !== 1005) console.warn('[SP] Tab WS closed:', e.code); };
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

// ── Mic Capture (you) ─────────────────────────────────────────────────────────
async function startMicCapture(deepgramKey) {
  try {
    micMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micBanner.classList.add('hidden');
  } catch (e) {
    console.warn('[SP] Mic access denied:', e.name);
    if (tabSocket) {
      setStatus('recording', 'Listening... (mic denied — guest only)');
    } else {
      micBanner.classList.remove('hidden');
    }
    return;
  }

  micAudioContext = new AudioContext();
  await micAudioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));

  const source = micAudioContext.createMediaStreamSource(micMediaStream);
  micWorkletNode = new AudioWorkletNode(micAudioContext, 'pcm-processor');

  const silentDest = micAudioContext.createMediaStreamDestination();
  source.connect(micWorkletNode);
  micWorkletNode.connect(silentDest);

  const url = `wss://api.deepgram.com/v1/listen`
    + `?model=nova-2&encoding=linear16`
    + `&sample_rate=${micAudioContext.sampleRate}`
    + `&channels=1&smart_format=true&interim_results=true`;

  micSocket = new WebSocket(url, ['token', deepgramKey]);

  micWorkletNode.port.onmessage = (e) => {
    if (micSocket && micSocket.readyState === WebSocket.OPEN) micSocket.send(e.data);
  };

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

    // Update speech timestamps for silence detector
    lastSpeechTime = Date.now();
    if (speaker === 'you') lastUserSpeechTime = Date.now();

    // Auto-question detection: guest utterances only
    if (speaker === 'guest') {
      scheduleQuestionCheck(text);
      checkObjectionPatterns(text);
    }

    // Checklist coverage check
    if (checklistItems.length > 0) checkChecklistCoverage(text);
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

// ── Objection Pattern Detection ───────────────────────────────────────────────
function checkObjectionPatterns(text) {
  if (!activeTheme?.nudgeRules?.customTriggers) return;
  if (!nudgeQueue.isTypeEnabled('objection_handler')) return;

  const lower = text.toLowerCase();
  for (const trigger of activeTheme.nudgeRules.customTriggers) {
    try {
      const regex = new RegExp(trigger.pattern, 'i');
      if (regex.test(lower)) {
        nudgeQueue.add({
          type: trigger.nudgeType || 'objection_handler',
          text: trigger.response
        });
        return; // Only trigger one objection nudge per utterance
      }
    } catch (_) {}
  }
}

// ── Silence Detection ─────────────────────────────────────────────────────────
function startSilenceDetector() {
  const thresholdSec = activeTheme?.nudgeRules?.silenceThresholdSec || 8;
  silenceTimer = setInterval(() => {
    if (!isRecording) return;
    const silenceDuration = (Date.now() - lastSpeechTime) / 1000;
    const userSpokeLast = (Date.now() - lastUserSpeechTime) < 30000; // user spoke in last 30s

    if (silenceDuration > thresholdSec && userSpokeLast) {
      nudgeQueue.add({
        type: 'silence_prompt',
        text: "Silence detected. Consider asking: \"Does that make sense?\" or \"Any questions on that?\" to keep the conversation going."
      });
    }
  }, 5000); // check every 5s
}

function stopSilenceDetector() {
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
}

// ── Checklist Coverage (from transcript) ─────────────────────────────────────
function checkChecklistCoverage(transcriptText) {
  const lower = transcriptText.toLowerCase();
  let changed = false;

  checklistItems.forEach(item => {
    if (item.covered || !item.autoDetectPatterns.length) return;
    const matchCount = item.autoDetectPatterns.filter(kw => lower.includes(kw.toLowerCase())).length;
    if (matchCount >= 2) {
      item.covered = true;
      item.coveredAt = getCurrentTime();
      changed = true;
    }
  });

  if (changed) renderAgendaChecklist();
}

// ── Checklist Reminders (time-based) ─────────────────────────────────────────
function checkChecklistReminders() {
  if (!isRecording || !recordingStart || !activeTheme) return;
  if (!nudgeQueue.isTypeEnabled('checklist_reminder')) return;

  const elapsedPct = (Date.now() - recordingStart) / (60 * 60 * 1000); // Estimate 60min meeting
  const elapsedMin = (Date.now() - recordingStart) / 60000;

  // Find the highest-priority uncovered item past its threshold
  const overdue = checklistItems
    .filter(item => !item.covered && elapsedPct > item.nudgeIfMissedAfter)
    .sort((a, b) => {
      const pOrd = { critical: 0, high: 1, medium: 2 };
      return (pOrd[a.priority] ?? 3) - (pOrd[b.priority] ?? 3);
    });

  if (overdue.length > 0) {
    const item = overdue[0];
    const remaining = Math.max(0, Math.round(60 - elapsedMin));
    nudgeQueue.add({
      type: 'checklist_reminder',
      text: `You haven't covered "${item.label}" yet — ~${remaining} min left. ${item.description}.`
    });
  }
}

// ── Closing Cue (time-based) ──────────────────────────────────────────────────
function checkClosingCue() {
  if (!isRecording || !recordingStart || !activeTheme || closingCueFired) return;
  if (!nudgeQueue.isTypeEnabled('closing_cue')) return;

  const elapsedPct = (Date.now() - recordingStart) / (60 * 60 * 1000);
  const threshold = (activeTheme.nudgeRules.closingCueAtPercent || 80) / 100;

  if (elapsedPct >= threshold) {
    closingCueFired = true;
    const uncoveredCritical = checklistItems
      .filter(i => !i.covered && i.priority === 'critical')
      .map(i => i.label);

    const elapsedMin = Math.round((Date.now() - recordingStart) / 60000);
    let text = `${elapsedMin} minutes in — time to wrap up and lock next steps.`;
    if (uncoveredCritical.length) {
      text += ` Still uncovered: ${uncoveredCritical.join(', ')}.`;
    }
    nudgeQueue.add({ type: 'closing_cue', text });
  }
}

// ── Nudge Queue Flush ─────────────────────────────────────────────────────────
function flushNudgeQueue() {
  if (!isRecording) return;
  const nudge = nudgeQueue.flush();
  if (nudge) renderSingleNudge(nudge);
}

// ── Nudge Rendering ───────────────────────────────────────────────────────────
function renderSingleNudge(nudge) {
  // Remove placeholder if shown
  const empty = nudgesList.querySelector('.nudge-empty');
  if (empty) empty.remove();

  const meta  = NUDGE_META[nudge.type] || NUDGE_META.kb_answer;
  const id    = `nudge-${Date.now()}`;
  const card  = document.createElement('div');
  card.className = 'nudge-card';
  card.dataset.id = id;
  card.dataset.type = nudge.type;
  card.dataset.text = nudge.text;

  card.innerHTML = `
    <div class="nudge-card-header">
      <span class="nudge-type-badge ${meta.badge}">${meta.icon} ${meta.label}</span>
      <div class="nudge-card-actions">
        <button class="nudge-pin" title="Pin for report">📌</button>
        <button class="nudge-dismiss" title="Dismiss">×</button>
      </div>
    </div>
    <span class="nudge-text">${escapeHtml(nudge.text)}</span>
    ${nudge.source ? `<div class="nudge-source">${escapeHtml(nudge.source)}</div>` : ''}
    <div class="nudge-card-footer">
      <button class="nudge-copy">📋 Copy</button>
      <button class="nudge-edit-copy">✏️ Edit & Copy</button>
    </div>
  `;

  // Pin
  card.querySelector('.nudge-pin').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const isPinned = btn.classList.toggle('pinned');
    card.classList.toggle('pinned', isPinned);
    if (isPinned) {
      pinnedNudges.push({ type: nudge.type, text: nudge.text });
    } else {
      pinnedNudges = pinnedNudges.filter(n => n.text !== nudge.text);
    }
  });

  // Dismiss
  card.querySelector('.nudge-dismiss').addEventListener('click', () => {
    card.style.transition = 'opacity 0.2s';
    card.style.opacity = '0';
    setTimeout(() => card.remove(), 200);
    nudgeQueue.dismiss(nudge.type);
    nudgesDismissedCount++;
    if (!nudgesList.children.length) {
      nudgesList.innerHTML = '<p class="nudge-empty">Listening for conversation context...</p>';
    }
  });

  // Copy
  card.querySelector('.nudge-copy').addEventListener('click', (e) => {
    navigator.clipboard.writeText(nudge.text).then(() => {
      e.target.textContent = '✓ Copied';
      setTimeout(() => e.target.textContent = '📋 Copy', 1500);
    });
    nudgesUsedCount++;
  });

  // Edit & Copy
  card.querySelector('.nudge-edit-copy').addEventListener('click', (e) => {
    const textEl = card.querySelector('.nudge-text');
    if (textEl.contentEditable !== 'true') {
      textEl.contentEditable = 'true';
      textEl.focus();
      e.target.textContent = '✓ Copy edited';
    } else {
      navigator.clipboard.writeText(textEl.textContent).then(() => {
        textEl.contentEditable = 'false';
        e.target.textContent = '✏️ Edit & Copy';
      });
      nudgesUsedCount++;
    }
  });

  // Prepend new nudge at top with animation
  nudgesList.prepend(card);
  nudgesSection.classList.remove('hidden');
}

// ── Backend Nudge Refresh (LLM-based nudges) ──────────────────────────────────
async function refreshNudges() {
  if (!isRecording) return;
  nudgeSpinner.classList.remove('hidden');

  try {
    const enabledTypes = activeTheme?.nudgeRules?.enabledTypes || Object.keys(NUDGE_META);

    const res = await fetch(`${BACKEND_URL}/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: getRecentTranscript(120),
        checklist_items: checklistItems.map(a => ({
          id: a.id,
          label: a.label,
          covered: a.covered,
          priority: a.priority
        })),
        enabled_nudge_types: enabledTypes,
        theme_goal: activeTheme?.goal?.statement || '',
        theme_persona: activeTheme ? {
          role: activeTheme.persona.role,
          tone: activeTheme.persona.tone,
          outputStyle: activeTheme.persona.outputStyle
        } : null
      })
    });

    if (!res.ok) return;
    const data = await res.json();

    (data.nudges || []).slice(0, 3).forEach(n => {
      if (nudgeQueue.isTypeEnabled(n.type)) {
        nudgeQueue.add({ type: n.type, text: n.text, source: n.source });
      }
    });

  } catch (e) {
    console.error('[SP] Nudge refresh error:', e);
  } finally {
    nudgeSpinner.classList.add('hidden');
  }
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

function getMeetingDuration() {
  if (!recordingStart) return '0:00';
  const end = meetingEndTime || Date.now();
  const elapsed = Math.floor((end - recordingStart) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Checklist Rendering ───────────────────────────────────────────────────────
function renderAgendaChecklist() {
  if (!checklistItems.length) {
    agendaChecklist.classList.add('hidden');
    return;
  }

  let html = '<div class="checklist-title">Checklist</div>';

  checklistItems.forEach((item, i) => {
    const timeStr = item.coveredAt ? ` <span class="covered-time">${item.coveredAt}</span>` : '';
    html += `<label class="checklist-row ${item.covered ? 'covered' : ''}">
      <input type="checkbox" ${item.covered ? 'checked' : ''} data-idx="${i}" class="agenda-checkbox" />
      <span class="checklist-text">${escapeHtml(item.label)}</span>${timeStr}
    </label>`;
  });

  agendaChecklist.innerHTML = html;

  agendaChecklist.querySelectorAll('.agenda-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      checklistItems[idx].covered = e.target.checked;
      checklistItems[idx].coveredAt = e.target.checked ? getCurrentTime() : null;
      renderAgendaChecklist();
    });
  });
}

// ── Meeting Prep: Brief Generation ───────────────────────────────────────────
async function triggerBrief(context) {
  generateBriefBtn.textContent = '⏳ Generating...';
  generateBriefBtn.disabled = true;
  briefingCard.classList.add('hidden');

  try {
    const res = await fetch(`${BACKEND_URL}/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agenda: context })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

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

  } catch (e) {
    briefingContent.innerHTML = `<div class="brief-error">Failed to generate brief: ${escapeHtml(e.message)}</div>`;
    briefingCard.classList.remove('hidden');
    console.error('[SP] Brief error:', e);
  } finally {
    generateBriefBtn.textContent = 'Generate brief';
    generateBriefBtn.disabled = false;
  }
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
    const body = {
      transcript,
      query: question
    };
    if (activeTheme) {
      body.theme_persona = {
        role: activeTheme.persona.role,
        tone: activeTheme.persona.tone,
        outputStyle: activeTheme.persona.outputStyle,
        constraints: activeTheme.persona.constraints
      };
    }

    const response = await fetch(`${BACKEND_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
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
        } catch (e) { /* skip malformed SSE line */ }
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

// ── Post-Meeting Panel ────────────────────────────────────────────────────────
function showPostMeetingPanel() {
  const duration = getMeetingDuration();
  const covered  = checklistItems.filter(i => i.covered).length;
  const total    = checklistItems.length;
  const scoreStr = total > 0 ? `${covered}/${total}` : '—';

  statDuration.textContent   = duration;
  statChecklist.textContent  = scoreStr;
  statNudgesUsed.textContent = nudgesUsedCount;

  reportOutput.classList.add('hidden');
  reportContent.textContent = '';
  generateReportBtn.disabled = false;
  generateReportBtn.textContent = 'Generate Meeting Report';

  // Guest save row — pre-fill if a guest was active, else show blank
  guestSaveInput.value = activeGuest ? activeGuest.name : (guestNameInput.value.trim() || '');
  guestSaveInput.disabled = false;
  saveGuestBtn.disabled = false;
  guestSaveConfirm.classList.add('hidden');

  postMeetingPanel.classList.remove('hidden');
}

async function triggerReport() {
  generateReportBtn.disabled = true;
  generateReportBtn.textContent = '⏳ Generating...';
  reportOutput.classList.remove('hidden');
  reportContent.textContent = '';
  notionPushBtn.classList.add('hidden');
  notionPushBtn.disabled = false;
  notionPushBtn.textContent = 'Push to Notion';
  notionPushStatus.classList.add('hidden');

  try {
    const fullTranscript = transcriptBuffer
      .map(e => `[${new Date(e.timestamp).toISOString().slice(11, 19)}] ${e.speaker === 'you' ? 'You' : 'Guest'}: ${e.text}`)
      .join('\n');

    const checklistState = checklistItems
      .map(i => `[${i.covered ? '✓' : ' '}] ${i.label} (${i.priority})`)
      .join('\n');

    const response = await fetch(`${BACKEND_URL}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript:      fullTranscript,
        checklist_state: checklistState,
        pinned_nudges:   pinnedNudges.map(n => ({ type: n.type, text: n.text })),
        theme_id:        activeTheme?.id || 'counselling',
        theme_goal:      activeTheme?.goal?.statement || '',
        duration:        getMeetingDuration(),
        goal_achieved:   document.getElementById('goalAchievedCheck').checked
      })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let fullReport = '';

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
            fullReport += payload.text;
            reportContent.textContent = fullReport;
          }
          if (payload.done) {
            generateReportBtn.textContent = 'Report Generated ✓';
            // Show Push to Notion button if Notion is configured
            _getNotionKey().then(key => {
              _getNotionDb().then(dbId => {
                if (key && dbId) notionPushBtn.classList.remove('hidden');
              });
            });
          }
        } catch (_) {}
      }
    }

  } catch (e) {
    reportContent.textContent = `Failed to generate report: ${e.message}`;
    generateReportBtn.disabled = false;
    generateReportBtn.textContent = 'Generate Meeting Report';
    console.error('[SP] Report error:', e);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
