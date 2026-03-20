# Meeting Copilot — Product Snapshot

> Status: Working POC · Last updated: 2026-03-20

---

## What It Is

A Chrome/Dia Extension + Python backend that acts as a real-time AI copilot during live meetings. It listens to both tab audio (guest) and your microphone (you), transcribes both streams live with speaker labels, surfaces grounded KB answers in a side panel, and provides real-time coaching nudges based on meeting type. Includes pre-meeting briefing, agenda checklist, post-meeting report generation, cross-meeting guest context, and Notion sync.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension                      │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │                  Side Panel (UI)                  │   │
│  │                                                   │   │
│  │  Tab capture pipeline (guest speaker):            │   │
│  │    getUserMedia(chromeMediaSource) →              │   │
│  │    AudioWorklet → Deepgram WS → TRANSCRIPT        │   │
│  │                                                   │   │
│  │  Mic capture pipeline (you):                      │   │
│  │    getUserMedia(audio) →                          │   │
│  │    AudioWorklet → Deepgram WS → TRANSCRIPT        │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │ fetch (SSE)                        │
│  ┌──────────────────┘                                   │
│  │  Background Service Worker                           │
│  │    tabCapture.getMediaStreamId → returns streamId    │
│  │    chrome.scripting.executeScript (mic iframe)       │
│  └──────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │   FastAPI Backend (Vercel)   │
        │  POST /query  (RAG + SSE)   │
        │  POST /brief  (briefing)    │
        │  POST /nudge  (coaching)    │
        │  POST /report (SSE report)  │
        │  ┌──────────┐ ┌───────────┐  │
        │  │ ChromaDB │ │ OpenAI    │  │
        │  │ (cosine  │ │ GPT-4o-   │  │
        │  │  search) │ │ mini      │  │
        │  └──────────┘ └───────────┘  │
        └──────────────────────────────┘
                       │
                       ▼
          Deepgram API (WebSocket STT)
            Two connections per session:
            one for tab audio (guest)
            one for mic audio (you)
```

---

## File Structure

```
/
├── .gitignore
├── vercel.json                    Vercel deployment config
├── PRODUCT_SNAPSHOT.md
│
├── extension/
│   ├── manifest.json              Chrome MV3 manifest
│   ├── background.js              Service worker — streamId + mic iframe injection
│   ├── offscreen.html             Minimal shell (legacy, unused for capture)
│   ├── offscreen.js               Legacy (tab capture moved to side panel)
│   ├── audio-processor.js         AudioWorklet — Float32→Int16 PCM
│   ├── request-mic-permission.html  Mic permission popup page
│   ├── request-mic-permission.js    Mic permission popup logic
│   ├── themes.js                  4 built-in meeting themes + getThemeById()
│   ├── nudge-engine.js            NudgeQueue — priority, suppression, decay
│   ├── guest-context.js           Cross-meeting guest profiles (chrome.storage)
│   ├── notion-sync.js             Notion API integration + retry queue
│   ├── sidepanel.html             Side panel markup
│   ├── sidepanel.js               Side panel logic (all audio capture + UI)
│   └── sidepanel.css              Side panel styles
│
└── backend/
    ├── server.py                  FastAPI app — /query, /brief, /nudge, /report
    ├── seed_kb.py                 KB ingestion script
    ├── requirements.txt           Python dependencies
    ├── .env                       API keys (not committed)
    ├── .env.example               Key template
    ├── chroma_db/                 Persisted vector store (committed for Vercel)
    └── docs/
        ├── visa_requirements.md
        ├── universities.md
        └── scholarships.md
```

---

## Component Deep-Dive

### 1. Chrome Extension — `manifest.json`

- Manifest V3
- Permissions: `tabCapture`, `offscreen`, `sidePanel`, `activeTab`, `tabs`, `storage`, `scripting`
- `web_accessible_resources`: `request-mic-permission.html`, `request-mic-permission.js`
- Host permissions: `meet.google.com`, `localhost:8000`, `https://*/*`
- Side panel opens on extension icon click

---

### 2. Background Service Worker — `background.js`

Lightweight — only handles two jobs:

| Message | Action |
|---------|--------|
| `START_CAPTURE` | Calls `chrome.tabCapture.getMediaStreamId({targetTabId})` → returns `streamId` + stored Deepgram key |
| `STOP_CAPTURE` | Clears `recordingTabId` |
| `INJECT_MIC_IFRAME` | Uses `chrome.scripting.executeScript` to inject a hidden iframe into the active tab for mic permission (fallback flow) |

**Why background doesn't handle audio**: All audio capture runs in the side panel (a visible page), so `AudioContext.destination` routes to real speakers and `getUserMedia` prompts work correctly in Dia browser.

---

### 3. Theme Engine — `themes.js`

