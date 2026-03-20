"""
server.py — Meeting Copilot Backend
Single FastAPI file. Run: uvicorn server:app --reload --port 8000
"""

import os
import json
import shutil
from contextlib import asynccontextmanager
from typing import cast, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import chromadb
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# ── ChromaDB path ─────────────────────────────────────────────────────────────
# Vercel serverless has a read-only filesystem except /tmp.
# On cold start, copy the committed chroma_db bundle to /tmp so ChromaDB can write.

CHROMA_SOURCE = os.path.join(os.path.dirname(__file__), "chroma_db")
IS_VERCEL = bool(os.getenv("VERCEL"))
CHROMA_PATH = "/tmp/chroma_db" if IS_VERCEL else CHROMA_SOURCE

if IS_VERCEL and os.path.exists(CHROMA_SOURCE) and not os.path.exists(CHROMA_PATH):
    shutil.copytree(CHROMA_SOURCE, CHROMA_PATH)

# ── Init ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Meeting Copilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

SYSTEM_PROMPT = """You are a real-time meeting assistant. You help the user respond to questions asked during live meetings.

Rules:
1. ONLY use information from the CONTEXT section below. Do not use outside knowledge.
2. Keep your response to 2-4 sentences, suitable for speaking aloud in a meeting.
3. Be direct and confident. Avoid hedging phrases like "I think" or "it seems."
4. Always mention the source document name when citing a fact (e.g., "According to scholarships.md...").
5. If the CONTEXT does not contain relevant information, respond ONLY with: "The knowledge base does not contain this information."
"""

FALLBACK_SYSTEM_PROMPT = """You are a real-time meeting assistant. You help the user respond to questions asked during live meetings.

The internal knowledge base did not contain relevant information for this question, so use your general knowledge to answer.

Rules:
1. Keep your response to 2-4 sentences, suitable for speaking aloud in a meeting.
2. Be direct and confident.
3. If you are not confident in the answer, say so briefly.
4. Do NOT mention "knowledge base" or "context" — just answer naturally.
"""

# Relevance threshold: ChromaDB L2 distance above this means no good KB match found.
# For normalized OpenAI embeddings, even unrelated topics score ~0.8-0.9 L2 distance.
# 0.65 ≈ cosine similarity ~0.79 — only clearly on-topic chunks pass.
KB_RELEVANCE_THRESHOLD = 0.65

# ── Models ────────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    transcript: str
    query: str
    theme_persona: Optional[dict] = None  # {role, tone, outputStyle, constraints}


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
        raise HTTPException(
            status_code=503,
            detail="Knowledge base not initialized. Run seed_kb.py first."
        )

    # 1. Embed the query
    embed_response = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=request.query
    )
    query_embedding = embed_response.data[0].embedding

    # 2. Search ChromaDB for top-3 relevant chunks
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=min(3, collection.count()),
        include=["documents", "metadatas", "distances"]
    )

    chunks = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]

    # 3. Check relevance — fall back to general LLM if KB has no good match
    best_distance = min(distances) if distances else float('inf')
    kb_is_relevant = best_distance < KB_RELEVANCE_THRESHOLD

    # Build theme-aware system prompt suffix
    persona_suffix = ""
    if request.theme_persona is not None:
        p = cast(dict, request.theme_persona)
        constraints_str = "\n".join(f"- {c}" for c in p.get("constraints", []))
        persona_suffix = (
            f"\n\nMEETING ROLE: {p.get('role', '')}"
            f"\nTONE: {p.get('tone', '')}"
            f"\nOUTPUT STYLE: {p.get('outputStyle', '')}"
            + (f"\nCONSTRAINTS:\n{constraints_str}" if constraints_str else "")
        )

    if kb_is_relevant:
        sources = list(dict.fromkeys(m["source"] for m in metadatas))
        context_parts = [f"[Source: {meta['source']}]\n{chunk}" for chunk, meta in zip(chunks, metadatas)]
        context = "\n\n---\n\n".join(context_parts)
        system_prompt = SYSTEM_PROMPT + persona_suffix
        user_message = (
            f"CONTEXT:\n{context}\n\n"
            f"MEETING TRANSCRIPT (last 60 seconds):\n{request.transcript}\n\n"
            f"QUESTION ASKED IN MEETING: {request.query}"
        )
        fallback = False
    else:
        sources = ["General Knowledge"]
        system_prompt = FALLBACK_SYSTEM_PROMPT + persona_suffix
        user_message = (
            f"MEETING TRANSCRIPT (last 60 seconds):\n{request.transcript}\n\n"
            f"QUESTION ASKED IN MEETING: {request.query}"
        )
        fallback = True

    # 4. Stream GPT-4o-mini response
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

            # Send sources metadata at end
            yield f"data: {json.dumps({'sources': sources, 'done': True, 'fallback': fallback})}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e), 'done': True})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


# ── Brief Endpoint ─────────────────────────────────────────────────────────────

class BriefRequest(BaseModel):
    agenda: str


@app.post("/brief")
async def brief(request: BriefRequest):
    if not request.agenda.strip():
        raise HTTPException(status_code=400, detail="Agenda cannot be empty")

    # Search KB with the full agenda text as query
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

    brief_prompt = f"""Generate a structured meeting briefing. Return JSON with exactly these keys:
- "key_facts": array of 3-5 concise bullet strings (important facts the meeting participant should know)
- "likely_questions": array of 3-5 objects, each with "q" (question string) and "a" (brief answer string)
- "agenda_items": array of objects, each with "item" (agenda topic string) and "keywords" (array of 3-5 lowercase keyword strings that would appear in conversation when this topic is being discussed)

AGENDA:
{request.agenda}

KNOWLEDGE BASE CONTEXT:
{context}

Be specific and concise. Ground facts in the KB context where available."""

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.3,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "You are a meeting preparation assistant. Generate concise, actionable briefings in JSON format."},
            {"role": "user", "content": brief_prompt}
        ]
    )

    return json.loads(response.choices[0].message.content)


