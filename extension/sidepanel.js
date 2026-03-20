/**
 * sidepanel.js — Counsellor Assistant UI Logic
 * 3-state: pre-call → in-call → post-call
 */

const BACKEND_URL = 'https://meeting-copilot-iota.vercel.app';
const NUDGE_BACKEND_INTERVAL_MS  = 20000; // backstop: call /nudge every 20s
const NUDGE_SPEECH_DEBOUNCE_MS   = 4000;  // wait 4s after speech stops before calling nudge
const NUDGE_MIN_WORDS            = 12;    // min new words needed to trigger speech-debounce nudge
const NUDGE_MIN_INTERVAL_MS      = 12000; // never call nudge more than once per 12s
const EXPECTED_CALL_DURATION_S   = 1200;  // default 20-min call

// ── State ─────────────────────────────────────────────────────────────────────
let appState = 'pre-call'; // 'pre-call' | 'in-call' | 'post-call'

// Student
let activeStudent = null;      // full profile from Notion
let activeStudentPageId = null;

// Recording
let isRecording = false;
let transcriptBuffer = [];     // { text, speaker, timestamp }
let currentInterim = { you: '', guest: '' };
let timerInterval = null;
let recordingStart = null;

// Audio pipelines
let tabAudioContext = null, tabWorkletNode = null, tabMediaStream = null, tabSocket = null;
let micAudioContext = null, micWorkletNode = null, micMediaStream = null, micSocket = null;

// Nudge
const nudgeQueue = new NudgeQueue();
let nudgeBackendInterval = null;
let nudgeSpeechDebounceTimer = null;
let wordsSinceLastNudge = 0;
let lastNudgeCallTime = 0;
let nudgeCallElapsed = 0;
let activeNudge = null;
let queuedNudges = [];

// Script tracking
let scriptState = {};  // momentId → 'covered' | 'in_progress'

// Field tracking
const REQUIRED_FIELDS  = ['country', 'intake', 'budget', 'preferred_course', 'preferred_degree'];
const OPTIONAL_FIELDS  = ['preferred_location', 'work_experience_months', 'backlogs', 'ielts_score', 'ug_score', 'gre_gmat_score', 'college_in_mind'];
const FIELD_LABELS = {
  country: 'Country', intake: 'Intake', budget: 'Budget',
  preferred_course: 'Course', preferred_degree: 'Degree',
  preferred_location: 'Location', work_experience_months: 'Work exp',
  backlogs: 'Backlogs', ielts_score: 'IELTS', ug_score: 'UG score',
  gre_gmat_score: 'GRE/GMAT', college_in_mind: 'Colleges',
};
let fieldState = {};  // fieldName → { value, status: 'empty'|'detected'|'confirmed' }

// Post-call extraction data
let extractionData = null;

// Notion credentials
let notionApiKey = '';
let notionDbId   = '';
let deepgramKey  = '';

// ── DOM refs ───────────────────────────────────────────────────────────────────
const settingsToggle    = document.getElementById('settingsToggle');
const settingsPanel     = document.getElementById('settingsPanel');
const deepgramKeyInput  = document.getElementById('deepgramKeyInput');
const saveKeyBtn        = document.getElementById('saveKeyBtn');
const notionKeyInput    = document.getElementById('notionKeyInput');
const saveNotionKeyBtn  = document.getElementById('saveNotionKeyBtn');
const notionDbInput     = document.getElementById('notionDbInput');
const saveNotionDbBtn   = document.getElementById('saveNotionDbBtn');
const notionTestBtn     = document.getElementById('notionTestBtn');
const notionStatus      = document.getElementById('notionStatus');
const headerTitle       = document.getElementById('headerTitle');
const statusDot         = document.getElementById('statusDot');
const timer             = document.getElementById('timer');
const stopBtn           = document.getElementById('stopBtn');

// State panels
const statePreCall      = document.getElementById('statePreCall');
const stateInCall       = document.getElementById('stateInCall');
const statePostCall     = document.getElementById('statePostCall');

// Pre-call
const studentSearchInput  = document.getElementById('studentSearchInput');
const studentSuggestions  = document.getElementById('studentSuggestions');
const studentBriefCard    = document.getElementById('studentBriefCard');
const noStudentPrompt     = document.getElementById('noStudentPrompt');
const briefStudentName    = document.getElementById('briefStudentName');
const briefSourceBadge    = document.getElementById('briefSourceBadge');
const briefCallBadge      = document.getElementById('briefCallBadge');
const briefInitialInterest = document.getElementById('briefInitialInterest');
const readinessFill       = document.getElementById('readinessFill');
const readinessScore      = document.getElementById('readinessScore');
const readinessMissing    = document.getElementById('readinessMissing');
const carryForwards       = document.getElementById('carryForwards');
const carryItems          = document.getElementById('carryItems');
const briefClearBtn       = document.getElementById('briefClearBtn');
const generateBriefBtn    = document.getElementById('generateBriefBtn');
const briefingCard        = document.getElementById('briefingCard');
const briefingContent     = document.getElementById('briefingContent');
const startBtn            = document.getElementById('startBtn');

// In-call — Next Move
const nextMoveCard          = document.getElementById('nextMoveCard');
const nextMoveSectionBadge  = document.getElementById('nextMoveSectionBadge');
const nextMoveScriptLabel   = document.getElementById('nextMoveScriptLabel');
const nextMoveQuestion      = document.getElementById('nextMoveQuestion');
const nextMoveFieldReminder = document.getElementById('nextMoveFieldReminder');
const nextMoveDoneBtn       = document.getElementById('nextMoveDoneBtn');
const nextMoveBackBtn       = document.getElementById('nextMoveBackBtn');

// In-call — Assist card (reactive nudges)
const assistCardWrap      = document.getElementById('assistCardWrap');
const assistCard          = document.getElementById('assistCard');
const assistTypeBadge     = document.getElementById('assistTypeBadge');
const assistExplanation   = document.getElementById('assistExplanation');
const assistSuggestion    = document.getElementById('assistSuggestion');
const assistPeekRow       = document.getElementById('assistPeekRow');
const assistCopyBtn       = document.getElementById('assistCopyBtn');
const assistDismissBtn    = document.getElementById('assistDismissBtn');
const fieldPills          = document.getElementById('fieldPills');
const scriptSections      = document.getElementById('scriptSections');
const transcript          = document.getElementById('transcript');
const clearTranscriptBtn  = document.getElementById('clearTranscriptBtn');

