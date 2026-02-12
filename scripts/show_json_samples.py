import json, random

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks_clean.json'))
random.seed(77)

# Pick 6 diverse chunks
indices = []
# 1. ET article
for i,c in enumerate(chunks):
    if 'Estatuto de los Trabajadores' in c['law'] and 'Artículo 18.' in c['section']:
        indices.append(i); break
# 2. LGSS article
for i,c in enumerate(chunks):
    if 'Ley General de la Seguridad Social' in c['law'] and 'Artículo 205.' in c['section'] and 'parte' not in c['section']:
        indices.append(i); break
# 3. Short derogado
for i,c in enumerate(chunks):
    if len(c['text']) < 100 and 'Derogado' in c['text']:
        indices.append(i); break
# 4. Disposicion
for i,c in enumerate(chunks):
    if 'Disposición transitoria' in c['section'] and 'Seguridad Social' in c['law'] and 500 < len(c['text']) < 2000:
        indices.append(i); break
# 5. Preamble
for i,c in enumerate(chunks):
    if 'Preambulo' in c['section'] and 'Estatuto de los Trabajadores' in c['law']:
        indices.append(i); break
# 6. Random
indices.append(random.choice(range(len(chunks))))

for idx in indices:
    print(json.dumps(chunks[idx], ensure_ascii=False, indent=2))
    print(",")
