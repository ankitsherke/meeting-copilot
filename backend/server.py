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
3. If you are not confident, say so briefly.
4. Do NOT mention "knowledge base" or "context" — just answer naturally.
"""

NUDGE_SYSTEM_PROMPT = """You are a real-time counselling coach monitoring a live Leap Scholar counselling call. Your job is to surface the single most important action the counsellor should take RIGHT NOW.

You will return:
1. 1-3 nudges (most important first)
2. Any profile fields you can extract from the transcript
3. Any script moment state updates

Be specific and actionable. Every nudge must include a concrete sentence the counsellor can say aloud."""

EXTRACT_SYSTEM_PROMPT = """You are a post-call extraction engine for a Leap Scholar counselling session. Extract structured data from the full call transcript.

Return a JSON object with exactly these keys:
- "profile_updates": object with field names and extracted values (see field list below)
- "qualitative": object with "profile_summary", "motivation", "constraints", "emotional_notes"
- "open_questions": array of strings — unanswered questions from this call
- "counsellor_commitments": array of strings — things the counsellor explicitly promised
- "lead_status_suggestion": one of "New", "Call 1 Done", "Call 2 Done", "Applied", "Enrolled"

Profile field names to extract (use null if not mentioned):
country (array of strings), intake (string e.g. "Sep 2026"), budget (string e.g. "₹40-50L"),
preferred_course (string), preferred_degree (string e.g. "Masters"),
preferred_location (string), work_experience_months (number), backlogs (number),
ielts_score (string), ug_score (string), ug_specialisation (string), twelfth_score (string),
gre_gmat_score (string), college_in_mind (string)

Only extract values that are clearly and explicitly stated. Do not infer or assume."""

REPORT_SYSTEM_PROMPT = """You are a professional meeting analyst for Leap Scholar counselling calls. Write clear, concise post-call reports in markdown."""

# ── Models ────────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    transcript: str
    query: str
    student_context: Optional[dict] = None  # {name, profile fields, call_count}


class NudgeRequest(BaseModel):
    transcript: str
    script_state: Optional[dict] = None      # {moment_id: "covered"|"in_progress"}
    student_context: Optional[dict] = None   # student profile from Notion
    call_elapsed_seconds: int = 0
    expected_call_duration_seconds: int = 1800  # default 30min


class ExtractRequest(BaseModel):
    transcript: str
    student_context: Optional[dict] = None  # existing profile for context
    call_number: int = 1


class BriefRequest(BaseModel):
    agenda: str
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
    # Build call progress context
    elapsed = request.call_elapsed_seconds
    expected = request.expected_call_duration_seconds or 1800
    progress_pct = min(100, round(elapsed / expected * 100))

    # Search KB with recent transcript
    context = ""
    try:
        collection = chroma_client.get_collection("knowledge_base")
        if collection.count() > 0 and request.transcript.strip():
            embed_response = openai_client.embeddings.create(
                model="text-embedding-3-small",
                input=request.transcript[-1000:]
            )
            results = collection.query(
                query_embeddings=[embed_response.data[0].embedding],
                n_results=min(3, collection.count()),
                include=["documents", "metadatas", "distances"]
            )
            relevant = [
                f"[{meta['source']}] {chunk}"
                for chunk, meta, dist in zip(
                    results["documents"][0], results["metadatas"][0], results["distances"][0]
                )
                if dist < KB_RELEVANCE_THRESHOLD
            ]
            context = "\n\n".join(relevant[:2])
    except Exception:
        pass

    # Build student context string
    student_str = ""
    if request.student_context:
        sc = cast(dict, request.student_context)
        student_str = f"\nSTUDENT PROFILE: {json.dumps(sc, ensure_ascii=False)}"

    # Build script state string
    script_str = ""
    if request.script_state:
        ss = cast(dict, request.script_state)
        covered = [k for k, v in ss.items() if v == "covered"]
        uncovered = [k for k, v in ss.items() if v != "covered"]
        script_str = f"\nSCRIPT MOMENTS COVERED: {covered}\nSTILL PENDING: {uncovered}"

    nudge_prompt = f"""Monitor this live Leap Scholar counselling call and return JSON.

CALL PROGRESS: {progress_pct}% through the call ({elapsed}s elapsed of {expected}s expected)
{student_str}
{script_str}

RECENT TRANSCRIPT (last 2 min):
{request.transcript[-1500:] if request.transcript else "No transcript yet."}

RELEVANT KB CONTEXT:
{context if context else "No relevant KB context."}