// Post-call
const postDuration        = document.getElementById('postDuration');
const postStudentName     = document.getElementById('postStudentName');
const extractionStatus    = document.getElementById('extractionStatus');
const extractedFields     = document.getElementById('extractedFields');
const qProfileSummary     = document.getElementById('qProfileSummary');
const qMotivation         = document.getElementById('qMotivation');
const qConstraints        = document.getElementById('qConstraints');
const qEmotionalNotes     = document.getElementById('qEmotionalNotes');
const openQuestions       = document.getElementById('openQuestions');
const counsellorCommitments = document.getElementById('counsellorCommitments');
const leadStatusSelect    = document.getElementById('leadStatusSelect');
const generateReportBtn   = document.getElementById('generateReportBtn');
const reportOutput        = document.getElementById('reportOutput');
const reportContent       = document.getElementById('reportContent');
const saveNotionBtn       = document.getElementById('saveNotionBtn');
const notionSaveStatus    = document.getElementById('notionSaveStatus');
const newCallBtn          = document.getElementById('newCallBtn');

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  const stored = await chrome.storage.local.get(['deepgramKey', 'notionKey', 'notionDbId']);
  deepgramKey  = stored.deepgramKey  || '';
  notionApiKey = stored.notionKey    || '';
  notionDbId   = stored.notionDbId   || '';

  deepgramKeyInput.value = deepgramKey  ? '••••••••' : '';
  notionKeyInput.value   = notionApiKey ? '••••••••' : '';
  notionDbInput.value    = notionDbId   || '';

  initScriptState();
  renderFieldPills();
  renderScriptTracker();
  setAppState('pre-call');
}

// ── App state ──────────────────────────────────────────────────────────────────
function setAppState(state) {
  appState = state;
  statePreCall.classList.toggle('hidden', state !== 'pre-call');
  stateInCall.classList.toggle('hidden', state !== 'in-call');
  statePostCall.classList.toggle('hidden', state !== 'post-call');
}

// ── Settings ───────────────────────────────────────────────────────────────────
settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

saveKeyBtn.addEventListener('click', async () => {
  const val = deepgramKeyInput.value.trim();
  if (!val || val === '••••••••') return;
  deepgramKey = val;
  await chrome.storage.local.set({ deepgramKey: val });
  deepgramKeyInput.value = '••••••••';
  saveKeyBtn.textContent = '✓';
  setTimeout(() => { saveKeyBtn.textContent = 'Save'; }, 1500);
});

saveNotionKeyBtn.addEventListener('click', async () => {
  const val = notionKeyInput.value.trim();
  if (!val || val === '••••••••') return;
  notionApiKey = val;
  await chrome.storage.local.set({ notionKey: val });
  notionKeyInput.value = '••••••••';
  saveNotionKeyBtn.textContent = '✓';
  setTimeout(() => { saveNotionKeyBtn.textContent = 'Save'; }, 1500);
});

saveNotionDbBtn.addEventListener('click', async () => {
  const val = notionDbInput.value.trim();
  notionDbId = val;
  await chrome.storage.local.set({ notionDbId: val });
  saveNotionDbBtn.textContent = '✓';
  setTimeout(() => { saveNotionDbBtn.textContent = 'Save'; }, 1500);
});

notionTestBtn.addEventListener('click', async () => {
  if (!notionApiKey) { showNotionStatus('No Notion key saved', false); return; }
  notionTestBtn.disabled = true;
  notionTestBtn.textContent = 'Testing...';
  try {
    const name = await NotionSync.testConnection(notionApiKey);
    showNotionStatus(`Connected as: ${name}`, true);
  } catch (e) {
    showNotionStatus(`Error: ${e.message}`, false);
  }
  notionTestBtn.disabled = false;
  notionTestBtn.textContent = 'Test connection';
});

function showNotionStatus(msg, ok) {
  notionStatus.textContent = msg;
  notionStatus.style.color = ok ? 'var(--c-script)' : 'var(--c-profile)';
  notionStatus.classList.remove('hidden');
  setTimeout(() => notionStatus.classList.add('hidden'), 4000);
}

// ── Student search ─────────────────────────────────────────────────────────────
let searchDebounce = null;

studentSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = studentSearchInput.value.trim();
  if (!q) { studentSuggestions.classList.add('hidden'); return; }
  searchDebounce = setTimeout(() => searchStudents(q), 350);
});

studentSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    studentSuggestions.classList.add('hidden');
    studentSearchInput.blur();
  }
});

document.addEventListener('click', (e) => {
  if (!studentSuggestions.contains(e.target) && e.target !== studentSearchInput) {
    studentSuggestions.classList.add('hidden');
  }
});

async function searchStudents(q) {
  if (!notionApiKey || !notionDbId) {
    studentSuggestions.innerHTML = '<div class="suggestion-item"><div class="suggestion-item-name" style="color:var(--text-3)">Configure Notion in Settings first</div></div>';
    studentSuggestions.classList.remove('hidden');
    return;
  }
  try {
    const results = await NotionSync.searchStudents(q, notionApiKey, notionDbId);
    renderSuggestions(results);
  } catch (e) {
    studentSuggestions.innerHTML = `<div class="suggestion-item"><div class="suggestion-item-name" style="color:var(--c-profile)">Search error: ${e.message}</div></div>`;
    studentSuggestions.classList.remove('hidden');
  }
}

function renderSuggestions(results) {
  if (!results.length) {
    studentSuggestions.innerHTML = '<div class="suggestion-item"><div class="suggestion-item-name" style="color:var(--text-3)">No students found</div></div>';
    studentSuggestions.classList.remove('hidden');
    return;
  }
  studentSuggestions.innerHTML = results.map(r => `
    <div class="suggestion-item" data-page-id="${r.pageId}">
      <div class="suggestion-item-name">${r.name}</div>
      <div class="suggestion-item-meta">${r.source || 'Unknown source'} · ${r.leadStatus} · Call ${r.callCount}</div>
    </div>
  `).join('');
  studentSuggestions.querySelectorAll('.suggestion-item').forEach(el => {
    el.addEventListener('click', () => loadStudent(el.dataset.pageId));
  });
  studentSuggestions.classList.remove('hidden');
}