4 built-in meeting types, each defining:

| Field | Description |
|-------|-------------|
| `goal` | Meeting goal statement + success signals |
| `persona` | AI role, tone, output style, constraints |
| `checklist` | 6 items with `autoDetectPatterns`, `priority`, `nudgeIfMissedAfter` |
| `nudgeRules` | Enabled nudge types, custom trigger patterns, silence threshold, closing cue % |

**Built-in themes:**

| ID | Name | Use case |
|----|------|----------|
| `counselling` | Counselling | Study abroad advisor sessions |
| `sales_close` | Sales / Close | B2B sales calls |
| `negotiation` | Negotiation | Contract / deal negotiations |
| `internal_sync` | Internal Sync | Team standups and planning meetings |

Theme is selected pre-meeting via pill buttons and persisted to `chrome.storage.local`. Hidden during recording.

---

### 4. Nudge Engine — `nudge-engine.js`

`NudgeQueue` class manages all in-meeting coaching nudges with priority, suppression, and decay.

**Priority tiers:**

| Priority | Types |
|----------|-------|
| P4 (highest) | `closing_cue`, `checklist_reminder` |
| P3 | `kb_answer`, `objection_handler` |
| P2 | `context_recall`, `sentiment_shift`, `goal_drift_alert` |
| P1 (lowest) | `silence_prompt` |

**Suppression rules:**
- Global cooldown: max 1 nudge per 45s
- Per-type cooldown: 3 min after display
- After dismiss: 10 min suppression
- 3 consecutive dismissals of same type → disabled for session
- Candidates decay after 60s in queue if not shown

**Local detectors (run in sidepanel.js):**

| Detector | Trigger |
|----------|---------|
| `checkObjectionPatterns` | Regex match on `nudgeRules.customTriggers` against guest transcript |
| `startSilenceDetector` | Speech gap > `silenceThresholdSec` with user spoke recently |
| `checkChecklistReminders` | Time-based % threshold per checklist item |
| `checkClosingCue` | Fires once when elapsed% ≥ `closingCueAtPercent` |
| `refreshNudges` (backend) | POST /nudge every 60s for context-aware nudges |

**Nudge card UI:** type badge (color-coded), pin button, Edit & Copy (contenteditable), dismiss with suppression tracking.

---

### 5. Side Panel — `sidepanel.js` + `sidepanel.html` + `sidepanel.css`

The side panel owns all audio pipelines and UI. It is a visible page, which enables:
- `AudioContext.destination` → real speaker output (tab audio audible while recording)
- `getUserMedia` → mic permission prompt works in Dia

**Tab capture pipeline (guest speaker):**
```
background returns streamId
  → getUserMedia({chromeMediaSource: 'tab', chromeMediaSourceId: streamId})
  → AudioContext (native sample rate)
    → MediaStreamSource
      ├── → AudioContext.destination   (tab audio remains audible)
      └── → AudioWorkletNode (pcm-processor)
              → Deepgram WebSocket ['token', key]
                → onmessage → handleTranscript(text, isFinal, 'guest')
```

**Mic capture pipeline (you):**
```
getUserMedia({audio: true})
  → AudioContext
    → AudioWorkletNode (pcm-processor)
      → Deepgram WebSocket ['token', key]   (separate connection)
        → onmessage → handleTranscript(text, isFinal, 'you')
```

**AudioWorklet (`audio-processor.js`):**
- Runs off the main thread
- Converts `Float32Array` [-1, 1] → `Int16Array` [-32768, 32767]
- Zero-copy transfer via `postMessage(buffer, [buffer])`

**Deepgram WebSocket auth:**
```js
new WebSocket(url, ['token', DEEPGRAM_API_KEY])
```
Uses `Sec-WebSocket-Protocol` header — the only header browsers allow on WebSocket connections.

**Deepgram parameters:** `nova-2`, `linear16`, native sample rate, mono, `smart_format=true`, `interim_results=true`

**Split transcript UI:**
- `You` utterances: blue left border (`#e8f4fd` background)
- `Guest` utterances: gray left border (`#f3f4f6` background)
- Interim text shown in gray, finalized text in black
- Auto-scroll on every render

**Question auto-detection:**
1. Final transcript from `guest` stream arrives
2. Check: ends with `?` OR starts with interrogative (`what|how|when|where|why|who|which|can|could|do|does|did|is|are|was|were|will|would|should|shall`)
3. 3s debounce between consecutive queries
4. Fire `POST /query` with last 60s of transcript + detected question + `theme_persona`

**UI zones (during recording):**
- **Hero zone**: Active nudge cards (warm yellow, stacked)
- **Context zone**: Agenda checklist pills + live transcript
- **Response zone**: Suggested response (streaming) + suggestion history

