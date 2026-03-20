# Counsellor Assistant — Product Snapshot

> Leap Scholar Hackathon · March 2026
> Status: In build · Last updated: 2026-03-20

---

## What It Is

A Chrome extension that acts as a real-time AI assistant for Leap Scholar counsellors during student counselling calls. It reads student context from Notion before the call, provides live intelligence during the call (profile flags, KB answers, script guidance, field extraction), and writes structured + qualitative data back to Notion after the call.

**The tagline:** "The co-pilot captures what was asked. We capture what was said."

**The reframe:** Built on the Meeting Copilot codebase. Notion replaces guest-context.js as the bidirectional student database. The theme engine strips to a single counselling config. Separate nudge cards and suggested response zones merge into one unified Assist Card.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension                          │
│                                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │               Side Panel (3-state UI)                  │ │
│  │                                                        │ │
│  │  PRE-CALL:  Notion search → student brief card         │ │
│  │  IN-CALL:   Assist card + field tracker + transcript   │ │
│  │  POST-CALL: Extraction review → Notion write-back      │ │
│  │                                                        │ │
│  │  Tab audio → Deepgram WS → guest transcript            │ │
│  │  Mic audio → Deepgram WS → counsellor transcript       │ │
│  └──────────┬─────────────────────────────────────────────┘ │
│             │ fetch (SSE + JSON)                            │
│  ┌──────────┘                                              │
│  │  notion-sync.js ←→ Notion API (direct, no backend)     │
│  │  background.js (tab capture, mic injection — unchanged) │
│  └─────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────┐
        │   FastAPI Backend (Vercel)        │
        │                                  │
        │  POST /query   (KB + student ctx)│
        │  POST /nudge   (nudges + fields) │
        │  POST /extract (post-call)       │
        │  POST /report  (SSE report)      │
        │  POST /brief   (pre-call brief)  │
        │                                  │
        │  ChromaDB (cosine) + OpenAI      │
        └──────────────────────────────────┘
                       │
                       ▼
          Deepgram API (WebSocket STT)
          Notion API (direct from extension)
```

### Key architectural decisions

- **Notion calls are client-side** — CORS-friendly with integration tokens, no backend proxy needed
- **Backend is stateless** — every `/nudge`, `/query`, `/extract` call includes full student context; backend never queries Notion
- **Single theme** — theme engine stripped to one hardcoded counselling configuration, no selector UI
- **Audio pipelines unchanged** — tab + mic capture via Deepgram WebSocket stays exactly as-is

---

## File Structure

```
/
├── vercel.json
├── PRODUCT_SNAPSHOT.md
│
├── extension/
│   ├── manifest.json              Updated: name + notion host_permissions
│   ├── background.js              Unchanged
│   ├── audio-processor.js         Unchanged
│   ├── request-mic-permission.*   Unchanged
│   ├── offscreen.*                Legacy, unused
│   ├── themes.js                  Stripped to single counselling theme + script moments
│   ├── nudge-engine.js            Updated: 5 new types, assist card render target
│   ├── notion-sync.js             Rewritten: search/read/update/append student records
│   ├── sidepanel.html             Rewritten: 3-state layout
│   ├── sidepanel.js               Rewritten: all state logic + Notion integration
│   └── sidepanel.css              Rewritten: assist card, pills, script dots, extraction card
│
├── backend/
│   ├── server.py                  Updated: /extract new, /nudge + /query modified
│   ├── seed_kb.py                 Unchanged (re-run with new docs)
│   ├── requirements.txt           Unchanged
│   ├── seed_notion.py             New: creates DB schema + seeds 5 student profiles
│   └── docs/
│       └── leap_kb.md             New: consolidated Leap KB (replaces 3 old docs)
│
└── [deleted]
    ├── guest-context.js           Replaced by Notion
    ├── docs/visa_requirements.md
    ├── docs/universities.md
    └── docs/scholarships.md
