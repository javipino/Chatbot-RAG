import json

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks_v2.json'))

# Check chapter paths for key LGSS articles
print("=== LGSS CHAPTER PATHS ===")
for c in chunks:
    if 'Ley General de la Seguridad Social' in c['law'] and c['chapter']:
        sec = c['section']
        if any(f'Artículo {n}.' in sec for n in [169, 170, 195, 200, 205, 210, 215, 248, 274]):
            print(f"  {sec[:55]}")
            print(f"    -> {c['chapter']}")
            print()

# Check some ET articles
print("=== ET CHAPTER PATHS ===")
for c in chunks:
    if 'Estatuto de los Trabajadores' in c['law'] and c['chapter']:
        sec = c['section']
        if any(f'Artículo {n}.' in sec for n in [1, 8, 18, 34, 47, 51, 64, 82]):
            print(f"  {sec[:55]}")
            print(f"    -> {c['chapter']}")
            print()

# Check unmatched chunks (empty chapter)
print("=== UNMATCHED CHUNKS (no chapter) ===")
unmatched = [c for c in chunks if not c['chapter'] and c['section'] != 'Preambulo / Exposicion de motivos']
print(f"Total: {len(unmatched)}")
for c in unmatched[:10]:
    print(f"  [{c['law'][:45]}] {c['section'][:55]}")