**UI zones (pre-meeting):**
- Theme selector pills
- Guest name input with autocomplete
- Guest past context card (last 3 meetings)
- Agenda/notes textarea + Generate Brief button

**Post-meeting panel:** Duration / checklist score / nudges used stats, goal achieved checkbox, guest profile save, Generate Report button, Push to Notion button.

---

### 6. Guest Context Engine — `guest-context.js`

Stores cross-meeting guest profiles in `chrome.storage.local`.

**Profile schema:**
```js
{
  id: "john_doe",          // slugified name
  name: "John Doe",
  company: "Acme Corp",
  role: "VP Sales",
  meetings: [              // up to 20, oldest dropped
    {
      date: "2026-03-20",
      theme: "sales_close",
      duration: "00:45:00",
      goalAchieved: true,
      summary: "...",        // first 400 chars of report
      actionItems: [...],
      checklistScore: "5/6"
    }
  ]
}
```

**Flow:**
1. User types guest name in prep section → debounced search (300ms, min 2 chars)
2. Dropdown shows matching guests with last seen date + meeting count
3. On select: loads profile, renders last 3 meetings with dates/scores/open actions
4. After meeting: save row pre-fills guest name → creates/updates profile with meeting record

---

### 7. Pre-Meeting Briefing — `/brief` endpoint

**Trigger:** User pastes agenda → clicks "Generate Brief"

**Backend flow:**
1. Embed agenda text with `text-embedding-3-small`
2. Query ChromaDB top-4 chunks (filtered by relevance threshold)
3. Send to `gpt-4o-mini` with `response_format: json_object`
4. Returns structured JSON:

```json
{
  "key_facts": ["fact 1", "fact 2", ...],
  "likely_questions": [{"q": "...", "a": "..."}],
  "agenda_items": [{"item": "...", "keywords": ["kw1", "kw2", ...]}]
}
```

---

### 8. Dynamic Nudges — `/nudge` endpoint

**Trigger:** Every 60s during active recording (first call delayed 30s).

**Request payload:**
```json
{
  "transcript": "...",
  "checklist_items": [{"id": "cl_01", "label": "...", "covered": false, "priority": "critical"}],
  "enabled_nudge_types": ["kb_answer", "objection_handler", ...],
  "theme_goal": "Help the student gain clarity...",
  "theme_persona": {"role": "...", "tone": "...", "outputStyle": "...", "constraints": [...]}
}
```

**Returns:** `{"nudges": [{"type": "<one of 8 types>", "text": "..."}]}`

Invalid types are stripped server-side before returning.

---

### 9. Post-Meeting Report — `/report` endpoint

**Trigger:** User clicks "Generate Meeting Report" in post-meeting panel.

**Request payload:**
```json
{
  "transcript": "...",
  "checklist_state": "[✓] Student profile confirmed (critical)\n[ ] Next step agreed (critical)",
  "pinned_nudges": [{"type": "closing_cue", "text": "..."}],
  "theme_id": "counselling",
  "theme_goal": "...",
  "duration": "00:32:15",
  "goal_achieved": true
}
```

**Returns:** Streaming SSE markdown report with sections:
- Meeting Summary
- Key Decisions & Commitments
- Action Items (owner + deadline format)
- What Went Well
- Areas to Improve
- Follow-Up Questions

After report is generated, a "Push to Notion" button appears (if Notion is configured).

---

### 10. Notion Sync — `notion-sync.js`

Pushes post-meeting reports to a Notion database.

**Setup flow:**
1. Open Settings (⚙ in header) → enter Notion integration token → Test connection
2. Enter database ID or click "Auto-create DB" (requires a parent page ID)
3. After report is generated → "Push to Notion" button appears

**Notion page properties created:**

| Property | Type |
|----------|------|
| Name | title — "Meeting with [Guest] — [Date]" |
| Date | date |
| Theme | select |
| Duration | rich_text |
| Guest | rich_text |
| Goal Achieved | checkbox |
| Checklist Score | rich_text |

Report body is converted from markdown to Notion blocks (headings, bullets, paragraphs, max 100 blocks).

**Retry queue:** Failed pushes stored in `chrome.storage.local` under `notionRetryQueue`. Retried automatically on next panel open (up to 5 attempts per item).

---

### 11. FastAPI Backend — `server.py`

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | `{"status": "ok", "kb_chunks": N}` |
| `/query` | POST | RAG pipeline → streaming SSE (theme-aware) |
| `/brief` | POST | Agenda briefing → JSON |
| `/nudge` | POST | 8-type in-meeting nudges → JSON |
| `/report` | POST | Post-meeting report → streaming SSE |