async function loadStudent(pageId) {
  studentSuggestions.classList.add('hidden');
  studentSearchInput.value = 'Loading...';
  studentSearchInput.disabled = true;
  try {
    const profile = await NotionSync.getStudentProfile(pageId, notionApiKey);
    activeStudent = profile;
    activeStudentPageId = pageId;
    studentSearchInput.value = profile.name || '';
    studentSearchInput.disabled = false;
    renderStudentBriefCard(profile);
  } catch (e) {
    studentSearchInput.value = '';
    studentSearchInput.disabled = false;
    studentSearchInput.placeholder = `Error loading student: ${e.message}`;
  }
}

function renderStudentBriefCard(profile) {
  noStudentPrompt.classList.add('hidden');
  studentBriefCard.classList.remove('hidden');

  briefStudentName.textContent = profile.name || 'Unknown student';
  briefSourceBadge.textContent = profile.source_platform || 'Unknown';
  briefSourceBadge.classList.toggle('hidden', !profile.source_platform);

  const callNum = (profile.call_count || 0) + 1;
  briefCallBadge.textContent = `Call ${callNum}`;

  briefInitialInterest.textContent = profile.initial_interest || '';
  briefInitialInterest.classList.toggle('hidden', !profile.initial_interest);

  // Readiness bar
  const requiredDone = REQUIRED_FIELDS.filter(f => {
    const v = profile[f];
    return v && (Array.isArray(v) ? v.length > 0 : true);
  });
  const pct = Math.round(requiredDone.length / REQUIRED_FIELDS.length * 100);
  readinessFill.style.width = pct + '%';
  readinessScore.textContent = `${requiredDone.length}/5 fields`;
  const missing = REQUIRED_FIELDS.filter(f => {
    const v = profile[f];
    return !v || (Array.isArray(v) && v.length === 0);
  });
  readinessMissing.textContent = missing.length ? `Missing: ${missing.map(f => FIELD_LABELS[f]).join(', ')}` : '';

  // Carry-forwards (Call 2+)
  if (callNum >= 2 && (profile.open_questions || profile.counsellor_commitments || profile.emotional_notes)) {
    carryForwards.classList.remove('hidden');
    const items = [];
    if (profile.open_questions)        items.push({ text: profile.open_questions, type: '❓' });
    if (profile.counsellor_commitments) items.push({ text: profile.counsellor_commitments, type: '📋' });
    if (profile.emotional_notes)        items.push({ text: profile.emotional_notes, type: '💬' });
    carryItems.innerHTML = items.map(i => `
      <div class="carry-item">
        <input type="checkbox" />
        <span class="carry-item-text">${i.type} ${escapeHtml(i.text)}</span>
      </div>
    `).join('');
  } else {
    carryForwards.classList.add('hidden');
  }

  // Pre-populate field state from existing profile
  initFieldStateFromProfile(profile);
  renderFieldPills();
}

briefClearBtn.addEventListener('click', () => {
  activeStudent = null;
  activeStudentPageId = null;
  studentSearchInput.value = '';
  studentBriefCard.classList.add('hidden');
  noStudentPrompt.classList.remove('hidden');
  briefingCard.classList.add('hidden');
  resetFieldState();
  renderFieldPills();
});

