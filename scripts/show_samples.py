import json, random

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks_clean.json'))
random.seed(123)

# Pick diverse samples: from different laws, different sizes
# 1. Short chunk
# 2. Medium chunk from ET
# 3. Medium chunk from LGSS
# 4. Long chunk (sub-chunked)
# 5. Disposicion adicional/transitoria
# 6. Preamble chunk
# 7. A "parcial" law chunk
# 8. Random chunk

samples = []

# 1. Short chunk (<300 chars)
short = [c for c in chunks if len(c['text']) < 300 and len(c['text']) > 50]
samples.append(("SHORT CHUNK", random.choice(short)))

# 2. ET article
et = [c for c in chunks if 'Estatuto de los Trabajadores' in c['law'] and 'Preambulo' not in c['section'] and 1000 < len(c['text']) < 3000]
samples.append(("ET ARTICLE", random.choice(et)))

# 3. LGSS article
lgss = [c for c in chunks if 'Ley General de la Seguridad Social' in c['law'] and 'parte' not in c['section'] and 1000 < len(c['text']) < 3000]
samples.append(("LGSS ARTICLE", random.choice(lgss)))

# 4. Long sub-chunked
long = [c for c in chunks if '(parte' in c['section'] and len(c['text']) > 4000]
samples.append(("LONG SUB-CHUNK", random.choice(long)))

# 5. Disposicion
disp = [c for c in chunks if 'Disposici' in c['section'] and 500 < len(c['text']) < 2000]
samples.append(("DISPOSICION", random.choice(disp)))

# 6. Preamble
pre = [c for c in chunks if 'Preambulo' in c['section'] and len(c['text']) > 500]
samples.append(("PREAMBLE", random.choice(pre)))

# 7. Parcial law
parc = [c for c in chunks if 'parcial' in c['law'] and 'Preambulo' not in c['section'] and len(c['text']) > 500]
samples.append(("PARCIAL LAW", random.choice(parc)))

# 8. Completely random
samples.append(("RANDOM", random.choice(chunks)))

# Print full text for each
for label, c in samples:
    print(f"\n{'='*80}")
    print(f"  [{label}] — {len(c['text'])} chars")
    print(f"  LAW: {c['law']}")
    print(f"  SECTION: {c['section']}")
    if 'pages' in c:
        print(f"  PAGES: {c['pages']}")
    print(f"{'='*80}")
    # Print FULL text for short/medium, first+last 800 chars for long
    if len(c['text']) <= 2500:
        print(c['text'])
    else:
        print(c['text'][:1200])
        print(f"\n  [...{len(c['text'])-2400} chars omitted...]\n")
        print(c['text'][-1200:])
    print()