**RAG pipeline (`/query`):**
1. Embed `query` with `text-embedding-3-small`
2. Query ChromaDB top-3 chunks (cosine similarity)
3. Relevance check: `best_distance < 0.65` → KB relevant
4. **KB path**: chunks as context → `SYSTEM_PROMPT` + theme persona suffix
5. **Fallback path**: no context → `FALLBACK_SYSTEM_PROMPT` + theme persona suffix
6. Stream `gpt-4o-mini` as SSE, `max_tokens=200`, `temperature=0.3`
7. Final event: `{"sources": [...], "done": true, "fallback": bool}`

**Vercel compatibility:**
- `IS_VERCEL = bool(os.getenv("VERCEL"))`
- On cold start: `shutil.copytree(chroma_source, '/tmp/chroma_db')` (Vercel filesystem is read-only except `/tmp`)
- `PersistentClient` uses `/tmp/chroma_db` on Vercel, `./chroma_db` locally

---

### 12. Knowledge Base — `seed_kb.py` + `docs/`

**Sample documents (study abroad domain):**
| File | Content |
|------|---------|
| `visa_requirements.md` | F-1, J-1, Schengen student visas — types, documents, deadlines |
| `universities.md` | Top study abroad universities — admission, costs, program deadlines |
| `scholarships.md` | Fulbright, Gilman, and other scholarships — amounts, eligibility, deadlines |

**Ingestion pipeline:**
- Reads `.md`, `.txt`, `.pdf` (PyMuPDF), `.docx` (python-docx)
- Chunks by paragraph boundaries (~400 token target + 50 token overlap)
- Embeds with `text-embedding-3-small` in batches of 20
- Stores in ChromaDB with `hnsw:space=cosine` metric
- Metadata: `{source: filename, chunk_index: N, total_chunks: N}`

Run once: `python seed_kb.py`

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Browser extension | Chrome/Dia MV3, vanilla JS |
| Audio capture | Web Audio API + AudioWorklet (two independent pipelines) |
| Speech-to-text | Deepgram nova-2 (streaming WebSocket, dual connections) |
| Vector store | ChromaDB (cosine similarity, persisted) |
| Embeddings | OpenAI `text-embedding-3-small` |
| LLM | OpenAI `gpt-4o-mini` (streaming SSE) |
| Backend | FastAPI + uvicorn |
| Hosting | Vercel (backend) + GitHub |
| Frontend | Vanilla JS, no framework |
| External integrations | Notion API, Deepgram API |

---

## Deployment

| Component | Where | URL |
|-----------|-------|-----|
| Backend API | Vercel | `https://meeting-copilot-iota.vercel.app` |
| Source code | GitHub | `github.com/ankitsherke/meeting-copilot` |
| Extension | Load unpacked (Chrome/Dia) | — |

**Environment variables (set in Vercel dashboard):**
```
OPENAI_API_KEY=sk-...
```

**Verify live backend:**
```bash
curl https://meeting-copilot-iota.vercel.app/health
# → {"status":"ok","kb_chunks":15}
```

---

## API Keys

| Key | Used for | Where stored |
|-----|----------|-------------|
| `DEEPGRAM_API_KEY` | WebSocket STT (both audio streams) | `chrome.storage.local` (entered in Settings panel) |
| `OPENAI_API_KEY` | Embeddings + GPT-4o-mini | Vercel environment variable |
| `NOTION_TOKEN` | Push reports to Notion | `chrome.storage.local` (entered in Settings panel) |

---

## Running Locally

```bash
# Backend
cd backend
pip install -r requirements.txt
cp .env.example .env          # fill in API keys
python seed_kb.py             # seed knowledge base (run once)
uvicorn server:app --reload --port 8000

# Extension
# Chrome/Dia → chrome://extensions → Developer mode → Load unpacked → select /extension
# Open Settings (⚙) → enter Deepgram API key → click Start
```

**Swap in your own docs:** Drop any `.md`, `.pdf`, or `.docx` files into `backend/docs/`, re-run `python seed_kb.py`, redeploy.

---

## Known Limitations / Next Steps

| Item | Notes |
|------|-------|
| KB threshold (0.65) may need tuning per domain | Tune `KB_RELEVANCE_THRESHOLD` in `server.py` |
| Sample docs are study-abroad domain | Swap for real company docs — no code changes needed |
| Deepgram key stored in `chrome.storage.local` unencrypted | Acceptable for POC |
| No auth on backend endpoints | Add API key middleware before production use |
| Mic access in Chrome requires popup workaround | Works natively in Dia browser |
| Extension loaded unpacked (not published to Chrome Web Store) | Submit to store for broader distribution |
| ChromaDB cold-start copy on Vercel (~1s overhead) | Move to Railway/Render for always-warm server |
| Phase 4 (Analytics) not yet built | Host performance tracking, adaptive nudge tuning |