// ── Brief generation ───────────────────────────────────────────────────────────
generateBriefBtn.addEventListener('click', async () => {
  if (!activeStudent) return;
  generateBriefBtn.textContent = '⟳ Generating...';
  generateBriefBtn.classList.add('loading');

  const callNumber = (activeStudent.call_count || 0) + 1;
  const callHistoryText = (activeStudent.callHistory || [])
    .map(h => h.content || '').join('\n\n').trim();

  try {
    const data = await fetch(`${BACKEND_URL}/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_profile: activeStudent,
        call_history: callHistoryText || null,
        call_number: callNumber,
      }),
    }).then(r => r.json());

    renderBriefCard(data);
  } catch (e) {
    briefingContent.innerHTML = `<span style="color:var(--c-profile)">Error: ${e.message}</span>`;
    briefingCard.classList.remove('hidden');
  }

  generateBriefBtn.textContent = 'Generate brief';
  generateBriefBtn.classList.remove('loading');
});

function renderBriefCard(data) {
  let html = '';

  // Carry-forwards — highest priority, shown first
  if (data.carry_forwards?.length) {
    const highs = data.carry_forwards.filter(c => c.urgency === 'high');
    const meds  = data.carry_forwards.filter(c => c.urgency !== 'high');
    const renderCF = (items) => items.map(c => {
      const text = typeof c === 'string' ? c : c.text;
      return `<div class="brief-bullet carry-forward">⚠ ${escapeHtml(text)}</div>`;
    }).join('');
    if (highs.length || meds.length) {
      html += `<div class="brief-section-title">From Last Call</div>`;
      html += renderCF(highs) + renderCF(meds);
    }
  }

  // Profile context
  if (data.profile_context) {
    html += `<div class="brief-section-title">Profile</div>`;
    html += `<div class="brief-context">${escapeHtml(data.profile_context)}</div>`;
  }

  // Shortlist readiness
  const sr = data.shortlist_readiness;
  if (sr) {
    const pct = sr.required_total ? Math.round((sr.required_captured / sr.required_total) * 100) : 0;
    html += `<div class="brief-section-title">Shortlist Readiness</div>`;
    html += `<div class="readiness-bar-wrap">
      <div class="readiness-bar" style="width:${pct}%"></div>
    </div>`;
    if (sr.missing_required?.length) {
      html += `<div class="brief-missing">Missing: ${sr.missing_required.map(escapeHtml).join(', ')}</div>`;
    }
  }

  // Tone guidance
  if (data.tone_guidance) {
    html += `<div class="brief-section-title">Tone</div>`;
    html += `<div class="brief-tone">${escapeHtml(data.tone_guidance)}</div>`;
  }

  briefingContent.innerHTML = html || '<div class="brief-bullet">No briefing data available.</div>';
  briefingCard.classList.remove('hidden');
}

// ── Field state ────────────────────────────────────────────────────────────────
function resetFieldState() {
  fieldState = {};
  [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].forEach(f => {
    fieldState[f] = { value: null, status: 'empty' };
  });
}

function initFieldStateFromProfile(profile) {
  resetFieldState();
  [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].forEach(f => {
    const v = profile[f];
    if (v && (Array.isArray(v) ? v.length > 0 : true)) {
      const display = Array.isArray(v) ? v.join(', ') : String(v);
      fieldState[f] = { value: display, status: 'confirmed' };
    }
  });
}

function initScriptState() {
  scriptState = {};
  const theme = getCounsellingTheme();
  theme.scriptMoments.forEach(m => { scriptState[m.id] = 'pending'; });
}

function applyExtractedFields(fields) {
  if (!fields || typeof fields !== 'object') return;
  let anyNew = false;
  for (const [key, info] of Object.entries(fields)) {
    if (!fieldState[key]) continue;
    if (fieldState[key].status === 'confirmed') continue; // never overwrite confirmed
    if (info.confidence === 'low') continue;
    fieldState[key] = { value: info.value, status: 'detected' };
    anyNew = true;
  }
  if (anyNew) { renderFieldPills(); renderNextMove(); }
}

function applyScriptStateUpdate(update) {
  if (!update || typeof update !== 'object') return;
  let changed = false;
  for (const [id, status] of Object.entries(update)) {
    if (scriptState[id] !== 'covered') {
      scriptState[id] = status;
      changed = true;
    }
  }
  if (changed) { renderScriptTracker(); renderNextMove(); }
}

// ── Render field pills ─────────────────────────────────────────────────────────
function renderFieldPills() {
  if (!fieldPills) return;
  const allFields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
  fieldPills.innerHTML = allFields.map(f => {
    const s = fieldState[f] || { value: null, status: 'empty' };
    const label = FIELD_LABELS[f];
    let cls = 'field-pill ';
    let content = escapeHtml(label);
    if (s.status === 'empty') {
      cls += 'state-empty';
    } else if (s.status === 'detected') {
      cls += 'state-detected';
      content += `<span class="field-pill-value"> ${escapeHtml(s.value)}</span><span class="field-pill-q">?</span>`;
    } else {
      cls += 'state-confirmed';
      content += `<span class="field-pill-value"> ${escapeHtml(String(s.value))}</span>`;
    }
    return `<div class="${cls}" data-field="${f}">${content}</div>`;
  }).join('');

  fieldPills.querySelectorAll('.field-pill').forEach(pill => {
    pill.addEventListener('click', () => confirmFieldPill(pill));
  });
}

function confirmFieldPill(pill) {
  const f = pill.dataset.field;
  if (!fieldState[f]) return;
  const cur = fieldState[f];
  if (cur.status === 'detected') {
    // Confirm the detected value
    fieldState[f] = { value: cur.value, status: 'confirmed' };
    renderFieldPills();
  }
}

// ── Render script tracker ──────────────────────────────────────────────────────
function renderScriptTracker() {
  if (!scriptSections) return;
  const theme = getCounsellingTheme();
  const sections = {};
  theme.scriptMoments.forEach(m => {
    if (!sections[m.section]) sections[m.section] = [];
    sections[m.section].push(m);
  });

  scriptSections.innerHTML = Object.entries(sections).map(([sectionName, moments]) => `
    <div class="script-section-row">
      <span class="script-section-name">${sectionName}</span>
      <div class="script-dots">
        ${moments.map(m => {
          const state = scriptState[m.id] || 'pending';
          const cls = state === 'covered' ? 'covered' : (state === 'in_progress' ? 'in-progress' : '');
          return `<div class="script-dot ${cls}" title="${m.label}"></div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

// ── Assist card ────────────────────────────────────────────────────────────────
const TYPE_LABELS = {
  profile_clarification: 'Profile mismatch',
  intent_divergence:     'Intent divergence',
  emotional_signal:      'Emotional signal',
  kb_answer:             'KB answer',
  script_gap:            'Script nudge',
  field_gap:             'Field gap',
};

function showAssistCard(nudge) {
  activeNudge = nudge;
  assistCard.classList.remove('hidden');

  assistCard.className = `assist-card type-${nudge.type}`;
  assistTypeBadge.textContent = TYPE_LABELS[nudge.type] || nudge.type;
  assistExplanation.textContent = nudge.text || '';
  assistSuggestion.textContent  = nudge.suggestion || '';

  // Peek row: show queued items
  assistPeekRow.innerHTML = queuedNudges.slice(0, 3).map(n =>
    `<span class="peek-badge">${TYPE_LABELS[n.type] || n.type}</span>`
  ).join('');
}

function hideAssistCard() {
  activeNudge = null;
  assistCard.classList.add('hidden');
  assistPeekRow.innerHTML = '';
}

// ── Next Move card ─────────────────────────────────────────────────────────────

const FIELD_QUESTIONS = {
  country:               'Which country or countries are you considering?',
  intake:                'When are you looking to start — which year and intake?',
  budget:                'What is your budget for the full program including living expenses?',
  preferred_course:      'What course or program do you want to study?',
  preferred_degree:      'Are you targeting a Masters, Bachelors, Diploma, or something else?',
  preferred_location:    'Do you have a preferred city or region within that country?',
  work_experience_months:'How many months of work experience do you have so far?',
  backlogs:              'Do you have any backlogs in your degree?',
  ielts_score:           'Have you taken IELTS or PTE? What was your score?',
  ug_score:              'What is your undergraduate CGPA or percentage?',
  gre_gmat_score:        'Have you taken the GRE or GMAT?',
  college_in_mind:       'Are there any specific universities you already have in mind?',
};

const SECTION_COLORS = {
  Rapport: 'var(--c-script)',
  Profiling: 'var(--c-profile)',
  Reaffirmation: 'var(--c-kb)',
  Close: '#888',
};

function renderNextMove() {
  if (!isRecording) return;

  const theme = getCounsellingTheme();
  const moments = theme.scriptMoments;

  // Find the next uncovered script moment
  const nextMoment = moments.find(m => {
    const s = scriptState[m.id];
    return !s || s === 'pending';
  });

  if (!nextMoment) {
    nextMoveCard.classList.add('all-done');
    nextMoveScriptLabel.textContent = 'All script moments covered';
    nextMoveQuestion.textContent = 'Great work — wrap up and book the next call.';
    nextMoveSectionBadge.textContent = 'Complete';
    nextMoveFieldReminder.classList.add('hidden');
    return;
  }

  nextMoveCard.classList.remove('all-done');
  nextMoveSectionBadge.textContent = nextMoment.section;
  nextMoveSectionBadge.style.color = SECTION_COLORS[nextMoment.section] || '#888';
  nextMoveScriptLabel.textContent = nextMoment.label;
  nextMoveQuestion.textContent = nextMoment.suggestedQuestion;

  // Field reminder: show missing required fields if we're in Profiling or later
  const sectionOrder = ['Rapport', 'Profiling', 'Reaffirmation', 'Close'];
  const currentSectionIdx = sectionOrder.indexOf(nextMoment.section);
  if (currentSectionIdx >= 1) {
    const missingRequired = REQUIRED_FIELDS.filter(f => !fieldState[f] || fieldState[f].status === 'empty');
    if (missingRequired.length > 0) {
      nextMoveFieldReminder.textContent = `Still need: ${missingRequired.map(f => FIELD_LABELS[f]).join(', ')}`;
      nextMoveFieldReminder.classList.remove('hidden');
    } else {
      nextMoveFieldReminder.classList.add('hidden');
    }
  } else {
    nextMoveFieldReminder.classList.add('hidden');
  }
}

// "Done" button manually marks current moment as covered and advances
nextMoveDoneBtn.addEventListener('click', () => {
  const theme = getCounsellingTheme();
  const nextMoment = theme.scriptMoments.find(m => {
    const s = scriptState[m.id];
    return !s || s === 'pending';
  });
  if (nextMoment) {
    scriptState[nextMoment.id] = 'covered';
    renderScriptTracker();
    renderNextMove();
  }
});

nextMoveBackBtn.addEventListener('click', () => {
  const theme = getCounsellingTheme();
  const moments = [...theme.scriptMoments].reverse();
  const lastCovered = moments.find(m => scriptState[m.id] === 'covered');
  if (lastCovered) {
    scriptState[lastCovered.id] = 'pending';
    renderScriptTracker();
    renderNextMove();
  }
});

assistCopyBtn.addEventListener('click', () => {
  if (activeNudge?.suggestion) {
    navigator.clipboard.writeText(activeNudge.suggestion).catch(() => {});
    assistCopyBtn.textContent = '✓';
    setTimeout(() => { assistCopyBtn.textContent = '⎘'; }, 1500);
  }
});

assistDismissBtn.addEventListener('click', () => {
  if (activeNudge) {
    nudgeQueue.dismiss(activeNudge.type);
    queuedNudges = queuedNudges.filter(n => n !== activeNudge);
    activeNudge = null;
  }
  // Show next queued nudge
  const next = nudgeQueue.flush();
  if (next) {
    showAssistCard(next);
  } else {
    hideAssistCard();
  }
});

// ── Start / stop recording ─────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  if (!deepgramKey) {
    settingsPanel.classList.remove('hidden');
    return;
  }
  await startRecording();
});

stopBtn.addEventListener('click', stopRecording);

async function startRecording() {
  isRecording = true;
  recordingStart = Date.now();
  transcriptBuffer = [];
  nudgeCallElapsed = 0;

  // Reset nudge/script/field state
  nudgeQueue.reset();
  queuedNudges = [];
  activeNudge = null;
  wordsSinceLastNudge = 0;
  lastNudgeCallTime = 0;
  initScriptState();
  if (!activeStudent) {
    resetFieldState();
  }

  // UI transition → in-call
  setAppState('in-call');
  hideAssistCard();
  renderScriptTracker();
  renderFieldPills();
  renderNextMove();
  clearTranscript();

  statusDot.classList.add('recording');
  stopBtn.classList.remove('hidden');
  timer.classList.remove('hidden');
  headerTitle.textContent = activeStudent ? activeStudent.name : 'Counsellor Assistant';

  // Timer
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStart) / 1000);
    nudgeCallElapsed = elapsed;
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    timer.textContent = `${m}:${s}`;
  }, 1000);

  // Start Deepgram (tab audio = guest, mic = counsellor)
  try {
    await startTabCapture();
  } catch (e) {
    console.warn('Tab capture failed:', e.message);
  }
  try {
    await startMicCapture();
  } catch (e) {
    console.warn('Mic capture failed:', e.message);
  }

  // Nudge polling
  nudgeBackendInterval = setInterval(callNudgeBackend, NUDGE_BACKEND_INTERVAL_MS);
}

function stopRecording() {
  isRecording = false;

  clearInterval(timerInterval);
  clearInterval(nudgeBackendInterval);
  clearTimeout(nudgeSpeechDebounceTimer);

  stopTabCapture();
  stopMicCapture();

  statusDot.classList.remove('recording');
  stopBtn.classList.add('hidden');
  timer.classList.add('hidden');

  const durationMs = Date.now() - (recordingStart || Date.now());
  const durationStr = formatDuration(durationMs);

  transitionToPostCall(durationStr);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

// ── Tab capture (guest audio) ──────────────────────────────────────────────────
async function startTabCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  const streamId = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'START_CAPTURE', tabId: tab.id }, (resp) => {
      if (chrome.runtime.lastError || !resp?.streamId) reject(new Error('No stream ID'));
      else resolve(resp.streamId);
    });
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      }
    },
    video: false,
  });

  tabMediaStream = stream;
  tabAudioContext = new AudioContext();
  await tabAudioContext.resume();
  const tabSampleRate = tabAudioContext.sampleRate;
  await tabAudioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));
  const source = tabAudioContext.createMediaStreamSource(stream);
  tabWorkletNode = new AudioWorkletNode(tabAudioContext, 'pcm-processor');
  const tabSilentDest = tabAudioContext.createMediaStreamDestination();
  source.connect(tabWorkletNode);
  source.connect(tabAudioContext.destination); // keep tab audio audible
  tabWorkletNode.connect(tabSilentDest);       // keep worklet alive

  const tabUrl = `wss://api.deepgram.com/v1/listen`
    + `?model=nova-2&encoding=linear16&sample_rate=${tabSampleRate}&channels=1`
    + `&smart_format=true&interim_results=true`;
  tabSocket = new WebSocket(tabUrl, ['token', deepgramKey]); // subprotocol auth
  tabSocket.binaryType = 'arraybuffer';
  tabSocket.onopen = () => {
    console.log('[Tab WS] Deepgram connected (guest)');
    let tabChunkCount = 0;
    tabWorkletNode.port.onmessage = (e) => {
      if (tabSocket.readyState === WebSocket.OPEN) {
        tabSocket.send(e.data);
        tabChunkCount++;
        if (tabChunkCount === 1 || tabChunkCount % 100 === 0) {
          console.log(`[Tab WS] sent ${tabChunkCount} audio chunks, bytes=${e.data.byteLength}`);
        }
      }
    };
  };
  tabSocket.onmessage = (e) => {
    console.log('[Tab WS] raw message:', typeof e.data === 'string' ? e.data.slice(0, 200) : '(binary)');
    handleDeepgramMessage(e, 'guest');
  };
  tabSocket.onerror = (e) => console.error('[Tab WS] error', e);
  tabSocket.onclose = (e) => { if (e.code !== 1005) console.warn('[Tab WS] closed', e.code, e.reason); };
}

function stopTabCapture() {
  tabSocket?.close();
  tabWorkletNode?.disconnect();
  tabAudioContext?.close();
  tabMediaStream?.getTracks().forEach(t => t.stop());
  tabSocket = null; tabWorkletNode = null; tabAudioContext = null; tabMediaStream = null;
}

// ── Mic capture (counsellor audio) ────────────────────────────────────────────
async function startMicCapture() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  micMediaStream = stream;
  micAudioContext = new AudioContext();
  await micAudioContext.resume();
  const micSampleRate = micAudioContext.sampleRate;
  await micAudioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));
  const source = micAudioContext.createMediaStreamSource(stream);
  micWorkletNode = new AudioWorkletNode(micAudioContext, 'pcm-processor');
  const micSilentDest = micAudioContext.createMediaStreamDestination();
  source.connect(micWorkletNode);
  micWorkletNode.connect(micSilentDest);

  const micUrl = `wss://api.deepgram.com/v1/listen`
    + `?model=nova-2&encoding=linear16&sample_rate=${micSampleRate}&channels=1`
    + `&smart_format=true&interim_results=true`;
  micSocket = new WebSocket(micUrl, ['token', deepgramKey]);
  micSocket.binaryType = 'arraybuffer';
  micSocket.onopen = () => {
    console.log('[Mic WS] Deepgram connected (you)');
    micWorkletNode.port.onmessage = (e) => {
      if (micSocket.readyState === WebSocket.OPEN) micSocket.send(e.data);
    };
  };
  micSocket.onmessage = (e) => handleDeepgramMessage(e, 'you');
  micSocket.onerror = (e) => console.error('[Mic WS] error', e);
  micSocket.onclose = (e) => { if (e.code !== 1005) console.warn('[Mic WS] closed', e.code, e.reason); };
}

function stopMicCapture() {
  micSocket?.close();
  micWorkletNode?.disconnect();
  micAudioContext?.close();
  micMediaStream?.getTracks().forEach(t => t.stop());
  micSocket = null; micWorkletNode = null; micAudioContext = null; micMediaStream = null;
}

// ── Deepgram message handler ───────────────────────────────────────────────────
function handleDeepgramMessage(event, speaker) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }

  const alt = data?.channel?.alternatives?.[0];
  if (!alt) return;

  const text    = alt.transcript?.trim() || '';
  const isFinal = data.is_final;

  if (!text) return;

  if (isFinal) {
    currentInterim[speaker] = '';
    appendTranscriptBubble(text, speaker, false);
    transcriptBuffer.push({ text, speaker, timestamp: Date.now() });

    // Only trigger KB on student questions, not counsellor
    if (speaker === 'guest') {
      maybeQueryBackend(text);
    }

    // Speech-triggered nudge: debounce 4s after conversation pauses
    wordsSinceLastNudge += text.split(/\s+/).filter(Boolean).length;
    clearTimeout(nudgeSpeechDebounceTimer);
    nudgeSpeechDebounceTimer = setTimeout(() => {
      if (isRecording &&
          wordsSinceLastNudge >= NUDGE_MIN_WORDS &&
          Date.now() - lastNudgeCallTime >= NUDGE_MIN_INTERVAL_MS) {
        callNudgeBackend();
      }
    }, NUDGE_SPEECH_DEBOUNCE_MS);
  } else {
    currentInterim[speaker] = text;
    updateInterimBubble(text, speaker);
  }
}

// ── Transcript rendering ───────────────────────────────────────────────────────
function clearTranscript() {
  transcript.innerHTML = '<p class="placeholder-text">Transcript will appear here...</p>';
}

function appendTranscriptBubble(text, speaker, isInterim) {
  // Remove placeholder
  const placeholder = transcript.querySelector('.placeholder-text');
  if (placeholder) placeholder.remove();

  // Remove existing interim bubble for this speaker
  const existingInterim = transcript.querySelector(`.transcript-bubble.${speaker}.interim`);
  if (existingInterim) existingInterim.remove();

  const bubble = document.createElement('div');
  bubble.className = `transcript-bubble ${speaker}${isInterim ? ' interim' : ''}`;

  const labelEl = document.createElement('div');
  labelEl.className = 'transcript-bubble-label';
  labelEl.textContent = speaker === 'you' ? 'You' : 'Student';
  bubble.appendChild(labelEl);

  const textEl = document.createElement('div');
  textEl.className = 'transcript-bubble-text';
  textEl.textContent = text;
  bubble.appendChild(textEl);

  transcript.appendChild(bubble);
  transcript.scrollTop = transcript.scrollHeight;
}

function updateInterimBubble(text, speaker) {
  appendTranscriptBubble(text, speaker, true);
}

clearTranscriptBtn.addEventListener('click', clearTranscript);

// ── Question detection → /query ────────────────────────────────────────────────
const QUESTION_STARTERS = /^(what|how|when|where|why|who|which|can|could|do|does|did|is|are|was|were|will|would|should|shall)\b/i;
let lastQueryTime = 0;
const QUERY_DEBOUNCE_MS = 4000;

const NON_FACTUAL_PATTERNS = /\b(what the|wtf|seriously|really\?|right\?|isn't it|don't you|are you sure|you know what|i mean|like what|have you said|are you kidding|what do you mean)\b/i;
const EMOTIONAL_STARTERS = /^(oh|wow|really|seriously|wait|no|yes|okay|ok|hmm|ugh|so|but|and|well|i think|i feel|i just)\b/i;

function maybeQueryBackend(text) {
  const isQuestion = text.endsWith('?') || QUESTION_STARTERS.test(text);
  if (!isQuestion) return;
  if (NON_FACTUAL_PATTERNS.test(text)) return;
  if (EMOTIONAL_STARTERS.test(text)) return;
  if (text.split(' ').filter(Boolean).length < 5) return;
  if (Date.now() - lastQueryTime < QUERY_DEBOUNCE_MS) return;
  lastQueryTime = Date.now();
  runQuery(text);
}

async function runQuery(question) {
  const recentTranscript = transcriptBuffer.slice(-20).map(b => `${b.speaker === 'you' ? 'Counsellor' : 'Student'}: ${b.text}`).join('\n');

  try {
    const response = await fetch(`${BACKEND_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: recentTranscript,
        query: question,
        student_context: activeStudent,
      }),
    });

    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.text) fullText += parsed.text;
          if (parsed.done && fullText.trim()) {
            nudgeQueue.add({
              type: 'kb_answer',
              text: `Student asked: "${question}"`,
              suggestion: fullText.trim(),
              source: parsed.sources?.join(', ') || 'KB',
            });
            const next = nudgeQueue.flush();
            if (next) showAssistCard(next);
          }
        } catch { /* ignore parse errors */ }
      }
    }
  } catch (e) {
    console.warn('/query failed:', e.message);
  }
}

// ── Nudge backend polling ──────────────────────────────────────────────────────
async function callNudgeBackend() {
  if (!isRecording) return;
  if (transcriptBuffer.length === 0) return;

  lastNudgeCallTime = Date.now();
  wordsSinceLastNudge = 0;

  // transcript_recent: last 6 chunks as structured objects
  const recentChunks = transcriptBuffer.slice(-6).map(b => ({
    speaker: b.speaker === 'you' ? 'counsellor' : 'student',
    text: b.text,
    timestamp: b.timestamp,
  }));

  // transcript_full: last 80 turns as readable text
  const transcriptFull = transcriptBuffer.slice(-80)
    .map(b => `${b.speaker === 'you' ? 'Counsellor' : 'Student'}: ${b.text}`)
    .join('\n');

  // fields currently captured
  const fieldsCaptured = {};
  Object.entries(fieldState).forEach(([k, v]) => {
    if (v.status !== 'empty' && v.value != null) fieldsCaptured[k] = v.value;
  });

  // types currently in cooldown (recently dismissed)
  const now = Date.now();
  const dismissedNudges = [...nudgeQueue.suppressedUntil.entries()]
    .filter(([, until]) => until > now)
    .map(([type]) => type);

  try {
    const data = await fetch(`${BACKEND_URL}/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript_recent: recentChunks,
        transcript_full: transcriptFull,
        script_state: scriptState,
        fields_captured: fieldsCaptured,
        student_context: activeStudent,
        call_elapsed_seconds: nudgeCallElapsed,
        expected_call_duration_seconds: EXPECTED_CALL_DURATION_S,
        dismissed_nudges: dismissedNudges,
        open_questions: [],
        disinterest_flags: [],
      }),
    }).then(r => r.json());

    // Apply extracted fields
    if (data.extracted_fields) applyExtractedFields(data.extracted_fields);

    // Apply script state updates
    if (data.script_state_update) applyScriptStateUpdate(data.script_state_update);

    // Add nudges to queue
    if (data.nudges?.length) {
      data.nudges.forEach(n => {
        if (nudgeQueue.isTypeEnabled(n.type)) {
          nudgeQueue.add(n);
          queuedNudges.push(n);
        }
      });

      // Show if no active card
      if (!activeNudge) {
        const next = nudgeQueue.flush();
        if (next) showAssistCard(next);
      } else {
        // Interrupt if higher priority P1 nudge
        const highPriority = data.nudges.find(n => ['profile_clarification', 'intent_divergence'].includes(n.type));
        if (highPriority && activeNudge.priority < 5) {
          nudgeQueue.add(highPriority);
          const next = nudgeQueue.flush();
          if (next) showAssistCard(next);
        }
        // Update peek row
        assistPeekRow.innerHTML = queuedNudges.slice(0, 3).map(n =>
          `<span class="peek-badge">${TYPE_LABELS[n.type] || n.type}</span>`
        ).join('');
      }
    }
  } catch (e) {
    console.warn('/nudge failed:', e.message);
  }
}

