#!/usr/bin/env python3
"""
Embed chunks with text-embedding-3-small and upload to Azure AI Search index 'normativa'.
Requires: pip install openai
Input:  ~/rag-ss/chunks/normativa_chunks_enriched.json
Output: Documents uploaded to Azure AI Search index 'normativa'
"""

import json
import time
import hashlib
import urllib.request
import urllib.error
import ssl
import os
from openai import AzureOpenAI

# ── Config (from environment variables) ──
SEARCH_ENDPOINT = os.getenv("AZURE_SEARCH_ENDPOINT", "https://ai-search-javi.search.windows.net")
SEARCH_KEY = os.environ["AZURE_SEARCH_KEY"]  # Required
SEARCH_INDEX = os.getenv("AZURE_SEARCH_INDEX", "normativa")

OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_READER_ENDPOINT", "https://openai-reader-javi.cognitiveservices.azure.com")
OPENAI_KEY = os.environ["AZURE_OPENAI_READER_KEY"]  # Required
EMBEDDING_MODEL = "text-embedding-3-small"

CHUNKS_FILE = "/home/javier/rag-ss/chunks/normativa_chunks_enriched.json"
PROGRESS_FILE = "/home/javier/rag-ss/chunks/upload_progress.json"

BATCH_SIZE = 16        # embeddings per batch
UPLOAD_BATCH = 100     # docs per upload batch to Search
EMBED_DELAY = 0.5      # seconds between embedding batches (rate limit)

# ── SSL context (no verify for server) ──
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

# ── Azure OpenAI client ──
client = AzureOpenAI(
    api_key=OPENAI_KEY,
    api_version="2023-05-15",
    azure_endpoint=OPENAI_ENDPOINT
)


def generate_doc_id(chunk):
    """Generate a stable document ID from law + section."""
    raw = f"{chunk.get('law', '')}|{chunk.get('section', '')}"
    return hashlib.md5(raw.encode()).hexdigest()


def embed_texts(texts):
    """Embed a batch of texts using text-embedding-3-small."""
    response = client.embeddings.create(
        input=texts,
        model=EMBEDDING_MODEL
    )
    return [item.embedding for item in response.data]


def upload_to_search(documents):
    """Upload a batch of documents to Azure AI Search."""
    url = f"{SEARCH_ENDPOINT}/indexes/{SEARCH_INDEX}/docs/index?api-version=2024-07-01"
    body = json.dumps({"value": documents}).encode("utf-8")

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("api-key", SEARCH_KEY)

    try:
        with urllib.request.urlopen(req, context=ssl_ctx) as resp:
            result = json.loads(resp.read().decode())
            ok = sum(1 for r in result.get("value", []) if r.get("status"))
            fail = sum(1 for r in result.get("value", []) if not r.get("status"))
            return ok, fail
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"  Upload error HTTP {e.code}: {error_body[:300]}")
        return 0, len(documents)


def load_progress():
    """Load progress: set of already-uploaded doc IDs."""
    try:
        with open(PROGRESS_FILE, "r") as f:
            return set(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_progress(uploaded_ids):
    """Save progress."""
    with open(PROGRESS_FILE, "w") as f:
        json.dump(list(uploaded_ids), f)


def main():
    # Load chunks
    with open(CHUNKS_FILE, "r", encoding="utf-8") as f:
        chunks = json.load(f)
    print(f"Loaded {len(chunks)} chunks")

    # Load progress
    uploaded_ids = load_progress()
    print(f"Already uploaded: {len(uploaded_ids)}")

    # Filter remaining
    remaining = []
    for chunk in chunks:
        doc_id = generate_doc_id(chunk)
        if doc_id not in uploaded_ids:
            remaining.append((doc_id, chunk))
    print(f"Remaining to process: {len(remaining)}")

    if not remaining:
        print("All chunks already uploaded!")
        return

    # Process in embedding batches
    total_ok = 0
    total_fail = 0
    upload_buffer = []
    start_time = time.time()

    for batch_start in range(0, len(remaining), BATCH_SIZE):
        batch = remaining[batch_start:batch_start + BATCH_SIZE]

        # Prepare texts for embedding
        texts = [chunk.get("text", "")[:8000] for _, chunk in batch]

        # Embed
        try:
            embeddings = embed_texts(texts)
        except Exception as e:
            print(f"  Embedding error at batch {batch_start}: {e}")
            time.sleep(5)
            try:
                embeddings = embed_texts(texts)
            except Exception as e2:
                print(f"  Retry failed: {e2}")
                continue

        # Build search documents
        for i, (doc_id, chunk) in enumerate(batch):
            doc = {
                "@search.action": "mergeOrUpload",
                "id": doc_id,
                "law": chunk.get("law", ""),
                "chapter": chunk.get("chapter", ""),
                "section": chunk.get("section", ""),
                "text": chunk.get("text", ""),
                "resumen": chunk.get("resumen", ""),
                "palabras_clave": chunk.get("palabras_clave", []),
                "preguntas": "\n".join(chunk.get("preguntas", [])),
                "text_vector": embeddings[i]
            }
            upload_buffer.append((doc_id, doc))

        # Upload when buffer is full
        if len(upload_buffer) >= UPLOAD_BATCH:
            docs_to_upload = [doc for _, doc in upload_buffer]
            ok, fail = upload_to_search(docs_to_upload)
            total_ok += ok
            total_fail += fail

            if ok > 0:
                for uid, _ in upload_buffer[:ok]:
                    uploaded_ids.add(uid)

            upload_buffer = []
            save_progress(uploaded_ids)

        # Progress
        processed = batch_start + len(batch)
        elapsed = time.time() - start_time
        rate = processed / elapsed * 60 if elapsed > 0 else 0
        eta = (len(remaining) - processed) / rate if rate > 0 else 0

        if processed % (BATCH_SIZE * 4) == 0 or processed == len(remaining):
            print(f"[{processed}/{len(remaining)}] {total_ok} ok, {total_fail} err | {rate:.0f}/min | ETA: {eta:.0f}min")

        # Rate limit
        time.sleep(EMBED_DELAY)

    # Upload remaining buffer
    if upload_buffer:
        docs_to_upload = [doc for _, doc in upload_buffer]
        ok, fail = upload_to_search(docs_to_upload)
        total_ok += ok
        total_fail += fail
        if ok > 0:
            for uid, _ in upload_buffer[:ok]:
                uploaded_ids.add(uid)
        save_progress(uploaded_ids)

    elapsed = time.time() - start_time
    print(f"\nDone! {total_ok} uploaded, {total_fail} failed in {elapsed/60:.1f} min")
    print(f"Total in index: {len(uploaded_ids)}")


if __name__ == "__main__":
    main()
