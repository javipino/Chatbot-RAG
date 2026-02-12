"""Quick test: enrich just 3 chunks to verify API connectivity and response quality."""
import json, re, time, os
from urllib.request import Request, urlopen

IN_PATH = "/home/javier/rag-ss/chunks/normativa_chunks_v2.json"

AZURE_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "https://javie-mku5l3k8-swedencentral.cognitiveservices.azure.com")
DEPLOYMENT = "gpt-5-nano"
API_VERSION = "2025-01-01-preview"
API_KEY = os.environ["AZURE_OPENAI_KEY"]  # Required
URL = f"{AZURE_ENDPOINT}/openai/deployments/{DEPLOYMENT}/chat/completions?api-version={API_VERSION}"

SYSTEM_PROMPT = """Eres un experto en Derecho Laboral y de la Seguridad Social española. 
Tu tarea es enriquecer fragmentos de normativa legal para mejorar su búsqueda semántica.

Para cada fragmento, genera EXACTAMENTE este JSON (sin texto adicional):
{
  "resumen": "Resumen claro en 1-2 frases en español llano, explicando qué regula este artículo y sus puntos clave.",
  "palabras_clave": ["palabra1", "palabra2", ...],
  "preguntas": ["¿Pregunta que este artículo responde?", "¿Otra pregunta?", "¿Otra más?"]
}

Reglas:
- El resumen debe ser comprensible para un ciudadano sin formación jurídica.
- Las palabras_clave deben incluir conceptos jurídicos relevantes (3-8 palabras).
- Las preguntas deben ser las que un ciudadano o profesional de RRHH haría y que este artículo responde (2-4 preguntas).
- Responde SOLO con el JSON, sin explicaciones ni markdown."""

chunks = json.load(open(IN_PATH, encoding="utf-8"))

# Pick 3 interesting test chunks
test_indices = []
for i, c in enumerate(chunks):
    # Art 205 LGSS (jubilación)
    if 'Ley General de la Seguridad Social' in c['law'] and 'Artículo 205.' in c['section']:
        test_indices.append(i); break
for i, c in enumerate(chunks):
    # ET Art 34 (jornada)
    if 'Estatuto de los Trabajadores' in c['law'] and 'Artículo 34.' in c['section'] and 'parte' not in c['section']:
        test_indices.append(i); break
for i, c in enumerate(chunks):
    # Short derogado
    if len(c['text']) < 100 and 'Derogado' in c['text']:
        test_indices.append(i); break

for idx in test_indices:
    c = chunks[idx]
    print(f"\n{'='*70}")
    print(f"CHUNK: {c['law'][:60]}")
    print(f"       {c['section'][:60]}")
    print(f"       [{len(c['text'])} chars]")
    
    context = f"Ley: {c['law']}"
    if c.get('chapter'):
        context += f"\nCapítulo: {c['chapter']}"
    context += f"\nSección: {c['section']}"
    user_msg = f"{context}\n\nTexto del artículo:\n{c['text'][:4000]}"
    
    payload = json.dumps({
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg}
        ],
        "temperature": 0.3,
        "max_tokens": 500
    }).encode("utf-8")
    
    headers = {"Content-Type": "application/json", "api-key": API_KEY}
    
    start = time.time()
    req = Request(URL, data=payload, headers=headers, method="POST")
    with urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    elapsed = time.time() - start
    
    usage = result.get("usage", {})
    content = result["choices"][0]["message"]["content"].strip()
    content = re.sub(r'^```json?\s*', '', content)
    content = re.sub(r'\s*```$', '', content)
    
    print(f"\nTokens: {usage.get('prompt_tokens', '?')} in / {usage.get('completion_tokens', '?')} out | {elapsed:.1f}s")
    print(f"\nRESPONSE:")
    enrichment = json.loads(content)
    print(json.dumps(enrichment, ensure_ascii=False, indent=2))
