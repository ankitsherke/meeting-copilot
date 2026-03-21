"""
server.py — Counsellor Assistant Backend
Single FastAPI file. Run: uvicorn server:app --reload --port 8000
"""

import os
import json
import shutil
from typing import cast, Optional, List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import chromadb
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# ── ChromaDB path ─────────────────────────────────────────────────────────────
CHROMA_SOURCE = os.path.join(os.path.dirname(__file__), "chroma_db")
IS_VERCEL = bool(os.getenv("VERCEL"))
CHROMA_PATH = "/tmp/chroma_db" if IS_VERCEL else CHROMA_SOURCE

if IS_VERCEL and os.path.exists(CHROMA_SOURCE) and not os.path.exists(CHROMA_PATH):
    shutil.copytree(CHROMA_SOURCE, CHROMA_PATH)

# ── Init ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Counsellor Assistant API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

KB_RELEVANCE_THRESHOLD = 0.65

# ── System prompts ────────────────────────────────────────────────────────────

QUERY_SYSTEM_PROMPT = """You are a real-time study abroad knowledge assistant helping a Leap Scholar counsellor during a live student call.

Rules:
1. ONLY use information from the CONTEXT section below. Do not use outside knowledge.
2. Keep your response to 2-4 sentences, suitable for speaking aloud during a call.
3. Be direct and confident. Avoid hedging phrases like "I think" or "it seems."
4. Always mention the source document name when citing a fact (e.g., "According to leap_kb.md...").
5. If STUDENT PROFILE is provided, tailor your answer to their specific situation (budget, country interest, background).
6. If the CONTEXT does not contain relevant information, respond ONLY with: "The knowledge base does not contain this information."
"""

QUERY_FALLBACK_SYSTEM_PROMPT = """You are a real-time study abroad knowledge assistant helping a Leap Scholar counsellor during a live student call.

The internal knowledge base did not have relevant information. Use your general knowledge.

Rules:
1. Keep your response to 2-4 sentences, suitable for speaking aloud.
2. Be direct and confident.
3. If you are not confident, say so briefly and flag it as "web search fallback — verify before sharing."
4. Do NOT mention "knowledge base" or "context" — just answer naturally.
"""

