import json, re, os

IN_PATH = "/home/javier/rag-ss/chunks/normativa_chunks.json"
OUT_PATH = "/home/javier/rag-ss/chunks/normativa_chunks_clean.json"

chunks = json.load(open(IN_PATH, encoding="utf-8"))
print(f"Loaded {len(chunks)} chunks")

def clean_text(text):
    """Remove PDF headers, footers, and page numbers from extracted text."""
    
    # Pattern 1: Full header block (most common)
    # "CÓDIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n§ N  Law title...\n– N –"
    text = re.sub(
        r'\nC[OÓ]DIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n'
        r'[^\n]*\n'           # § line (law reference)
        r'(?:–\s*\d+\s*–\n)?',  # optional page number
        '\n',
        text
    )
    
    # Pattern 1b: Header without § line
    text = re.sub(
        r'\nC[OÓ]DIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n'
        r'(?:–\s*\d+\s*–\n)?',
        '\n',
        text
    )
    
    # Pattern 2: Standalone page numbers "– N –" on their own line
    text = re.sub(r'\n–\s*\d+\s*–\n', '\n', text)
    
    # Pattern 3: Alternative page number format "- N -"
    text = re.sub(r'\n-\s*\d+\s*-\n', '\n', text)
    
    # Pattern 4: "Página N de N" footer
    text = re.sub(r'\nP[aá]gina\s+\d+\s+de\s+\d+\n', '\n', text)
    
    # Pattern 5: BOE header lines (standalone, not inline references)
    # "BOLETÍN OFICIAL DEL ESTADO" as a standalone header line
    text = re.sub(
        r'\nBOLET[IÍ]N OFICIAL DEL ESTADO\n'
        r'(?:N[uú]m\.\s*\d+[^\n]*\n)?'   # optional "Núm. 123" line
        r'(?:Sec\.\s*[IVX]+[^\n]*\n)?',   # optional "Sec. I" line
        '\n',
        text
    )
    
    # Pattern 6: CVE-BOE reference lines
    text = re.sub(r'\n[Cc]ve:\s*BOE-[A-Z]-\d+-\d+[^\n]*\n', '\n', text)
    text = re.sub(r'\nVerificable en https?://www\.boe\.es[^\n]*\n', '\n', text)
    
    # Clean up: collapse multiple blank lines
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    # Clean up: fix hyphenated line breaks "word-\nrest" -> "wordrest"
    text = re.sub(r'(\w)-\n(\w)', r'\1\2', text)
    
    return text.strip()


# Apply cleaning
cleaned_chunks = []
total_removed_chars = 0

for c in chunks:
    original_len = len(c['text'])
    cleaned = clean_text(c['text'])
    total_removed_chars += original_len - len(cleaned)
    
    # Only keep chunks with meaningful content after cleaning
    if len(cleaned) >= 30:
        c['text'] = cleaned
        cleaned_chunks.append(c)

print(f"Chunks after cleaning: {len(cleaned_chunks)} (removed {len(chunks) - len(cleaned_chunks)} empty)")
print(f"Total characters removed: {total_removed_chars:,}")

# Verify: re-check for remaining patterns
patterns = {
    "CODIGO LABORAL": re.compile(r'C[OÓ]DIGO LABORAL', re.IGNORECASE),
    "page_dash": re.compile(r'\n–\s*\d+\s*–'),
    "page_hyphen": re.compile(r'\n-\s*\d+\s*-'),
    "BOLETIN": re.compile(r'BOLET[IÍ]N OFICIAL DEL ESTADO'),
}

print("\n=== REMAINING PATTERNS ===")
for name, pat in patterns.items():
    count = sum(1 for c in cleaned_chunks if pat.search(c['text']))
    print(f"  {name}: {count}/{len(cleaned_chunks)}")

# Stats
text_lens = [len(c['text']) for c in cleaned_chunks]
print(f"\n=== CLEANED STATS ===")
print(f"Total chunks: {len(cleaned_chunks)}")
print(f"Avg size: {sum(text_lens)//len(text_lens)} chars")
print(f"Min: {min(text_lens)}, Max: {max(text_lens)}")
print(f"Median: {sorted(text_lens)[len(text_lens)//2]}")
print(f"Chunks < 200: {sum(1 for l in text_lens if l < 200)}")
print(f"Chunks > 5000: {sum(1 for l in text_lens if l > 5000)}")

# Show before/after examples
print("\n=== SAMPLE CLEANED CHUNKS ===")
import random
random.seed(42)
sample_indices = random.sample(range(len(cleaned_chunks)), 5)
for i in sample_indices:
    c = cleaned_chunks[i]
    print(f"\n--- {c['law'][:65]}")
    print(f"    {c['section'][:65]} [{len(c['text'])} chars] ---")
    print(c['text'][:400])
    print("...")

# Save
with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(cleaned_chunks, f, ensure_ascii=False, indent=2)
print(f"\nSaved to {OUT_PATH}")
print(f"File size: {os.path.getsize(OUT_PATH) / 1024 / 1024:.1f} MB")