// ── Post-call ──────────────────────────────────────────────────────────────────
async function transitionToPostCall(durationStr) {
  setAppState('post-call');
  headerTitle.textContent = 'Call Complete';
  postDuration.textContent = durationStr;
  postStudentName.textContent = activeStudent ? activeStudent.name : 'No student loaded';

  // Reset qualitative fields
  qProfileSummary.value = activeStudent?.profile_summary || '';
  qMotivation.value     = activeStudent?.motivation      || '';
  qConstraints.value    = activeStudent?.constraints     || '';
  qEmotionalNotes.value = '';

  // Set lead status
  const callNum = (activeStudent?.call_count || 0) + 1;
  const suggested = callNum === 1 ? 'Call 1 Done' : callNum === 2 ? 'Call 2 Done' : 'Applied';
  leadStatusSelect.value = suggested;

  // Clear extraction panel
  extractionStatus.textContent = 'Extracting...';
  extractedFields.innerHTML = '';
  openQuestions.innerHTML = '';
  counsellorCommitments.innerHTML = '';
  reportOutput.classList.add('hidden');
  notionSaveStatus.classList.add('hidden');

  // Call /extract
  const fullTranscript = transcriptBuffer.map(b => `${b.speaker === 'you' ? 'Counsellor' : 'Student'}: ${b.text}`).join('\n');
  runExtraction(fullTranscript, callNum);
}

