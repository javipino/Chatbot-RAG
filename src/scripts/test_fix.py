"""Quick retest on the 2 chunks that failed."""
import json, time, os
from openai import AzureOpenAI

ENDPOINT = os.getenv("AZURE_OPENAI_READER_ENDPOINT", "https://openai-reader-javi.cognitiveservices.azure.com/")
API_KEY = os.environ["AZURE_OPENAI_READER_KEY"]  # Required

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks_v2.json'))
client = AzureOpenAI(api_version="2024-12-01-preview", azure_endpoint=ENDPOINT, api_key=API_KEY)

SYSTEM = """Eres un experto en legislación laboral y de Seguridad Social española.
Responde SIEMPRE con JSON válido, sin texto adicional ni bloques de código markdown."""

for idx in [2825, 168]:
    c = chunks[idx]
    text = c['text'][:2000]  # reduced
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

    print(f"\n{'='*60}")
    print(f"CHUNK [{idx}] {c['section'][:50]} | {len(c['text'])} chars (sent {len(text)})")
    
    resp = client.chat.completions.create(
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt}
        ],
        max_completion_tokens=4096,
        model="gpt-5-nano",
    )
    raw = resp.choices[0].message.content
    print(f"TOKENS: {resp.usage.prompt_tokens}+{resp.usage.completion_tokens}={resp.usage.total_tokens}")
    print(f"finish_reason: {resp.choices[0].finish_reason}")
    
    if raw:
        clean = raw.strip()
        if clean.startswith('```'):
            clean = clean.split('\n', 1)[1] if '\n' in clean else clean[3:]
            if '```' in clean:
                clean = clean.rsplit('```', 1)[0]
        try:
            parsed = json.loads(clean)
            print(f"OK! keywords: {parsed.get('palabras_clave', [])}")
            print(f"resumen: {parsed.get('resumen', '')[:200]}")
        except:
            print(f"PARSE FAILED. Raw: {raw[:300]}")
    else:
        print(f"EMPTY RESPONSE")
    
    time.sleep(3)
