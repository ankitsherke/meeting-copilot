# Meeting Copilot — Product Snapshot

> Status: Working POC · Last updated: 2026-03-19

---

## What It Is

A Chrome/Dia Extension + Python backend that acts as a real-time AI assistant during live meetings. It listens to both tab audio (guest speaker) and your microphone (you), transcribes both streams live with speaker labels, detects questions, and surfaces grounded answers in a side panel — sourced from your own knowledge base, with an LLM fallback for anything not in the KB. Includes pre-meeting briefing generation and dynamic in-meeting nudges.

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
        │   FastAPI Backend (Vercel)    │
        │  POST /query  (RAG + SSE)    │
        │  POST /brief  (briefing)     │
        │  POST /nudge  (coaching)     │
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
│   ├── sidepanel.html             Side panel markup
│   ├── sidepanel.js               Side panel logic (all audio capture + UI)
│   └── sidepanel.css              Side panel styles
│
└── backend/
    ├── server.py                  FastAPI app — /query, /brief, /nudge
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

### 3. Side Panel — `sidepanel.js` + `sidepanel.html` + `sidepanel.css`

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
4. Fire `POST /query` with last 60s of transcript + detected question

**Fallback display:** When backend signals `fallback: true`, source label shows "🌐 General Knowledge (not in KB)" in blue.

**UI sections:**
- Header: app name + status dot (gray/green/red/recording pulse) + timer
- Controls: Start / Stop / "Help Me Respond" manual trigger
- API key setup (saved to `chrome.storage.local`)
- Mic permission banner (shown if mic access fails)
- Meeting Prep section (collapsible): agenda input + Generate Brief button
- Nudges section: live coaching cards with dismiss
- Live Transcript (split You/Guest bubbles, auto-scroll)
- Suggested Response card (streaming tokens, copy button, source label)
- History panel (last 10 suggestions, collapsible)

---

### 4. Pre-Meeting Briefing — `/brief` endpoint

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

**Agenda checklist:**
- Rendered from `agenda_items` in the brief response
- Auto-checked during meeting: ≥2 keywords from an item's `keywords` array must appear in a final transcript segment
- Manual toggle supported
- Coverage time recorded and displayed (e.g. `03:42`)

---

### 5. Dynamic Nudges — `/nudge` endpoint

**Trigger:** Every 50 seconds during active recording (if agenda was generated), and on manual agenda coverage changes.

**Backend flow:**
1. Takes last 2 minutes of transcript + uncovered agenda items + already-shown nudges (to avoid repeats)
2. Embeds transcript → KB search for relevant context
3. GPT-4o-mini returns 2-3 typed nudges:

| Type | Icon | Meaning |
|------|------|---------|
| `agenda_gap` | 🎯 | Suggest raising an uncovered agenda topic |
| `talking_point` | 💡 | Surface a relevant KB fact |
| `steer` | 🔄 | Suggest redirecting off-track conversation |

**Dismiss:** Each nudge card has an × button. Dismissed nudge text is sent as `current_nudges` to the next `/nudge` call so the LLM doesn't repeat it.

---

### 6. FastAPI Backend — `server.py`

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | `{"status": "ok", "kb_chunks": N}` |
| `/query` | POST | RAG pipeline → streaming SSE |
| `/brief` | POST | Agenda briefing → JSON |
| `/nudge` | POST | In-meeting nudges → JSON |

**RAG pipeline (`/query`):**
1. Embed `query` with `text-embedding-3-small`
2. Query ChromaDB top-3 chunks (cosine similarity)
3. Relevance check: `best_distance < 0.65` → KB relevant
4. **KB path**: chunks as context → `SYSTEM_PROMPT` (strict, cite sources)
5. **Fallback path**: no context → `FALLBACK_SYSTEM_PROMPT` (general LLM)
6. Stream `gpt-4o-mini` as SSE, `max_tokens=200`, `temperature=0.3`
7. Final event: `{"sources": [...], "done": true, "fallback": bool}`

**Vercel compatibility:**
- `IS_VERCEL = bool(os.getenv("VERCEL"))`
- On cold start: `shutil.copytree(chroma_source, '/tmp/chroma_db')` (Vercel filesystem is read-only except `/tmp`)
- `PersistentClient` uses `/tmp/chroma_db` on Vercel, `./chroma_db` locally

---

### 7. Knowledge Base — `seed_kb.py` + `docs/`

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
| LLM | OpenAI `gpt-4o-mini` (streaming SSE, max 200 tokens) |
| Backend | FastAPI + uvicorn |
| Hosting | Vercel (backend) + GitHub |
| Frontend | Vanilla JS, no framework |

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
DEEPGRAM_API_KEY=...
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
| `DEEPGRAM_API_KEY` | WebSocket STT (both audio streams) | `chrome.storage.local` (entered in extension UI) |
| `OPENAI_API_KEY` | Embeddings + GPT-4o-mini | Vercel environment variable |

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
# Enter Deepgram API key in the extension UI → click Start
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