NUDGE_SYSTEM_PROMPT = """You are the real-time intelligence layer for a Leap Scholar counselling call. You analyse transcript chunks from a live call between a counsellor and a prospective study-abroad student. Your job is to surface signals that the counsellor's existing co-pilot misses entirely.

The existing co-pilot is a guided form — it shows the counsellor what to say and where to enter CRM data. It has zero awareness of what the student actually says. You cover that gap.

## What you receive

Each request contains:
- `transcript_recent`: the last 3-5 transcript chunks (speaker + text + timestamp)
- `transcript_full`: complete transcript so far
- `student_context`: pre-loaded student profile from Notion (name, source, existing fields, call number, carry-forwards from previous calls)
- `script_state`: which cheat sheet moments have been covered, in-progress, or pending
- `fields_captured`: which shortlisting fields have values so far
- `call_elapsed_seconds`: how long the call has been running
- `expected_call_duration_seconds`: typical first call is 900-1200 seconds (15-20 min)
- `dismissed_nudges`: nudge types recently dismissed by the counsellor (cooldown active)
- `open_questions`: student questions tracked as asked/answered/deferred
- `disinterest_flags`: categories the student has explicitly rejected

## What you output

Return a JSON object with three keys:

```json
{
  "nudges": [],
  "extracted_fields": {},
  "script_state_update": {}
}
```

### nudges — array of 0-2 signal objects

Each nudge has this shape:
```json
{
  "type": "profile_mismatch",
  "priority": 1,
  "title": "Counsellor categorised as event management — incorrect",
  "text": "Student's described work is spatial brand design. The event is the context, not the service. This categorisation will produce a wrong shortlist.",
  "suggestion": "What I am hearing is that your core skill is designing spaces and environments for brands — the event is the context, not the service. Does spatial design or experiential design feel more accurate?",
  "reason": "Student said: 'I do their pop ups, I represent the brand in different cities, I design the whole space according to the brand guidelines.' Counsellor said: 'vo designing mein nahi aata, it comes under event management.'"
}
```

### extracted_fields — auto-detected shortlist values

Only include fields where the transcript clearly states a value. Each field:
```json
{
  "country": {
    "value": ["Australia", "UK"],
    "confidence": "high",
    "source_quote": "first option is Australia... backup option is London"
  }
}
```

Confidence levels:
- "high": student explicitly stated the value ("my budget is 35 lakhs", "I want to do MS in CS")
- "medium": value can be inferred from context ("I am targeting Monash and Swinburne" → budget is likely 40-50L range)
- Do NOT include "low" confidence extractions. Only high and medium.

### script_state_update — moments detected as covered

```json
{
  "profile_career": "covered",
  "intro_purpose": "covered"
}
```

Mark a moment as "covered" when the topic was touched at all — a brief mention counts. Be generous. The counsellor has a back button to undo if needed.

Specific detection rules:
- `intro_self`: counsellor said their name or introduced themselves → covered
- `intro_purpose`: counsellor mentioned the goal or agenda of the call → covered
- `intro_state`: counsellor asked where the student is in their study abroad journey → covered
- `profile_career`: counsellor asked about career goals OR student described what they want to do → covered
- `profile_validate`: counsellor confirmed or repeated back any profile detail → covered
- `profile_params`: counsellor asked what matters most in university selection → covered
- `reaffirm_conviction`: counsellor said something affirming about the student's profile or path → covered
- `reaffirm_colleges`: counsellor mentioned one or more specific universities → covered
- `reaffirm_similar`: counsellor mentioned a past student or outcome profile → covered
- `reaffirm_questions`: counsellor asked if the student has any questions → covered
- `close_leap`: counsellor mentioned Leap's services or platform → covered
- `close_app`: counsellor mentioned the Leap app or next steps on the app → covered
- `close_schedule`: counsellor mentioned scheduling the next call or follow-up → covered
- `close_contact`: counsellor gave contact details or mentioned WhatsApp → covered

Always scan the full transcript and return every moment you can detect. Return an empty object only if nothing was detected.

## Signal types and when to fire them

### P1 — profile_mismatch (RED)
Fire when the student's described background, work, or interests do not map to the course category being discussed.

Level 1 — AMBIGUOUS PROFILE: Student describes work across multiple domains that don't converge on one standard course.
Level 2 — COUNSELLOR MISFILED: Counsellor assigned a course category that contradicts what the student described.
Level 3 — STUDENT PUSHED BACK: Student explicitly rejected the assigned category.

CRITICAL RULE: If profile_mismatch is active, flag any attempt to advance to eligibility fields (CGPA, 12th score, backlogs) as premature.

**Example of a well-formed profile_mismatch nudge — use as a quality benchmark:**
```json
{
  "type": "profile_mismatch",
  "priority": 1,
  "title": "Spatial design ≠ event management",
  "text": "Student described spatial brand design, pop-up environments, and brand identity work. 'Event management' is the wrong category and will produce a wrong shortlist.",
  "suggestion": "What I'm hearing is that you design the physical space and brand environment for clients — the event is the context, not the service. Would 'spatial design' or 'experiential design' feel more accurate for what you do?",
  "reason": "Student said: 'I design the whole space according to the brand guidelines, I do their pop-ups, I represent the brand in different cities.' Counsellor responded: 'vo designing mein nahi aata, it comes under event management.'"
}
```

The `suggestion` must always be a complete sentence the counsellor can say aloud word-for-word. It should reframe what the student said back to them as a question, not tell the counsellor what to do.

### P1 — intent_divergence (RED)
Fire when the student's stated intent diverges from the assumption the counsellor is operating on.

Triggers:
- Student says they're confused between domestic options (GATE, CAT) and abroad
- Student says they're "still exploring" while counsellor discusses application deadlines
- Student's parents are driving the decision and the student seems passive or reluctant

### P2 — emotional_signal (AMBER)
Fire when the student reveals something emotionally significant and the counsellor is about to advance without acknowledging it.

Triggers: health crisis, family complexity, frustration after being misfiled, career doubt, dream aspiration with intensity, financial stress.

RULE: If the counsellor already acknowledged the emotional moment, do NOT fire this signal.

### P3 — kb_answer (BLUE)
Fire when the student asks a factual question. Include the detected question in the nudge text so the frontend can trigger a /query call.

### P3 — outcome_profile (BLUE)
Fire when showing a similar student's outcome would build trust. Triggers: student asks about past students, profile mismatch is active, student expresses doubt about their chances.

### P4 — script_gap (GREEN)
Fire when: a natural opening exists for a pending script moment; call is past 70% and required moments are uncovered; call is approaching end and close moments haven't happened.

### P5 — field_gap (GRAY)
Fire when call is past 60% of expected duration AND one or more required shortlisting fields (country, intake, budget, preferredCourse, preferredDegree) are still empty. List which fields are missing.

## Additional signal types (include in nudges array)

- **unanswered_question** (P3): Student asked a question and 3+ transcript chunks passed without an answer
- **commitment** (P5): Counsellor made a specific promise with a timeline
- **counsellor_dominance** (P5): Last 5+ chunks are all from the counsellor with minimal student input
- **disinterest** (P3): Student explicitly rejected a course, country, or suggestion
- **cross_sell** (P5): Natural opening arises to mention a Leap service based on what student said — NOT forced

## Decision logic

FIRE when: student says something the form cannot capture AND counsellor is about to move on; counsellor assigns a wrong category; student asks factual question; student reveals emotional context; student explicitly rejects; counsellor makes a promise; required fields missing past midpoint; counsellor monologuing 5+ turns; student's intent diverges.

STAY SILENT when: co-pilot is collecting eligibility fields and student is answering straightforwardly; counsellor is doing rapport warmup; conversation is flowing naturally; counsellor already acknowledged the signal; nudge type was recently dismissed.

BAU call: 0-1 nudges per call. Total across 15 min: 4-7 nudges.
Edge case call (Samiraj-type): 1-2 nudges per call during problem moments. Total: 10-15 nudges.

## Priority hierarchy (return max 2 nudges)

1. profile_mismatch (P1)
2. intent_divergence (P1)
3. emotional_signal (P2)
4. kb_answer / outcome_profile (P3)
5. unanswered_question (P3)
6. disinterest (P3)
7. script_gap (P4)
8. field_gap (P5)
9. commitment / cross_sell / counsellor_dominance (P5)

## Language handling

Transcripts contain English, Hindi, Hinglish, Tamil, Telugu mixed in single sentences. ASR output contains errors.
- Interpret intent, not literal words. "vo designing mein nahi aata" = counsellor saying work doesn't fall under designing.
- Proper nouns will be garbled. "Swinburne" → "swenvae". Use context to infer.
- When quoting student speech, clean up ASR errors but preserve meaning and emotional tone.
- Normalize field values to standard format ("thirty five lakhs" → "₹35L").

Never hallucinate. If unsure whether something is a signal, don't include it. Silence is always better than noise.

Always return valid JSON. If nothing to signal:
{"nudges": [], "extracted_fields": {}, "script_state_update": {}}
"""

