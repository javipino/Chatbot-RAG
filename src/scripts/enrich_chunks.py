"""
Enrich normativa chunks with GPT-5 Nano using async concurrency.
Saves progress every 50 chunks. Resumable.
"""
import json, os, time, re, asyncio
from openai import AsyncAzureOpenAI

# ── Config (from environment variables) ──
ENDPOINT = os.getenv("AZURE_OPENAI_READER_ENDPOINT", "https://openai-reader-javi.cognitiveservices.azure.com/")
API_KEY = os.environ["AZURE_OPENAI_READER_KEY"]  # Required
DEPLOYMENT = "gpt-5-nano"
API_VERSION = "2024-12-01-preview"

IN_PATH = "/home/javier/rag-ss/chunks/normativa_chunks_v2.json"
OUT_PATH = "/home/javier/rag-ss/chunks/normativa_chunks_enriched.json"
PROGRESS_PATH = "/home/javier/rag-ss/chunks/enrichment_progress.json"

MAX_TEXT_CHARS = 2000
MAX_RETRIES = 3
SAVE_EVERY = 50
CONCURRENCY = 5  # parallel requests

SYSTEM_PROMPT = """Eres un experto en legislación laboral y de Seguridad Social española.
Responde SIEMPRE con JSON válido, sin texto adicional ni bloques de código markdown."""


def build_prompt(chunk):
    text = chunk['text'][:MAX_TEXT_CHARS]
    return f"""Analiza este fragmento de legislación y devuelve un JSON con:
1. "resumen": Resumen de 1-2 frases en español llano explicando qué regula.
2. "palabras_clave": Lista de 5-8 conceptos clave para búsqueda semántica.
3. "preguntas": Lista de 3-4 preguntas que este artículo respondería, formuladas como las haría un ciudadano o profesional de RRHH.

LEY: {chunk['law']}
CAPÍTULO: {chunk.get('chapter', '')}
SECCIÓN: {chunk['section']}

TEXTO:
{text}

Responde SOLO con JSON válido."""


def parse_response(content):
    if not content:
        return None
    clean = content.strip()
    if clean.startswith('```'):
        clean = clean.split('\n', 1)[1] if '\n' in clean else clean[3:]
        if '```' in clean:
            clean = clean.rsplit('```', 1)[0]
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r'\{.*\}', clean, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
    return None


async def enrich_one(client, chunk, idx, semaphore):
    """Enrich a single chunk with retry logic."""
    # Skip very short chunks
    if len(chunk['text']) < 60:
        return idx, {"resumen": "Artículo derogado.", "palabras_clave": [], "preguntas": []}

    async with semaphore:
        for attempt in range(MAX_RETRIES):
            try:
                resp = await client.chat.completions.create(
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": build_prompt(chunk)}
                    ],
                    max_completion_tokens=4096,
                    model=DEPLOYMENT,
                )
                parsed = parse_response(resp.choices[0].message.content)
                if parsed and 'resumen' in parsed:
                    return idx, parsed
                else:
                    await asyncio.sleep(2)
            except Exception as e:
                msg = str(e)
                if '429' in msg:
                    wait = 15 * (attempt + 1)
                    print(f"  [{idx}] Rate limited, waiting {wait}s")
                    await asyncio.sleep(wait)
                else:
                    print(f"  [{idx}] Error: {msg[:80]}")
                    await asyncio.sleep(5)

    return idx, {"resumen": "", "palabras_clave": [], "preguntas": []}


async def main():
    chunks = json.load(open(IN_PATH, encoding="utf-8"))
    total = len(chunks)
    print(f"Loaded {total} chunks")

    # Load progress
    enriched = {}
    if os.path.exists(PROGRESS_PATH):
        enriched = json.load(open(PROGRESS_PATH, encoding="utf-8"))
        print(f"Resuming: {len(enriched)} already done")

    # Find chunks to process
    todo = [(i, c) for i, c in enumerate(chunks) if str(i) not in enriched]
    print(f"Remaining: {len(todo)} chunks")

    if not todo:
        print("Nothing to do!")
        return

    client = AsyncAzureOpenAI(
        api_version=API_VERSION,
        azure_endpoint=ENDPOINT,
        api_key=API_KEY,
    )

    semaphore = asyncio.Semaphore(CONCURRENCY)
    start_time = time.time()
    processed = 0
    errors = 0

    # Process in batches of SAVE_EVERY
    for batch_start in range(0, len(todo), SAVE_EVERY):
        batch = todo[batch_start:batch_start + SAVE_EVERY]

        tasks = [enrich_one(client, c, i, semaphore) for i, c in batch]
        results = await asyncio.gather(*tasks)

        for idx, result in results:
            enriched[str(idx)] = result
            if result.get('resumen'):
                processed += 1
            else:
                errors += 1

        # Save progress
        with open(PROGRESS_PATH, "w", encoding="utf-8") as f:
            json.dump(enriched, f, ensure_ascii=False)

        done = len(enriched)
        elapsed = time.time() - start_time
        rate = (processed + errors) / elapsed * 60 if elapsed > 0 else 0
        remaining_chunks = total - done
        eta = remaining_chunks / rate if rate > 0 else 0
        print(f"[{done}/{total}] {processed} ok, {errors} err | "
              f"{rate:.1f}/min | ETA: {eta:.0f}min")

    await client.close()

    # Merge enrichments into chunks
    print(f"\nMerging...")
    for i, chunk in enumerate(chunks):
        key = str(i)
        if key in enriched:
            chunk['resumen'] = enriched[key].get('resumen', '')
            chunk['palabras_clave'] = enriched[key].get('palabras_clave', [])
            chunk['preguntas'] = enriched[key].get('preguntas', [])
        else:
            chunk['resumen'] = ''
            chunk['palabras_clave'] = []
            chunk['preguntas'] = []

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    elapsed_total = time.time() - start_time
    print(f"\nDone! {processed} enriched, {errors} errors")
    print(f"Time: {elapsed_total/60:.1f} minutes")
    print(f"Saved to {OUT_PATH} ({os.path.getsize(OUT_PATH) / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    asyncio.run(main())
