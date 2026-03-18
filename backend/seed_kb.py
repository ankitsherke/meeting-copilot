"""
seed_kb.py — Pre-load knowledge base documents into ChromaDB.
Run this once before starting the demo: python seed_kb.py
"""

import os
import re
import chromadb
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

DOCS_DIR = os.path.join(os.path.dirname(__file__), "docs")
CHROMA_PATH = os.path.join(os.path.dirname(__file__), "chroma_db")
CHUNK_SIZE = 400  # tokens approx (chars / 4)
CHUNK_OVERLAP = 50

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)

# Reset collection for clean seed
try:
    chroma_client.delete_collection("knowledge_base")
    print("Deleted existing collection.")
except Exception:
    pass

collection = chroma_client.create_collection(
    "knowledge_base",
    metadata={"hnsw:space": "cosine"}
)


def read_file(filepath: str) -> str:
    ext = os.path.splitext(filepath)[1].lower()

    if ext in (".md", ".txt"):
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()

    elif ext == ".pdf":
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(filepath)
            return "\n".join(page.get_text() for page in doc)
        except ImportError:
            print(f"  [skip] PyMuPDF not installed, cannot read {filepath}")
            return ""

    elif ext == ".docx":
        try:
            from docx import Document
            doc = Document(filepath)
            return "\n".join(p.text for p in doc.paragraphs)
        except ImportError:
            print(f"  [skip] python-docx not installed, cannot read {filepath}")
            return ""

    else:
        print(f"  [skip] unsupported format: {filepath}")
        return ""


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks by approximate token count."""
    # Split on paragraph boundaries first
    paragraphs = re.split(r'\n\s*\n', text.strip())
    chunks = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # If adding this paragraph exceeds chunk size, save current and start new
        if len(current) + len(para) > chunk_size * 4:  # chars ≈ tokens * 4
            if current:
                chunks.append(current.strip())
                # Start new chunk with overlap from end of previous
                words = current.split()
                overlap_text = " ".join(words[-overlap:]) if len(words) > overlap else current
                current = overlap_text + "\n\n" + para
            else:
                # Single paragraph too large — split by sentences
                sentences = re.split(r'(?<=[.!?])\s+', para)
                for sent in sentences:
                    if len(current) + len(sent) > chunk_size * 4:
                        if current:
                            chunks.append(current.strip())
                        current = sent
                    else:
                        current += (" " if current else "") + sent
        else:
            current += ("\n\n" if current else "") + para

    if current.strip():
        chunks.append(current.strip())

    return [c for c in chunks if len(c.strip()) > 50]  # Filter tiny chunks


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts using OpenAI text-embedding-3-small."""
    response = openai_client.embeddings.create(
        model="text-embedding-3-small",
        input=texts
    )
    return [item.embedding for item in response.data]


def seed_document(filepath: str):
    filename = os.path.basename(filepath)
    print(f"\nProcessing: {filename}")

    text = read_file(filepath)
    if not text.strip():
        print(f"  [skip] empty content")
        return

    chunks = chunk_text(text)
    print(f"  {len(chunks)} chunks")

    if not chunks:
        return

    # Embed in batches of 20
    batch_size = 20
    all_ids = []
    all_embeddings = []
    all_documents = []
    all_metadatas = []

    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i + batch_size]
        embeddings = embed_texts(batch)

        for j, (chunk, embedding) in enumerate(zip(batch, embeddings)):
            chunk_id = f"{filename}__chunk_{i + j}"
            all_ids.append(chunk_id)
            all_embeddings.append(embedding)
            all_documents.append(chunk)
            all_metadatas.append({
                "source": filename,
                "chunk_index": i + j,
                "total_chunks": len(chunks)
            })

    collection.add(
        ids=all_ids,
        embeddings=all_embeddings,
        documents=all_documents,
        metadatas=all_metadatas
    )
    print(f"  Stored {len(all_ids)} chunks in ChromaDB")


def main():
    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set in .env file")
        return

    if not os.path.exists(DOCS_DIR):
        print(f"ERROR: docs/ directory not found at {DOCS_DIR}")
        return

    files = [
        os.path.join(DOCS_DIR, f)
        for f in os.listdir(DOCS_DIR)
        if os.path.isfile(os.path.join(DOCS_DIR, f))
        and not f.startswith(".")
    ]

    if not files:
        print("No files found in docs/ directory")
        return

    print(f"Found {len(files)} files to process...")

    for filepath in sorted(files):
        seed_document(filepath)

    count = collection.count()
    print(f"\nDone! {count} total chunks in ChromaDB.")
    print("Run: uvicorn server:app --reload")


if __name__ == "__main__":
    main()