async function runExtraction(fullTranscript, callNum) {
  try {
    const data = await fetch(`${BACKEND_URL}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: fullTranscript,
        student_context: activeStudent,
        call_number: callNum,
      }),
    }).then(r => r.json());

    extractionData = data;
    extractionStatus.textContent = 'Review & confirm';

    renderExtractionFields(data.profile_updates || {});
    renderOpenItems(data.open_questions || [], data.counsellor_commitments || []);

    // Pre-fill qualitative
    if (data.qualitative?.profile_summary) qProfileSummary.value = data.qualitative.profile_summary;
    if (data.qualitative?.motivation)      qMotivation.value     = data.qualitative.motivation;
    if (data.qualitative?.constraints)     qConstraints.value    = data.qualitative.constraints;
    if (data.qualitative?.emotional_notes) qEmotionalNotes.value = data.qualitative.emotional_notes;

    // Lead status suggestion
    if (data.lead_status_suggestion) leadStatusSelect.value = data.lead_status_suggestion;

  } catch (e) {
    extractionStatus.textContent = `Extraction failed: ${e.message}`;
  }
}

function renderExtractionFields(updates) {
  const DISPLAY_FIELDS = [
    ['country','Country'], ['intake','Intake'], ['budget','Budget'],
    ['preferred_course','Course'], ['preferred_degree','Degree'],
    ['preferred_location','Location'], ['work_experience_months','Work exp (months)'],
    ['backlogs','Backlogs'], ['ielts_score','IELTS'], ['ug_score','UG score'],
    ['gre_gmat_score','GRE/GMAT'], ['college_in_mind','Colleges in mind'],
  ];

  const rows = DISPLAY_FIELDS.map(([key, label]) => {
    const newVal = updates[key];
    const oldVal = activeStudent?.[key];
    if (!newVal && !oldVal) return '';

    const displayNew = Array.isArray(newVal) ? newVal.join(', ') : newVal;
    const displayOld = Array.isArray(oldVal) ? oldVal.join(', ') : oldVal;
    const isNew = newVal && (!oldVal || String(displayNew) !== String(displayOld));

    return `
      <div class="extracted-field-row">
        <span class="ef-label">${label}</span>
        <div class="ef-value-wrap">
          ${newVal ? `<span class="ef-value${isNew ? ' is-new' : ''}" contenteditable="true" data-field="${key}">${escapeHtml(String(displayNew))}</span>` :
                     `<span class="ef-value">${escapeHtml(String(displayOld))}</span>`}
          ${isNew && displayOld ? `<span class="ef-old-value">${escapeHtml(String(displayOld))}</span>` : ''}
        </div>
      </div>
    `;
  }).filter(Boolean);

  extractedFields.innerHTML = rows.join('') || '<div style="color:var(--text-3);font-size:12px">No fields extracted</div>';
}

function renderOpenItems(questions, commitments) {
  openQuestions.innerHTML = questions.length ? `
    <div class="open-items-section-label">Open Questions</div>
    ${questions.map(q => `
      <div class="open-item-row">
        <input type="checkbox" />
        <span class="open-item-text">${escapeHtml(q)}</span>
      </div>
    `).join('')}
  ` : '';

  counsellorCommitments.innerHTML = commitments.length ? `
    <div class="open-items-section-label">Counsellor Commitments</div>
    ${commitments.map(c => `
      <div class="open-item-row">
        <input type="checkbox" />
        <span class="open-item-text">${escapeHtml(c)}</span>
      </div>
    `).join('')}
  ` : '';
}

// ── Report generation ──────────────────────────────────────────────────────────
generateReportBtn.addEventListener('click', async () => {
  generateReportBtn.textContent = '⟳ Generating...';
  generateReportBtn.disabled = true;

  const fullTranscript = transcriptBuffer.map(b => `${b.speaker === 'you' ? 'Counsellor' : 'Student'}: ${b.text}`).join('\n');
  const duration = postDuration.textContent;

  try {
    const response = await fetch(`${BACKEND_URL}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: fullTranscript,
        checklist_state: '',
        pinned_nudges: [],
        theme_id: 'counselling',
        theme_goal: getCounsellingTheme().goal.statement,
        duration,
        goal_achieved: false,
      }),
    });

    if (!response.body) throw new Error('No response body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    reportContent.textContent = '';
    reportOutput.classList.remove('hidden');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.text) { fullText += parsed.text; reportContent.textContent = fullText; }
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    reportContent.textContent = `Error: ${e.message}`;
    reportOutput.classList.remove('hidden');
  }

  generateReportBtn.textContent = 'Generate report';
  generateReportBtn.disabled = false;
});

