import json, re
from collections import Counter

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks.json'))

# Check for common header/footer patterns in extracted text
patterns = {
    "BOLETÍN OFICIAL": re.compile(r'BOLET[IÍ]N OFICIAL', re.IGNORECASE),
    "CÓDIGO LABORAL": re.compile(r'C[OÓ]DIGO LABORAL', re.IGNORECASE),
    "www.boe.es": re.compile(r'www\.boe\.es'),
    "LEGISLACIÓN CONSOLIDADA": re.compile(r'LEGISLACI[OÓ]N CONSOLIDADA', re.IGNORECASE),
    "Página N de N": re.compile(r'P[aá]gina\s+\d+\s+de\s+\d+', re.IGNORECASE),
    "– N –": re.compile(r'–\s*\d+\s*–'),
    "- N -": re.compile(r'-\s*\d+\s*-'),
    "Verificable en": re.compile(r'[Vv]erificable en'),
    "CVE-BOE": re.compile(r'CVE-BOE'),
    "cve:": re.compile(r'cve:', re.IGNORECASE),
    "Núm.": re.compile(r'N[uú]m\.\s*\d+'),
    "Sec.": re.compile(r'Sec\.\s*[IVX]+'),
}

print("=== HEADER/FOOTER PATTERN FREQUENCY ===")
for name, pat in patterns.items():
    count = sum(1 for c in chunks if pat.search(c['text']))
    if count > 0:
        print(f"  {name}: found in {count}/{len(chunks)} chunks ({count*100//len(chunks)}%)")

# Show actual examples of contaminated chunks
print("\n=== SAMPLE CONTAMINATED TEXT ===")
for c in chunks[100:200]:
    text = c['text']
    for name, pat in patterns.items():
        m = pat.search(text)
        if m:
            start = max(0, m.start() - 60)
            end = min(len(text), m.end() + 60)
            context = text[start:end].replace('\n', '\\n')
            print(f"\n[{name}] in: {c['section'][:50]}")
            print(f"  ...{context}...")
            break

# Also check first and last lines of random chunks for page numbers
print("\n=== FIRST/LAST LINES OF SAMPLE CHUNKS ===")
import random
random.seed(42)
sample = random.sample(chunks, 20)
for c in sample:
    lines = c['text'].split('\n')
    first_3 = ' | '.join(l.strip() for l in lines[:3] if l.strip())[:120]
    last_3 = ' | '.join(l.strip() for l in lines[-3:] if l.strip())[:120]
    print(f"\nChunk: {c['section'][:60]}")
    print(f"  FIRST: {first_3}")
    print(f"  LAST:  {last_3}")
