import json

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks.json'))

# Show smallest chunks
print('=== SMALLEST CHUNKS ===')
small = sorted(chunks, key=lambda c: len(c['text']))[:8]
for c in small:
    print(f'[{len(c["text"])} chars] {c["law"][:50]} | {c["section"][:50]}')
    print(f'  TEXT: {c["text"][:120]}')
    print()

# Show chunks with 'Texto completo' (fallback single chunks)
print('=== FALLBACK SINGLE CHUNKS ===')
fb = [c for c in chunks if c['section'] == 'Texto completo']
print(f'Count: {len(fb)}')
for c in fb[:5]:
    print(f'  [{len(c["text"])} chars] {c["law"][:70]}')

# Show preamble chunks
print()
print('=== PREAMBLE CHUNKS ===')
pre = [c for c in chunks if 'Preambulo' in c['section']]
print(f'Count: {len(pre)}')
for c in pre[:5]:
    print(f'  [{len(c["text"])} chars] {c["law"][:70]}')

# Distribution
print()
print('=== SIZE DISTRIBUTION ===')
for threshold in [100, 200, 500, 1000, 2000, 3000, 5000, 6000, 8000]:
    count = sum(1 for c in chunks if len(c['text']) <= threshold)
    print(f'  <= {threshold}: {count}')
print(f'  > 8000: {sum(1 for c in chunks if len(c["text"]) > 8000)}')

# Count per law (top 10)
print()
print('=== TOP 10 LAWS BY CHUNK COUNT ===')
from collections import Counter
law_counts = Counter(c['law'] for c in chunks)
for law, count in law_counts.most_common(10):
    print(f'  {count:4d} chunks: {law[:75]}')
