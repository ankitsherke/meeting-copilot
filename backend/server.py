"""
server.py — Meeting Copilot Backend
Single FastAPI file. Run: uvicorn server:app --reload --port 8000
"""

import os
import json
import shutil
from contextlib import asynccontextmanager
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

    if kb_is_relevant:
        sources = list(dict.fromkeys(m["source"] for m in metadatas))
        context_parts = [f"[Source: {meta['source']}]\n{chunk}" for chunk, meta in zip(chunks, metadatas)]
        context = "\n\n---\n\n".join(context_parts)
        system_prompt = SYSTEM_PROMPT
        user_message = (
            f"CONTEXT:\n{context}\n\n"
            f"MEETING TRANSCRIPT (last 60 seconds):\n{request.transcript}\n\n"
            f"QUESTION ASKED IN MEETING: {request.query}"
        )
        fallback = False
    else:
        sources = ["General Knowledge"]
        system_prompt = FALLBACK_SYSTEM_PROMPT
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
    agenda_items: list = []
    current_nudges: list = []


@app.post("/nudge")
async def nudge(request: NudgeRequest):
    uncovered = [a for a in request.agenda_items if not a.get("covered", False)]

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
                str(chunk) for chunk, dist in zip(
                    results["documents"][0], results["distances"][0]
                )
                if dist < KB_RELEVANCE_THRESHOLD
            ]
            context = "\n\n".join(relevant[:2])
    except Exception:
        pass

    uncovered_str = "\n".join(f"- {a['item']}" for a in uncovered) if uncovered else "All agenda items covered."
    avoid_str = "\n".join(f"- {n}" for n in request.current_nudges) if request.current_nudges else "None"

    nudge_prompt = f"""You are a real-time meeting coach. Generate 2-3 specific, actionable nudges.

RECENT TRANSCRIPT (last 2 min):
{request.transcript[-1500:] if request.transcript else "No transcript yet."}

UNCOVERED AGENDA ITEMS:
{uncovered_str}

RELEVANT KB CONTEXT:
{context if context else "No relevant KB context."}

Do NOT repeat these already-shown nudges:
{avoid_str}

Nudge types:
- "agenda_gap": suggest asking about an uncovered agenda topic
- "talking_point": surface a relevant KB fact that fits the current discussion
- "steer": suggest redirecting if conversation is off-track

Return JSON: {{"nudges": [{{"type": "agenda_gap|talking_point|steer", "text": "1-2 sentence nudge"}}]}}"""

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.4,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "You are a real-time meeting coach. Generate specific, actionable nudges in JSON format."},
            {"role": "user", "content": nudge_prompt}
        ]
    )

    return json.loads(response.choices[0].message.content)