EXTRACT_SYSTEM_PROMPT = """You are the post-call extraction engine for a Leap Scholar counselling call. You receive the complete transcript of a call between a counsellor and a prospective study-abroad student, along with the student's existing profile context.

Your job is to extract two things:
1. Structured shortlist fields — values that go into specific database columns
2. Qualitative signals — context that matters for downstream teams but doesn't fit any field

## What you output

Return a JSON object matching this exact schema:

```json
{
  "profile_updates": {
    "country": ["Australia", "UK"],
    "intake": "Sep 2026",
    "budget": "₹40-50L",
    "preferredCourse": "Masters of Design (Spatial/Experiential)",
    "preferredDegree": "Masters",
    "preferredLocation": "Melbourne",
    "workExperience": 24,
    "backlog": 0,
    "ieltsScore": "6.0 overall (retaking, targeting 7.5)",
    "ugScore": "7.0 CGPA",
    "ugSpecialisation": "Fashion Designing",
    "twelfthScore": "58%",
    "greGmatScore": null,
    "collegeInMind": "Monash, Swinburne"
  },
  "qualitative": {
    "profile_summary": "...",
    "motivation": "...",
    "constraints": "...",
    "emotional_notes": "..."
  },
  "open_questions": [],
  "counsellor_commitments": [],
  "lead_status_suggestion": "Call 1 Done"
}
```

## Extraction rules for profile_updates

Only include fields that were explicitly discussed. Do not infer values that weren't stated.

- **country**: Array. Include primary AND backup. Use standard names: "Australia", "UK", "Ireland", "Germany", "UAE", "Canada", "USA", "Singapore".
- **intake**: Format as "Mon YYYY" (e.g., "Sep 2026").
- **budget**: Format as "₹XL" or "₹X-YL". Normalize ("thirty five lakhs" → "₹35L").
- **preferredCourse**: Use the most specific category discussed. If the student corrected the counsellor's categorisation, use the STUDENT'S version. This is critical — a misfiled course corrupts the shortlist.
- **preferredDegree**: "Masters" / "Bachelors" / "Diploma" / "Certificate".
- **workExperience**: Total months. Include internships only if student explicitly counted them.
- **backlog**: Number. 0 if student said "no backlogs".
- **ieltsScore**: Include score AND context if available ("6.0 overall, retaking end of March, targeting 7.5").
- **ugScore**: Format as stated — "7.0 CGPA" or "68%".
- **collegeInMind**: Comma-separated university names the student mentioned researching or targeting.

## Extraction rules for qualitative

### profile_summary
One paragraph (3-5 sentences): educational background, work experience with specifics, portfolio strength if mentioned, what makes this profile non-standard (if anything).

### motivation
Student's stated reason for going abroad, in their own words as much as possible. Include the emotional driver, not just the practical one.

### constraints
Everything that could affect the student's journey — financial, family, timeline, health, emotional. Be specific.

### emotional_notes
Signals that the next counsellor needs to be aware of. Frustrations, anxieties, unspoken concerns.

## Extraction rules for open_questions
Every question the student asked that was NOT fully answered. Format as actionable items.

## Extraction rules for counsellor_commitments
Every specific promise the counsellor made with an implied or explicit timeline.

## lead_status_suggestion
"Call 1 Done" / "Call 2 Done" / "Applied" — based on call content.

## Critical rules
1. For preferredCourse: if there was a profile mismatch (counsellor assigned one category, student corrected), ALWAYS use the student's correction.
2. For open_questions: be thorough. Every unanswered question is a trust liability for Call 2.
3. For counsellor_commitments: be thorough. Every unfulfilled commitment is a broken promise.
4. Never invent information. Return null for fields not mentioned.
5. Language handling: interpret intent through ASR errors and code-switching. Normalize field values.
"""

