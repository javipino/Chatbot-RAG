"""Test enrichment on 10 diverse chunks and show raw quality."""
import json, time, os
from openai import AzureOpenAI

ENDPOINT = os.getenv("AZURE_OPENAI_READER_ENDPOINT", "https://openai-reader-javi.cognitiveservices.azure.com/")
API_KEY = os.environ["AZURE_OPENAI_READER_KEY"]  # Required
DEPLOYMENT = "gpt-5-nano"
API_VERSION = "2024-12-01-preview"

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks_v2.json'))

# Pick 10 diverse chunks: 0,1,2,3 (first ones) + some specific ones
test_indices = [0, 1, 2, 3]  # first 4 (these had issues)
# Add some good content chunks
for i, c in enumerate(chunks):
    if 'Artículo 1.' in c['section'] and 'Estatuto' in c['law']:
        test_indices.append(i); break
for i, c in enumerate(chunks):
    if 'Artículo 205.' in c['section'] and 'Seguridad Social' in c['law']:
        test_indices.append(i); break
for i, c in enumerate(chunks):
    if 'Disposición adicional' in c['section'] and len(c['text']) > 500:
        test_indices.append(i); break
# A short derogado
for i, c in enumerate(chunks):
    if len(c['text']) < 80 and 'Derogado' in c['text']:
        test_indices.append(i); break

client = AzureOpenAI(api_version=API_VERSION, azure_endpoint=ENDPOINT, api_key=API_KEY)

SYSTEM = """Eres un experto en legislación laboral y de Seguridad Social española.
Tu tarea es analizar fragmentos de normativa y generar metadatos útiles para un sistema de búsqueda RAG.
Responde SIEMPRE con JSON válido, sin texto adicional ni bloques de código markdown."""

for idx in test_indices:
    c = chunks[idx]
    text = c['text'][:3000]
    prompt = f"""Analiza este fragmento de legislación y devuelve un JSON con:
1. "resumen": Resumen de 1-2 frases en español llano explicando qué regula.
2. "palabras_clave": Lista de 5-8 conceptos clave para búsqueda semántica.
3. "preguntas": Lista de 3-4 preguntas que este artículo respondería, formuladas como las haría un ciudadano o profesional de RRHH.

LEY: {c['law']}
CAPÍTULO: {c.get('chapter', '')}
SECCIÓN: {c['section']}

TEXTO:
{text}

Responde SOLO con JSON válido."""

    print(f"\n{'='*70}")
    print(f"CHUNK [{idx}] section={c['section'][:50]} | text={len(c['text'])} chars")
    print(f"{'='*70}")

    try:
        resp = client.chat.completions.create(
            messages=[
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": prompt}
            ],
            max_completion_tokens=2048,
            model=DEPLOYMENT,
        )
        raw = resp.choices[0].message.content
        print(f"TOKENS: {resp.usage.prompt_tokens}+{resp.usage.completion_tokens}={resp.usage.total_tokens}")
        print(f"RAW RESPONSE:\n{raw[:1500]}")
        
        # Try parse
        clean = raw.strip() if raw else ""
        if clean.startswith('```'):
            clean = clean.split('\n', 1)[1] if '\n' in clean else clean[3:]
            if '```' in clean:
                clean = clean.rsplit('```', 1)[0]
        try:
            parsed = json.loads(clean)
            print(f"\nPARSED OK: resumen={len(parsed.get('resumen',''))} chars, "
                  f"keywords={len(parsed.get('palabras_clave',[]))}, "
                  f"questions={len(parsed.get('preguntas',[]))}")
            # Show keywords specifically
            print(f"KEYWORDS: {parsed.get('palabras_clave', [])}")
        except:
            print(f"\nPARSE FAILED")
    except Exception as e:
        print(f"API ERROR: {str(e)[:200]}")
    
    time.sleep(3)