```

---

## Notion Data Model

**Database name:** `Leap Counsellor — Students`

One row per student. The extension reads before the call and writes after.

### Property schema

**Identity + source** (pre-populated when lead arrives):

| Property | Type | Example |
|----------|------|---------|
| Name | Title | Samiraj Pawar |
| Phone | Phone | +91-98765-43210 |
| Email | Email | samiraj@gmail.com |
| Source Platform | Select | Google Ads / Instagram / Referral / Walk-in / Organic |
| Source Campaign | Rich text | "UK Masters 2026" |
| Initial Interest | Rich text | "Masters in Design, UK" |
| Counsellor | Select | Shruti Jain |
| Lead Status | Select | New / Call 1 Done / Call 2 Done / Applied / Enrolled |
| Call Count | Number | 0 |

**Shortlist fields** (captured during calls):

| Property | Type | Required for shortlist |
|----------|------|----------------------|
| Country | Multi-select | Required |
| Intake | Select | Required |
| Budget | Rich text | Required |
| Preferred Course | Rich text | Required |
| Preferred Degree | Select | Required |
| Preferred Location | Rich text | If present |
| Work Experience (months) | Number | If present |
| Backlog | Number | If present |
| IELTS Score | Rich text | If present |
| UG Score | Rich text | If present |
| UG Specialisation | Rich text | — |
| 12th Score | Rich text | — |
| GRE/GMAT Score | Rich text | If present |
| College in Mind | Rich text | If present |

**Qualitative context** (written post-call):

| Property | Type | Purpose |
|----------|------|---------|
| Profile Summary | Rich text | Who this student is |
| Motivation | Rich text | Student's own words on why they want to go |
| Constraints | Rich text | Family, financial, timeline, emotional |
| Open Questions | Rich text | Unanswered questions from the call |
| Counsellor Commitments | Rich text | Things the counsellor promised |
| Emotional Notes | Rich text | Signals for the next call |
| Last Call Summary | Rich text | Auto-generated brief |

**Call history** is appended to the page body (not properties) after each call:

```markdown
---
## Call 1 — 2026-03-20, 32:15
### Summary
[Auto-generated narrative]
### Fields captured
Country: Australia, UK | Budget: ₹40-50L | Course: MDes | ...
### Open items
- Check post-study work visa for <18 month programs
### Commitments
- Send shortlist by tonight
---
```

---

## UI — Three States

### State 1: Pre-call

1. Header: "Counsellor Assistant" + ⚙ settings
2. Student search input → Notion query → dropdown (name + source + lead status)
3. **Student brief card** on select: name, source badge, initial interest, call number
4. **Carry-forwards panel** (Call 2+ only, amber styling): open questions, commitments, emotional notes from last call as checkboxes
5. **Shortlist readiness bar**: N/5 required fields captured, missing fields listed
6. Start call button

### State 2: In-call

1. Recording header: red dot + elapsed timer + Stop button
2. **Assist card** — single most important action (see below)
3. **Field tracker** — pill wrap of shortlist fields (empty / auto-detected / confirmed)
4. **Script tracker** — vertical list of cheat sheet moments with status dots
5. **Transcript** — split counsellor/student bubbles, auto-scroll

### State 3: Post-call

1. Call complete header + duration + student name
2. **Extracted profile update card** — editable fields, amber border on new/changed, shows old→new for updated values
3. **Qualitative signals card** — editable motivation, constraints, emotional notes
4. **Open items card** — checkboxes for unanswered questions + counsellor commitments
5. **Profile summary** — editable narrative paragraph
6. Action buttons: **Save to Notion** / **Generate report** / **New call**

---

## Assist Card — Unified Suggestion Engine

Replaces the separate nudge cards and suggested response zones. One card at a time. Always includes a sentence the counsellor can say directly.

```
┌──────────────────────────────────────┐
│ [TYPE BADGE]                         │
│                                      │
│ [Explanation — what's happening]     │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ "Suggested thing to say"         │ │
│ └──────────────────────────────────┘ │
│                                      │
│ [Copy]  [Dismiss]                    │
└──────────────────────────────────────┘
```

### Type badges and priority

| P | Badge | Color | Trigger |
|---|-------|-------|---------|
| P1 | `Profile mismatch` | Red | Student's described background doesn't fit the course being discussed |
| P1 | `Intent divergence` | Red | Student expresses doubt while counsellor continues selling |
| P2 | `Emotional signal` | Amber | Student shares something emotionally significant |
| P3 | `KB answer` | Blue | Student asks a factual question → /query returns answer |
| P3 | `Outcome profile` | Blue | Student asks a trust-building question → anonymised outcome from KB |
| P4 | `Script nudge` | Green | Natural opening for a pending script moment, or gap warning |
| P5 | `Field gap` | Gray | Required fields missing past 60% of call duration |

### Behavior rules

- One active card at a time. Highest-priority card shows fully, others peek (badge only)
- KB answers interrupt any P3+ card immediately
- Dismiss → history (collapsible, not re-surfaced)
- 90-second cooldown per type after dismiss (P1 exempt)
- Auto-dismiss when script tracker detects a moment was covered
- Every card always has a "suggestion" sentence

---

## Field Tracker

Shortlist fields as interactive pills. Values extracted by LLM from transcript, not manually entered.

**Required (5):** Country, Intake, Budget, Course, Degree

**If present (7):** Location, Work exp, Backlogs, IELTS, UG score, GRE/GMAT, Colleges in mind

### Pill states

| State | Styling | Shows |
|-------|---------|-------|
| Empty | Gray outline | Field label only |
| Auto-detected | Amber (#FAEEDA / #FAC775) | Extracted value + "?" |
| Confirmed | Green (#EAF3DE / #97C459) | Confirmed value |

- Auto-detected values come from `/nudge` response `extracted_fields` (high/medium confidence only)
- Confirmed fields from Notion (Call 2+) load as confirmed on call start
- Counsellor click → inline edit → click away to confirm
- Confirmed values never overwritten by auto-detection

---

## Script Tracker

Monitors Leap cheat sheet moments. No linear enforcement — moments can be covered in any order.

### Script moments

**Section 1 — Rapport:**
`intro_self` / `intro_purpose` / `intro_state`

**Section 2 — Profiling:**
`profile_career` / `profile_validate` / `profile_params`

**Section 3 — Reaffirmation:**
`reaffirm_conviction` / `reaffirm_colleges` / `reaffirm_similar` / `reaffirm_questions`

**Section 4 — Close:**
`close_leap` / `close_app` / `close_schedule` / `close_contact`

### States
- ● Green: Covered
- ◐ Amber: In progress
- ○ Gray: Not yet covered

### Nudge triggers
- Natural opening for a pending moment detected in transcript
- Past 70% of expected duration, required moments still uncovered
- Approaching call end, close moments haven't happened

---

## Backend API Contracts

### `POST /query` — KB retrieval (modified)

Adds `student_context` to request. Injects student profile into system prompt for personalised, specific answers. Returns streaming SSE (unchanged format).

### `POST /nudge` — contextual nudges (modified)

**Request additions:** `student_context`, `script_state`, `call_elapsed_seconds`, `expected_call_duration_seconds`

**Response additions:**
```json
{
  "nudges": [{ "type": "profile_clarification", "priority": 1, "text": "...", "suggestion": "...", "reason": "..." }],
  "extracted_fields": {
    "budget": { "value": "₹40-50L", "confidence": "medium", "source_quote": "looking at 40-50 lakhs" }
  },
  "script_state_update": { "profile_career": "covered" }
}
```

**New nudge types:** `profile_clarification` (P1), `intent_divergence` (P1), `emotional_signal` (P2), `script_gap` (P4), `field_gap` (P5)

### `POST /extract` — post-call extraction (new)

Called once automatically when recording stops.

**Request:** full transcript + student_context (name, existing profile, call number)

**Response:**
```json
{
  "profile_updates": { "country": ["Australia", "UK"], "intake": "Sep 2026", "budget": "₹40-50L", ... },
  "qualitative": { "profile_summary": "...", "motivation": "...", "constraints": "...", "emotional_notes": "..." },
  "open_questions": ["Post-study work visa for <2yr programs", ...],
  "counsellor_commitments": ["Send shortlist by today", ...],
  "lead_status_suggestion": "Call 1 Done"
}
```

### `POST /report` — unchanged

Streaming SSE markdown report. After generation, appended to Notion page body as call history entry.

---

## Notion Integration — `notion-sync.js` (rewritten)

All Notion operations are client-side. Functions:

| Function | Notion API call | Purpose |
|----------|----------------|---------|
| `searchStudents(query)` | `POST /databases/{id}/query` | Fuzzy search by student name |
| `getStudentProfile(pageId)` | `GET /pages/{id}` + `GET /blocks/{id}/children` | Full profile + call history |
| `updateStudentProfile(pageId, updates)` | `PATCH /pages/{id}` | Write shortlist fields + qualitative + increment call count |
| `appendCallHistory(pageId, report)` | `PATCH /blocks/{id}/children` | Append call section to page body |
| `createStudent(profile)` | `POST /pages` | New student record (demo fallback) |

---

## Knowledge Base — `docs/leap_kb.md`

Single consolidated file replacing the three old docs. Sections:

1. **Country comparison** — AU, UK, IE, DE, UAE, CA, USA, SG: duration, post-study visa, cost range (INR), part-time work rules, PR pathway
2. **Course taxonomy** — maps non-standard student backgrounds (spatial design, culinary, fashion) to recognised course categories + known universities
3. **Outcome profiles** — 5 anonymised past students (design→AU, CS/DS→UAE, BCA→IE, culinary→AU, CS→USA elite)
4. **Visa and financial requirements** — Australia GTE rules, cost of living proof (₹16.5L), savings duration, sponsor/affidavit; UK CAS; Ireland; Germany blocked account
5. **Budget benchmarks** — tuition + living cost ranges per country per program duration in INR

Expected ~30-40 chunks after seeding.

---

## Seed Data — 5 Student Profiles

Pre-seeded in Notion via `seed_notion.py` before demo.

| # | Name | Profile | Failure mode tested |
|---|------|---------|-------------------|
| 1 | Samiraj Pawar | B.Des Fashion, 2yr spatial brand designer, fresh lead | Profile mismatch — spatial design ≠ event management |
| 2 | Yash Mudre | B.Tech Data Science, 7.9 CGPA, ISRO intern, 2yr UPSC gap, mother in hospital | Emotional constraint + time pressure not acknowledged |
| 3 | Jay Nagar | BCA, 5yr BPO, ₹30-35L budget but wants USA/Canada/AU | Budget-country mismatch not flagged |
| 4 | Lokesh Kumar | IT→culinary switcher, Call 1 Done, post-study visa unclear | Critical profile fact not known before call |
| 5 | Ranjana Krishnan | Final yr CS, targets CMU/Stanford, parents driving decision, student unsure | Unsure student pushed through funnel |

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Browser extension | Chrome MV3, vanilla JS |
| Audio capture | Web Audio API + AudioWorklet (two pipelines — unchanged) |
| Speech-to-text | Deepgram nova-2 (streaming WebSocket, dual connections) |
| Student database | Notion (bidirectional, client-side API calls) |
| Vector store | ChromaDB (cosine similarity) |
| Embeddings | OpenAI `text-embedding-3-small` |
| LLM | OpenAI `gpt-4o-mini` (streaming SSE) |
| Backend | FastAPI + uvicorn on Vercel |

---

## Deployment

| Component | Where | URL |
|-----------|-------|-----|
| Backend API | Vercel | `https://meeting-copilot-iota.vercel.app` |
| Source code | GitHub | `github.com/ankitsherke/meeting-copilot` |
| Extension | Load unpacked (Chrome) | — |
| Student DB | Notion | `Leap Counsellor — Students` database |

**Keys required:**

| Key | Used for | Where stored |
|-----|----------|-------------|
| `DEEPGRAM_API_KEY` | WebSocket STT | `chrome.storage.local` (Settings panel) |
| `OPENAI_API_KEY` | Embeddings + GPT-4o-mini | Vercel env var |
| `notionToken` | Notion API (bidirectional) | `chrome.storage.local` (Settings panel) |
| `notionDbId` | Lead database ID | `chrome.storage.local` (Settings panel) |

---

## Setup Sequence

```bash
# 1. Seed Notion database
cd backend
NOTION_TOKEN=xxx NOTION_PARENT_PAGE_ID=xxx python seed_notion.py

# 2. Seed KB
python seed_kb.py   # after placing leap_kb.md in docs/

# 3. Deploy backend
cd ..
vercel deploy --prod

# 4. Load extension
# chrome://extensions → Developer mode → Load unpacked → /extension
# Open Settings (⚙) → enter Deepgram key + Notion token + DB ID
```

---

## What's NOT in v0

- Shortlist building or validation
- Multi-counsellor assignment or handoff
- Automated lead creation from intake forms
- Full KB with thousands of universities (demo: 10-20 entries)