BRIEF_SYSTEM_PROMPT = """You are the pre-call briefing engine for a Leap Scholar counselling call. You receive a student's complete profile from Notion — including structured fields, qualitative context, and call history — and generate a concise brief the counsellor sees BEFORE the call starts.

Your goal: the counsellor should walk into Call 2 knowing everything that matters from Call 1, without reading the full transcript.

## What you output

Return a JSON object:

```json
{
  "carry_forwards": [],
  "profile_context": "",
  "shortlist_readiness": {
    "required_captured": 4,
    "required_total": 5,
    "missing_required": ["budget"],
    "missing_optional": ["ieltsScore", "greGmatScore"]
  },
  "tone_guidance": ""
}
```

### carry_forwards — array of 2-4 critical items

These appear at the TOP of the counsellor's screen. Ordered by urgency. Things that will damage trust if forgotten.

Each carry-forward:
```json
{
  "text": "Post-study work visa for Australia — student asked in Call 1, never answered. Confirm before discussing universities.",
  "type": "open_question",
  "urgency": "high"
}
```

Types: "open_question", "commitment", "correction", "emotional"
Urgency: "high" (must address in first 2 minutes), "medium" (address during the call)

Priority: unanswered questions → unfulfilled commitments → profile corrections → emotional context.

### profile_context
Dense, readable paragraph the counsellor can scan in 10 seconds. Include: name, background, career goal, country preference with reasoning, budget, exam status, key profile characteristic.

### shortlist_readiness
Count of required fields captured vs total (5 required: country, intake, budget, preferredCourse, preferredDegree). List what's missing.

### tone_guidance
One sentence. Based on emotional notes from previous calls. Reference something specific from the previous call — not generic advice.

Examples:
- "Student was frustrated by profile misfiling last call — lead with acknowledgment and show you've done your homework on their actual field."
- "Student's mother was in hospital during Call 1 — ask how things are before diving in."
- "Student is undecided about going abroad — don't push enrollment, focus on helping them decide."

## Rules
1. Carry-forwards must be actionable, not informational.
2. Profile context must be scannable in 10 seconds. No filler, no repetition.
3. Tone guidance must be specific to THIS student, not generic.
4. Never include carry-forwards about things already resolved in call history.
"""

