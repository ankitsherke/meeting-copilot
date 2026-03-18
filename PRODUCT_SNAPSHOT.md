# Meeting Copilot — Product Snapshot

> Status: Working POC · Last updated: 2026-03-18

---

## What It Is

A Chrome Extension + Python backend that acts as a real-time AI assistant during live meetings. It listens to tab audio (Google Meet, YouTube, any browser tab), transcribes speech live, detects questions, and surfaces grounded answers in a side panel — sourced from your own knowledge base, with an LLM fallback for anything not in the KB.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension                      │
│                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Side     │◄──►│  Background  │◄──►│   Offscreen   │  │
│  │ Panel    │    │ Service      │    │   Document    │  │
│  │ (UI)     │    │ Worker       │    │ (audio capture│  │
│  └────┬─────┘    └──────────────┘    │  + Deepgram)  │  │
│       │                              └───────────────┘  │
│       │ fetch (SSE)                                     │
└───────┼─────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────┐
│     FastAPI Backend           │
│  POST /query                  │
│  ┌──────────┐ ┌───────────┐  │
│  │ ChromaDB │ │ OpenAI    │  │
│  │ (vector  │ │ GPT-4o-   │  │
│  │  search) │ │ mini      │  │
│  └──────────┘ └───────────┘  │
└──────────────────────────────┘
        │
        ▼
   Deepgram API (WebSocket STT)
```

---

## File Structure

```
/
├── extension/
│   ├── manifest.json          Chrome MV3 manifest
│   ├── background.js          Service worker — orchestration hub
│   ├── offscreen.html         Minimal shell for offscreen document
│   ├── offscreen.js           Audio capture + Deepgram WebSocket
│   ├── audio-processor.js     AudioWorklet — Float32→Int16 PCM
│   ├── sidepanel.html         Side panel markup
│   ├── sidepanel.js           Side panel logic
│   └── sidepanel.css          Side panel styles
│
└── backend/
    ├── server.py              FastAPI app (single file)
    ├── seed_kb.py             KB ingestion script
    ├── requirements.txt       Python dependencies
    ├── .env                   API keys (not committed)
    ├── .env.example           Key template
    ├── chroma_db/             Persisted vector store (auto-generated)
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
- Host permissions: `meet.google.com`, `localhost:8000`, `https://*/*`
- Side panel opens on extension icon click

---

### 2. Background Service Worker — `background.js`

The central message bus. Responsibilities:

| Task | Detail |
|------|--------|
| Start capture | Gets Deepgram key from storage → creates offscreen doc → waits 300ms → fetches `streamId` → sends to offscreen |
| Stop capture | Sends stop to offscreen, clears keepalive |
| Message relay | Forwards TRANSCRIPT / STATUS / SUGGESTION from offscreen → side panel |
| Keepalive | Pings offscreen every 25s to prevent Chrome killing it after 30s |

**Critical ordering**: offscreen doc is created *before* `getMediaStreamId()` is called, because `streamId` expires in ~1-2 seconds.

---

### 3. Offscreen Document — `offscreen.js` + `audio-processor.js`

Runs in a hidden page that can access `getUserMedia`.

**Audio pipeline:**
```
Tab audio stream
  → AudioContext (native sample rate, typically 48kHz)
    → MediaStreamSource
      ├── → AudioContext.destination   (keeps tab audio audible)
      └── → AudioWorkletNode (pcm-processor)
              → MediaStreamDestination (silent, keeps worklet alive)
              → port.onmessage → Float32 converted to Int16 PCM
                → Deepgram WebSocket
```

**AudioWorklet (`audio-processor.js`):**
- Runs off the main thread
- Converts `Float32Array` [-1, 1] → `Int16Array` [-32768, 32767]
- Zero-copy transfer via `postMessage(buffer, [buffer])`

**Deepgram WebSocket auth:**
```js
new WebSocket(url, ['token', DEEPGRAM_API_KEY])
```
Uses `Sec-WebSocket-Protocol` header — the only header browsers allow on WebSocket connections. The `?token=` URL param approach is rejected by Deepgram.

**Deepgram parameters:** `nova-2` model, `linear16` encoding, native sample rate, mono, `smart_format=true`, `interim_results=true`

---

### 4. Side Panel — `sidepanel.js` + `sidepanel.html` + `sidepanel.css`

**UI sections:**
- Header: app name + status dot (gray/green/red) + recording timer
- Start / Stop buttons + "Help Me Respond" manual trigger
- API key setup panel (saved to `chrome.storage.local`)
- Live Transcript area (interim text in gray, final in black, auto-scroll)
- Suggested Response card (streaming token-by-token display, copy button, source attribution)
- History panel (last 10 suggestions, collapsible)