# ── Nudge Endpoint ─────────────────────────────────────────────────────────────

class NudgeRequest(BaseModel):
    transcript: str
    checklist_items: list = []        # [{id, label, covered, priority}]
    enabled_nudge_types: list = []    # subset of the 8 types
    theme_goal: str = ""
    theme_persona: Optional[dict] = None


VALID_NUDGE_TYPES = {
    "kb_answer", "checklist_reminder", "objection_handler",
    "silence_prompt", "goal_drift_alert", "closing_cue",
    "context_recall", "sentiment_shift"
}


@app.post("/nudge")
async def nudge(request: NudgeRequest):
    uncovered = [i for i in request.checklist_items if not i.get("covered", False)]
    enabled = [t for t in request.enabled_nudge_types if t in VALID_NUDGE_TYPES]
    if not enabled:
        enabled = list(VALID_NUDGE_TYPES)

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

    uncovered_str = "\n".join(f"- {i['label']} ({i.get('priority','medium')})" for i in uncovered) if uncovered else "All checklist items covered."
    enabled_str = ", ".join(enabled)

    persona_str = ""
    if request.theme_persona is not None:
        tp = cast(dict, request.theme_persona)
        persona_str = f"\nYOUR ROLE: {tp.get('role', '')}\nTONE: {tp.get('tone', '')}\nOUTPUT STYLE: {tp.get('outputStyle', '')}"

    nudge_prompt = f"""You are a real-time meeting coach monitoring a live conversation.

MEETING GOAL: {request.theme_goal or "Help the meeting achieve its objectives."}{persona_str}

RECENT TRANSCRIPT (last 2 min):
{request.transcript[-1500:] if request.transcript else "No transcript yet."}

UNCOVERED CHECKLIST ITEMS:
{uncovered_str}

RELEVANT KB CONTEXT:
{context if context else "No relevant KB context."}

Generate 1-3 nudges using ONLY these enabled types: {enabled_str}

Nudge type definitions:
- kb_answer: Surface a relevant fact from the KB that fits the current discussion
- checklist_reminder: Remind about an important uncovered checklist item
- objection_handler: Suggest how to handle a concern or objection raised
- silence_prompt: Suggest a question to break silence or re-engage
- goal_drift_alert: Alert that conversation has drifted from the meeting goal
- closing_cue: Signal an opportunity to close, commit, or wrap up
- context_recall: Recall something said earlier that is relevant now
- sentiment_shift: Flag a change in the other party's tone or sentiment

Return JSON: {{"nudges": [{{"type": "<one of the enabled types>", "text": "1-2 sentence actionable nudge"}}]}}"""

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.4,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "You are a real-time meeting coach. Return only valid JSON with actionable nudges."},
            {"role": "user", "content": nudge_prompt}
        ]
    )

    data = json.loads(response.choices[0].message.content)
    # Validate types — strip any invalid ones the model hallucinated
    data["nudges"] = [n for n in data.get("nudges", []) if n.get("type") in VALID_NUDGE_TYPES]
    return data


# ── Report Endpoint ────────────────────────────────────────────────────────────

class ReportRequest(BaseModel):
    transcript: str
    checklist_state: str = ""   # pre-formatted checklist lines
    pinned_nudges: list = []    # [{type, text}]
    theme_id: str = ""
    theme_goal: str = ""
    duration: str = ""          # "HH:MM:SS"
    goal_achieved: bool = False


@app.post("/report")
async def report(request: ReportRequest):
    pinned_str = "\n".join(f"- [{n.get('type','')}] {n.get('text','')}" for n in request.pinned_nudges) or "None"

    report_prompt = f"""Generate a structured post-meeting report based on the data below.

MEETING TYPE: {request.theme_id or "General"}
MEETING GOAL: {request.theme_goal or "Not specified"}
DURATION: {request.duration or "Unknown"}
GOAL ACHIEVED: {"Yes" if request.goal_achieved else "No"}

CHECKLIST STATUS:
{request.checklist_state or "No checklist data."}

PINNED NUDGES (moments the user found valuable):
{pinned_str}

FULL TRANSCRIPT:
{request.transcript[-4000:] if request.transcript else "No transcript."}

Write the report with these sections (use markdown headers):
## Meeting Summary
2-3 sentence overview of what was discussed and outcomes.

## Key Decisions & Commitments
Bullet list of concrete decisions made or commitments given.

## Action Items
Bullet list of next steps. Format: **[Owner]** — action — by [date if mentioned].

## What Went Well
2-3 bullets on effective moments in the meeting.

## Areas to Improve
2-3 bullets on gaps or missed opportunities (be specific, not generic).

## Follow-Up Questions
2-3 open questions that still need answers after this meeting.

Keep the entire report concise and scannable. Use plain language."""

    def generate():
        try:
            stream = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                max_tokens=600,
                temperature=0.3,
                stream=True,
                messages=[
                    {"role": "system", "content": "You are a professional meeting analyst. Write clear, concise post-meeting reports in markdown."},
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