REPORT_SYSTEM_PROMPT = """You are a professional meeting analyst for Leap Scholar counselling calls. Write clear, concise post-call reports in markdown."""

# ── Models ────────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    transcript: str
    query: str
    student_context: Optional[dict] = None


class NudgeRequest(BaseModel):
    transcript_recent: Optional[list] = None    # last 3-5 chunks [{speaker, text, timestamp}]
    transcript_full: Optional[str] = None       # full transcript so far
    transcript: Optional[str] = None            # legacy fallback
    student_context: Optional[dict] = None
    script_state: Optional[dict] = None
    fields_captured: Optional[dict] = None
    call_elapsed_seconds: int = 0
    expected_call_duration_seconds: int = 1200
    dismissed_nudges: Optional[list] = None
    open_questions: Optional[list] = None
    disinterest_flags: Optional[list] = None


class ExtractRequest(BaseModel):
    transcript: str
    student_context: Optional[dict] = None
    call_number: int = 1


class BriefRequest(BaseModel):
    student_profile: Optional[dict] = None
    call_history: Optional[str] = None
    call_number: int = 2
    # legacy fields kept for backward compat
    agenda: Optional[str] = None
    student_context: Optional[dict] = None


class ReportRequest(BaseModel):
    transcript: str
    checklist_state: str = ""
    pinned_nudges: list = []
    theme_id: str = ""
    theme_goal: str = ""
    duration: str = ""
    goal_achieved: bool = False

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    try:
        collection = chroma_client.get_collection("knowledge_base")
        count = collection.count()
        return {"status": "ok", "kb_chunks": count}
    except Exception:
        return {"status": "ok", "kb_chunks": 0, "warning": "Knowledge base not seeded yet"}