Return JSON with exactly these keys:
{{
  "nudges": [
    {{
      "type": "<one of: profile_clarification|intent_divergence|emotional_signal|kb_answer|script_gap|field_gap>",
      "priority": <1-5, 5=highest>,
      "text": "1-2 sentence explanation of what is happening",
      "suggestion": "Exact sentence the counsellor can say aloud right now"
    }}
  ],
  "extracted_fields": {{
    "<field_name>": {{"value": "<extracted value>", "confidence": "high|medium|low", "source_quote": "<verbatim quote>"}}
  }},
  "script_state_update": {{
    "<moment_id>": "covered|in_progress"
  }}
}}

Nudge type definitions:
- profile_clarification (P1): Student's stated background or goals conflict with the course/country being discussed
- intent_divergence (P1): Student expresses doubt, hesitation, or pushback while counsellor continues selling
- emotional_signal (P2): Student shares something emotionally significant (family pressure, fear, financial stress)
- kb_answer (P3): Student asks a factual question the KB can answer (visa rules, costs, outcomes)
- script_gap (P4): Natural opening detected for a pending script moment, or important moment overdue given call progress
- field_gap (P5): Required profile fields are missing and call is past {60}% (only if progress > 60%)

Return 1-3 nudges maximum. Prioritise quality over quantity. Only return field_gap if progress > 60%.
Extracted_fields: extract country, intake, budget, preferred_course, preferred_degree, work_experience_months, backlogs, ielts_score, ug_score from transcript. Only extract what is clearly stated.
Script_state_update: only include moments that clearly happened in the recent transcript."""

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.4,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": NUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": nudge_prompt}
        ]
    )

    data = json.loads(response.choices[0].message.content)

    valid_types = {"profile_clarification", "intent_divergence", "emotional_signal", "kb_answer", "script_gap", "field_gap"}
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

    # Build student context string
    student_str = ""
    if request.student_context:
        student_str = f"\nEXISTING STUDENT PROFILE (for reference — do not duplicate unchanged fields):\n{json.dumps(request.student_context, ensure_ascii=False, indent=2)}"

    extract_prompt = f"""Extract structured data from this Leap Scholar counselling call transcript.
This is Call #{request.call_number} with this student.
{student_str}

FULL TRANSCRIPT:
{request.transcript[-6000:]}

{EXTRACT_SYSTEM_PROMPT}"""

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.1,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "You are a precise data extraction engine. Return only valid JSON matching the specified schema exactly."},
            {"role": "user", "content": extract_prompt}
        ]
    )

    data = json.loads(response.choices[0].message.content)

    # Ensure required keys exist
    for key in ["profile_updates", "qualitative", "open_questions", "counsellor_commitments", "lead_status_suggestion"]:
        if key not in data:
            data[key] = {} if key in ["profile_updates", "qualitative"] else []
    if not isinstance(data.get("lead_status_suggestion"), str):
        data["lead_status_suggestion"] = "Call 1 Done"

    return data


@app.post("/brief")
async def brief(request: BriefRequest):
    if not request.agenda.strip():
        raise HTTPException(status_code=400, detail="Agenda cannot be empty")

    context_parts = []
    try:
        collection = chroma_client.get_collection("knowledge_base")
        if collection.count() > 0:
            embed_response = openai_client.embeddings.create(
                model="text-embedding-3-small",
                input=request.agenda[:2000]
            )
            results = collection.query(
                query_embeddings=[embed_response.data[0].embedding],
                n_results=min(4, collection.count()),
                include=["documents", "metadatas", "distances"]
            )
            for chunk, meta, dist in zip(
                results["documents"][0], results["metadatas"][0], results["distances"][0]
            ):
                if dist < KB_RELEVANCE_THRESHOLD:
                    context_parts.append(f"[{meta['source']}]\n{chunk}")
    except Exception:
        pass

    context = "\n\n---\n\n".join(context_parts) if context_parts else "No relevant KB content found."

    student_str = ""
    if request.student_context:
        student_str = f"\nSTUDENT PROFILE:\n{json.dumps(request.student_context, ensure_ascii=False, indent=2)}"

    brief_prompt = f"""Generate a structured pre-call briefing for a Leap Scholar counsellor. Return JSON with exactly these keys:
- "key_facts": array of 3-5 concise bullet strings (important facts relevant to this student's profile)
- "likely_questions": array of 3-5 objects, each with "q" (question) and "a" (brief answer)
- "carry_forwards": array of strings (open questions or commitments from previous calls, if any)
- "readiness": object with "score" (0-5, how many required fields are known) and "missing" (array of missing required field names)

Required fields for shortlist: country, intake, budget, preferred_course, preferred_degree

AGENDA / CALL NOTES:
{request.agenda}
{student_str}

KNOWLEDGE BASE CONTEXT:
{context}

Be specific to this student's situation. Ground facts in KB context where available."""

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.3,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "You are a meeting preparation assistant for study abroad counsellors. Generate concise, actionable briefings in JSON format."},
            {"role": "user", "content": brief_prompt}
        ]
    )

    return json.loads(response.choices[0].message.content)


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