**Question auto-detection logic:**
1. Final transcript segment arrives from Deepgram
2. Check: ends with `?` OR starts with interrogative (`what|how|when|where|why|who|which|can|could|do|does|did|is|are|was|were|will|would|should|shall`)
3. Debounce: 3s between consecutive queries
4. Fire `POST /query` with last 60s of transcript + detected question

**Duplicate message fix:** The message listener filters out direct messages from `offscreen.html` — without this, every transcript arrives twice (once directly from offscreen, once relayed by background).

**Fallback display:** When the backend signals `fallback: true`, the source label shows "🌐 General Knowledge (not in KB)" in blue instead of the gray KB source filenames.

---

### 5. FastAPI Backend — `server.py`

Single-file FastAPI app. Runs at `http://localhost:8000`.

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Returns `{"status": "ok", "kb_chunks": N}` |
| `/query` | POST | RAG pipeline → streaming SSE response |

**`/query` request body:**
```json
{ "transcript": "last 60s of meeting text", "query": "the detected question" }
```

**RAG pipeline:**
1. Embed `query` with `text-embedding-3-small`
2. Query ChromaDB top-3 chunks by cosine similarity
3. **Relevance check**: if best match distance > `0.65` → KB not relevant
4. **KB path**: inject chunks as context → `SYSTEM_PROMPT` (strict, cite sources, KB only)
5. **Fallback path**: skip context → `FALLBACK_SYSTEM_PROMPT` (general knowledge allowed)
6. Stream `gpt-4o-mini` response as SSE (`text/event-stream`)
7. Final SSE event includes `sources`, `done: true`, `fallback: true/false`

**SSE event format:**
```
data: {"text": "token..."}
data: {"text": "token..."}
data: {"sources": ["scholarships.md"], "done": true, "fallback": false}
```

**System prompts:**
- `SYSTEM_PROMPT`: KB-grounded only. If context not relevant → "The knowledge base does not contain this information."
- `FALLBACK_SYSTEM_PROMPT`: General knowledge. 2-4 sentences. Direct, no hedging.

---

### 6. Knowledge Base — `seed_kb.py` + `docs/`

**Documents (study abroad domain):**
| File | Content |
|------|---------|
| `visa_requirements.md` | F-1, J-1, Schengen student visas — types, documents, deadlines |
| `universities.md` | Top study abroad universities — admission, costs, program deadlines |
| `scholarships.md` | Fulbright, Gilman, and other scholarships — amounts, eligibility, deadlines |

**Ingestion pipeline:**
- Reads `.md`, `.txt`, `.pdf` (PyMuPDF), `.docx` (python-docx)
- Chunks by paragraph boundaries with ~400 token target + 50 token overlap
- Embeds with `text-embedding-3-small` in batches of 20
- Stores in ChromaDB with `hnsw:space=cosine` metric
- Metadata per chunk: `{source: filename, chunk_index: N, total_chunks: N}`

Run once: `python seed_kb.py`

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Browser extension | Chrome MV3, vanilla JS |
| Audio capture | Web Audio API + AudioWorklet |
| Speech-to-text | Deepgram nova-2 (streaming WebSocket) |
| Vector store | ChromaDB (local persistent, cosine similarity) |
| Embeddings | OpenAI `text-embedding-3-small` |
| LLM | OpenAI `gpt-4o-mini` (streaming, max 200 tokens) |
| Backend | FastAPI + uvicorn |
| Frontend | Vanilla JS, no framework |

---

## API Keys Required

| Key | Used for | Where stored |
|-----|----------|-------------|
| `DEEPGRAM_API_KEY` | WebSocket STT | `chrome.storage.local` (entered in UI) |
| `OPENAI_API_KEY` | Embeddings + GPT-4o-mini | `backend/.env` |

---

## Known Limitations / Next Steps

| Issue | Status |
|-------|--------|
| KB threshold (0.65) may need tuning per domain | Working, not yet validated across domains |
| Study abroad docs are sample data — swap for real company docs | Ready to swap (drop files in `docs/`, re-run `seed_kb.py`) |
| No microphone capture — tab audio only | By design (captures what's in the meeting) |
| Deepgram key entered in UI is not encrypted | Acceptable for POC |
| No auth on backend `/query` endpoint | Acceptable for local-only POC |
| Max 200 tokens per suggestion | Tunable via `max_tokens` in `server.py` |

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
# Chrome → chrome://extensions → Developer mode → Load unpacked → select /extension folder
```

**Verify:**
```bash
curl http://localhost:8000/health
# → {"status":"ok","kb_chunks":15}

curl -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{"transcript":"","query":"What scholarships are available for study abroad?"}'
# → streaming SSE with GPT-4o-mini response citing scholarships.md
```