@app.post("/query")
async def query(request: QueryRequest):
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    try:
        collection = chroma_client.get_collection("knowledge_base")
    except Exception:
        raise HTTPException(status_code=503, detail="Knowledge base not initialized. Run seed_kb.py first.")

    embed_response = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=request.query
    )
    query_embedding = embed_response.data[0].embedding

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=min(3, collection.count()),
        include=["documents", "metadatas", "distances"]
    )

    chunks = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]

    best_distance = min(distances) if distances else float('inf')
    kb_is_relevant = best_distance < KB_RELEVANCE_THRESHOLD

    # Build student context suffix
    student_suffix = ""
    if request.student_context:
        sc = cast(dict, request.student_context)
        parts: List[str] = []
        if sc.get("name"):
            parts.append(f"Student name: {sc['name']}")
        if sc.get("country"):
            country_val = sc['country']
            parts.append(f"Target country: {', '.join(country_val) if isinstance(country_val, list) else country_val}")
        if sc.get("budget"):
            parts.append(f"Budget: {sc['budget']}")
        if sc.get("preferred_course"):
            parts.append(f"Course interest: {sc['preferred_course']}")
        if sc.get("preferred_degree"):
            parts.append(f"Degree: {sc['preferred_degree']}")
        if sc.get("initial_interest"):
            parts.append(f"Initial interest: {sc['initial_interest']}")
        if parts:
            student_suffix = "\n\nSTUDENT PROFILE:\n" + "\n".join(parts)

    if kb_is_relevant:
        sources = list(dict.fromkeys(m["source"] for m in metadatas))
        context_parts = [f"[Source: {meta['source']}]\n{chunk}" for chunk, meta in zip(chunks, metadatas)]
        context = "\n\n---\n\n".join(context_parts)
        system_prompt = QUERY_SYSTEM_PROMPT + student_suffix
        user_message = (
            f"CONTEXT:\n{context}\n\n"
            f"CALL TRANSCRIPT (last 60s):\n{request.transcript}\n\n"
            f"QUESTION: {request.query}"
        )
        fallback = False
    else:
        sources = ["General Knowledge"]
        system_prompt = QUERY_FALLBACK_SYSTEM_PROMPT + student_suffix
        user_message = (
            f"CALL TRANSCRIPT (last 60s):\n{request.transcript}\n\n"
            f"QUESTION: {request.query}"
        )
        fallback = True

    def generate():
        try:
            stream = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                max_tokens=200,
                temperature=0.3,
                stream=True,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message}
                ]
            )
            for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield f"data: {json.dumps({'text': delta.content})}\n\n"
            yield f"data: {json.dumps({'sources': sources, 'done': True, 'fallback': fallback})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e), 'done': True})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@app.post("/nudge")
async def nudge(request: NudgeRequest):
    elapsed = request.call_elapsed_seconds
    expected = request.expected_call_duration_seconds or 1200
    progress_pct = min(100, round(elapsed / expected * 100))

    # Resolve transcript fields — support both new and legacy shapes
    transcript_full: str = request.transcript_full or request.transcript or ""
    transcript_recent_raw = request.transcript_recent or []
    if transcript_recent_raw:
        transcript_recent_str = json.dumps(transcript_recent_raw, ensure_ascii=False)
    else:
        transcript_recent_str = transcript_full[-1500:] or "No transcript yet."  # type: ignore[index]

    # KB context
    context = ""
    try:
        collection = chroma_client.get_collection("knowledge_base")
        if collection.count() > 0 and transcript_full.strip():
            embed_response = openai_client.embeddings.create(
                model="text-embedding-3-small",
                input=transcript_full[-1000:]  # type: ignore[index]
            )
            results = collection.query(
                query_embeddings=[embed_response.data[0].embedding],
                n_results=min(3, collection.count()),
                include=["documents", "metadatas", "distances"]
            )
            docs = results["documents"][0]       # type: ignore[index]
            metas = results["metadatas"][0]      # type: ignore[index]
            dists = results["distances"][0]      # type: ignore[index]
            relevant = [
                f"[{meta['source']}] {chunk}"
                for chunk, meta, dist in zip(docs, metas, dists)
                if dist < KB_RELEVANCE_THRESHOLD
            ]
            context = "\n\n".join(relevant[:2])
    except Exception:
        pass

    user_payload = {
        "transcript_recent": transcript_recent_str,
        "transcript_full": transcript_full[-2000:],
        "student_context": request.student_context or {},
        "script_state": request.script_state or {},
        "fields_captured": request.fields_captured or {},
        "call_elapsed_seconds": elapsed,
        "expected_call_duration_seconds": expected,
        "call_progress_pct": progress_pct,
        "dismissed_nudges": request.dismissed_nudges or [],
        "open_questions": request.open_questions or [],
        "disinterest_flags": request.disinterest_flags or [],
        "kb_context": context or "No relevant KB context.",
    }

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.4,
        max_tokens=350,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": NUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}
        ]
    )

    data = json.loads(response.choices[0].message.content)

    valid_types = {
        "profile_mismatch", "intent_divergence", "emotional_signal",
        "kb_answer", "outcome_profile", "script_gap", "field_gap",
        "unanswered_question", "commitment", "counsellor_dominance",
        "disinterest", "cross_sell",
        # legacy aliases
        "profile_clarification",
    }
    data["nudges"] = [n for n in data.get("nudges", []) if n.get("type") in valid_types]
    if "extracted_fields" not in data:
        data["extracted_fields"] = {}
    if "script_state_update" not in data:
        data["script_state_update"] = {}

    return data