// ── Save to Notion ─────────────────────────────────────────────────────────────
saveNotionBtn.addEventListener('click', async () => {
  if (!notionApiKey || !activeStudentPageId) {
    notionSaveStatus.textContent = !notionApiKey
      ? 'Configure Notion API key in Settings'
      : 'No student selected — cannot save';
    notionSaveStatus.style.color = 'var(--c-profile)';
    notionSaveStatus.classList.remove('hidden');
    return;
  }

  saveNotionBtn.disabled = true;
  saveNotionBtn.textContent = 'Saving...';
  notionSaveStatus.classList.add('hidden');

  try {
    // Gather extracted field values (support inline edits via contenteditable)
    const profileUpdates = {};
    extractedFields.querySelectorAll('[contenteditable][data-field]').forEach(el => {
      const key = el.dataset.field;
      const val = el.textContent.trim();
      if (val) {
        profileUpdates[key] = key === 'country' ? val.split(',').map(s => s.trim()) : val;
      }
    });

    // Qualitative
    profileUpdates.profile_summary       = qProfileSummary.value.trim();
    profileUpdates.motivation            = qMotivation.value.trim();
    profileUpdates.constraints           = qConstraints.value.trim();
    profileUpdates.emotional_notes       = qEmotionalNotes.value.trim();
    profileUpdates.last_call_summary     = reportContent.textContent.trim().slice(0, 500) || '';

    // Collect open items
    const openQs   = Array.from(openQuestions.querySelectorAll('.open-item-text')).map(el => el.textContent);
    const commits  = Array.from(counsellorCommitments.querySelectorAll('.open-item-text')).map(el => el.textContent);
    if (openQs.length)  profileUpdates.open_questions        = openQs.join('\n');
    if (commits.length) profileUpdates.counsellor_commitments = commits.join('\n');

    const newLeadStatus = leadStatusSelect.value;

    // Update profile properties
    await NotionSync.updateStudentProfile(activeStudentPageId, profileUpdates, notionApiKey, true, newLeadStatus);

    // Append call history to page body
    const callNum = (activeStudent?.call_count || 0) + 1;
    const today = new Date().toISOString().slice(0, 10);
    const duration = postDuration.textContent || '';
    const reportMd = reportContent.textContent || 'No report generated.';

    await NotionSync.appendCallHistory(
      activeStudentPageId, callNum, duration, today, reportMd,
      { open_questions: openQs, counsellor_commitments: commits },
      notionApiKey
    );

    notionSaveStatus.textContent = '✓ Saved to Notion';
    notionSaveStatus.style.color = 'var(--c-script)';
    notionSaveStatus.classList.remove('hidden');
    saveNotionBtn.textContent = '✓ Saved';
  } catch (e) {
    notionSaveStatus.textContent = `Save failed: ${e.message}`;
    notionSaveStatus.style.color = 'var(--c-profile)';
    notionSaveStatus.classList.remove('hidden');
    saveNotionBtn.textContent = 'Save to Notion';
    saveNotionBtn.disabled = false;
  }
});

// ── New call ───────────────────────────────────────────────────────────────────
newCallBtn.addEventListener('click', () => {
  activeNudge = null;
  queuedNudges = [];
  transcriptBuffer = [];
  extractionData = null;
  headerTitle.textContent = 'Counsellor Assistant';
  resetFieldState();
  initScriptState();
  setAppState('pre-call');
  renderFieldPills();
  renderScriptTracker();
});

// ── Utility ────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ───────────────────────────────────────────────────────────────────────
init();
