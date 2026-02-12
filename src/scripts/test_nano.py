from openai import AzureOpenAI
import json
import os

endpoint = os.getenv("AZURE_OPENAI_READER_ENDPOINT", "https://openai-reader-javi.cognitiveservices.azure.com/")
api_key = os.environ["AZURE_OPENAI_READER_KEY"]  # Required
deployment = "gpt-5-nano"
api_version = "2024-12-01-preview"

client = AzureOpenAI(
    api_version=api_version,
    azure_endpoint=endpoint,
    api_key=api_key,
)

# Load one sample chunk
chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks_v2.json'))
sample = next(c for c in chunks if 'Artículo 205.' in c['section'] and 'Seguridad Social' in c['law'])

prompt = f"""Analiza este fragmento de legislación española y devuelve un JSON con:
1. "resumen": Resumen de 1-2 frases en español llano (sin jerga legal innecesaria) explicando qué regula este artículo.
2. "palabras_clave": Lista de 5-10 palabras/conceptos clave para búsqueda (en español).
3. "preguntas": Lista de 3-5 preguntas frecuentes que este artículo respondería, formuladas como las haría un ciudadano o un profesional de RRHH.

LEY: {sample['law']}
CAPÍTULO: {sample['chapter']}
SECCIÓN: {sample['section']}

TEXTO:
{sample['text'][:3000]}

Responde SOLO con el JSON, sin explicaciones adicionales."""

print(f"Sending request for: {sample['section']}")
print(f"Input text length: {len(sample['text'])} chars")
print()

response = client.chat.completions.create(
    messages=[
        {"role": "system", "content": "Eres un experto en legislación laboral y de Seguridad Social española. Respondes siempre en JSON válido."},
        {"role": "user", "content": prompt}
    ],
    max_completion_tokens=4096,
    model=deployment,
)

result = response.choices[0].message.content
print("=== RAW RESPONSE ===")
print(result)
print()
print(f"Usage: {response.usage.prompt_tokens} prompt + {response.usage.completion_tokens} completion = {response.usage.total_tokens} total")
print()

# Try to parse
try:
    # Strip markdown code fences if present
    clean = result.strip()
    if clean.startswith('```'):
        clean = clean.split('\n', 1)[1].rsplit('```', 1)[0]
    parsed = json.loads(clean)
    print("=== PARSED JSON ===")
    print(json.dumps(parsed, ensure_ascii=False, indent=2))
except Exception as e:
    print(f"Parse error: {e}")