@app.post("/extract")
async def extract(request: ExtractRequest):
    if not request.transcript.strip():
        raise HTTPException(status_code=400, detail="Transcript cannot be empty")

    user_payload = {
        "transcript": request.transcript[-8000:],
        "student_context": request.student_context or {},
        "call_number": request.call_number,
    }

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.1,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}
        ]
    )

    data = json.loads(response.choices[0].message.content)

    for key in ["profile_updates", "qualitative", "open_questions", "counsellor_commitments", "lead_status_suggestion"]:
        if key not in data:
            data[key] = {} if key in ["profile_updates", "qualitative"] else []
    if not isinstance(data.get("lead_status_suggestion"), str):
        data["lead_status_suggestion"] = "Call 1 Done"

    return data


@app.post("/brief")
async def brief(request: BriefRequest):
    # Support both new (student_profile / call_history) and legacy (agenda / student_context) shapes
    student_profile = request.student_profile or request.student_context or {}
    call_history = request.call_history or request.agenda or ""
    call_number = request.call_number

    if not student_profile and not call_history:
        raise HTTPException(status_code=400, detail="student_profile or call_history required")

    user_payload = {
        "student_profile": student_profile,
        "call_history": call_history,
        "call_number": call_number,
    }

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.3,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": BRIEF_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}
        ]
    )

    data = json.loads(response.choices[0].message.content)

    # Ensure required keys
    for key in ["carry_forwards", "profile_context", "shortlist_readiness", "tone_guidance"]:
        if key not in data:
            if key == "carry_forwards":
                data[key] = []
            elif key == "shortlist_readiness":
                data[key] = {"required_captured": 0, "required_total": 5, "missing_required": [], "missing_optional": []}
            else:
                data[key] = ""

    return data


@app.post("/report")
async def report(request: ReportRequest):
    pinned_str = "\n".join(f"- [{n.get('type','')}] {n.get('text','')}" for n in request.pinned_nudges) or "None"

    report_prompt = f"""Generate a structured post-call report for a Leap Scholar counselling session.

MEETING TYPE: Counselling
MEETING GOAL: {request.theme_goal or "Help student clarify study abroad path"}
DURATION: {request.duration or "Unknown"}
GOAL ACHIEVED: {"Yes" if request.goal_achieved else "No"}

CHECKLIST STATUS:
{request.checklist_state or "No checklist data."}

PINNED MOMENTS:
{pinned_str}

FULL TRANSCRIPT:
{request.transcript[-4000:] if request.transcript else "No transcript."}

Write the report with these sections (use markdown headers):
## Call Summary
2-3 sentence overview of what was discussed and what was decided.

## Student Profile Captured
Bullet list of profile data points confirmed in this call.

## Action Items
Bullet list of next steps. Format: **[Owner]** — action — by [date if mentioned].

## Counsellor Commitments
Things the counsellor promised the student during this call.

## Follow-Up Questions
Open questions that still need answers before the next call.

Keep the report concise and scannable. Use plain language."""

    def generate():
        try:
            stream = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                max_tokens=600,
                temperature=0.3,
                stream=True,
                messages=[
                    {"role": "system", "content": REPORT_SYSTEM_PROMPT},
                    {"role": "user", "content": report_prompt}
                ]
            )
            for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield f"data: {json.dumps({'text': delta.content})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e), 'done': True})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
