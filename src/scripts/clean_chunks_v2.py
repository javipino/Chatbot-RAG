import json, re, os

IN_PATH = "/home/javier/rag-ss/chunks/normativa_chunks.json"  # Start from original
OUT_PATH = "/home/javier/rag-ss/chunks/normativa_chunks_clean.json"

chunks = json.load(open(IN_PATH, encoding="utf-8"))
print(f"Loaded {len(chunks)} chunks")

def clean_text(text):
    """Remove PDF headers, footers, and page numbers from extracted text."""
    
    # Fix hyphenated line breaks FIRST: "word-\nrest" -> "wordrest"
    # This must happen before header removal to avoid mid-word joins
    text = re.sub(r'(\w)-\n(\w)', r'\1\2', text)
    
    # Pattern 1: Full header block (3-line: title + § ref + page num)
    text = re.sub(
        r'C[OÓ]DIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n'
        r'[^\n]*\n'                  # § reference line
        r'(?:–\s*\d+\s*–\s*\n?)?',  # optional page number
        '',
        text
    )
    
    # Pattern 1b: Header with just page number (no § line)
    text = re.sub(
        r'C[OÓ]DIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n'
        r'(?:–\s*\d+\s*–\s*\n?)?',
        '',
        text
    )
    
    # Pattern 2: Standalone page numbers "– N –" (with OR without trailing newline)
    text = re.sub(r'\n–\s*\d+\s*–\s*(?:\n|$)', '\n', text)
    # Also at start of text
    text = re.sub(r'^–\s*\d+\s*–\s*\n', '', text)
    
    # Pattern 3: Alternative page number format "- N -"
    text = re.sub(r'\n-\s*\d+\s*-\s*(?:\n|$)', '\n', text)
    
    # Pattern 4: "Página N de N"
    text = re.sub(r'\nP[aá]gina\s+\d+\s+de\s+\d+\s*(?:\n|$)', '\n', text)
    
    # Pattern 5: BOE header block
    text = re.sub(
        r'BOLET[IÍ]N OFICIAL DEL ESTADO\n'
        r'(?:N[uú]m\.\s*\d+[^\n]*\n)?'
        r'(?:Sec\.\s*[IVX]+[^\n]*\n)?',
        '',
        text
    )
    
    # Pattern 6: CVE/verificable lines
    text = re.sub(r'\n[Cc]ve:\s*BOE-[A-Z]-\d+-\d+[^\n]*(?:\n|$)', '\n', text)
    text = re.sub(r'\nVerificable en https?://www\.boe\.es[^\n]*(?:\n|$)', '\n', text)
    
    # Pattern 7: "[. . .]" markers (BOE omission markers, usually near page breaks)
    # Only remove if on their own line
    text = re.sub(r'\n\[\s*\.\s*\.\s*\.\s*\]\s*(?:\n|$)', '\n', text)
    
    # Clean up: collapse multiple blank lines
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    return text.strip()


# Apply cleaning
cleaned_chunks = []
total_removed_chars = 0

for c in chunks:
    original_len = len(c['text'])
    cleaned = clean_text(c['text'])
    total_removed_chars += original_len - len(cleaned)
    
    if len(cleaned) >= 30:
        c['text'] = cleaned
        cleaned_chunks.append(c)

print(f"Chunks after cleaning: {len(cleaned_chunks)} (removed {len(chunks) - len(cleaned_chunks)} empty)")
print(f"Total characters removed: {total_removed_chars:,}")

# Verify remaining patterns
patterns = {
    "CODIGO LABORAL": re.compile(r'C[OÓ]DIGO LABORAL', re.IGNORECASE),
    "page_dash": re.compile(r'–\s*\d+\s*–'),
    "page_hyphen": re.compile(r'\n-\s*\d+\s*-'),
    "BOLETIN": re.compile(r'BOLET[IÍ]N OFICIAL DEL ESTADO'),
    "CVE-BOE": re.compile(r'cve.*BOE', re.IGNORECASE),
}

print("\n=== REMAINING PATTERNS ===")
for name, pat in patterns.items():
    count = sum(1 for c in cleaned_chunks if pat.search(c['text']))
    if count > 0:
        # Show first example
        for c in cleaned_chunks:
            m = pat.search(c['text'])
            if m:
                start = max(0, m.start() - 40)
                end = min(len(c['text']), m.end() + 40)
                ctx = c['text'][start:end].replace('\n', '\\n')
                print(f"  {name}: {count} remaining — e.g. ...{ctx}...")
                break
    else:
        print(f"  {name}: 0 remaining ✓")

# Stats
text_lens = [len(c['text']) for c in cleaned_chunks]
print(f"\n=== FINAL STATS ===")
print(f"Total chunks: {len(cleaned_chunks)}")
print(f"Avg size: {sum(text_lens)//len(text_lens)} chars")
print(f"Min: {min(text_lens)}, Max: {max(text_lens)}")
print(f"Median: {sorted(text_lens)[len(text_lens)//2]}")
print(f"< 100 chars: {sum(1 for l in text_lens if l < 100)}")
print(f"< 200 chars: {sum(1 for l in text_lens if l < 200)}")
print(f"> 5000 chars: {sum(1 for l in text_lens if l > 5000)}")

# Save
with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(cleaned_chunks, f, ensure_ascii=False, indent=2)
print(f"\nSaved to {OUT_PATH}")
print(f"File size: {os.path.getsize(OUT_PATH) / 1024 / 1024:.1f} MB")

# Show 3 cleaned samples
print("\n=== SAMPLE CLEANED CHUNKS ===")
for c in cleaned_chunks[100:103]:
    print(f"\n--- {c['law'][:65]}")
    print(f"    {c['section'][:65]} [{len(c['text'])} chars] ---")
    print(c['text'][:500])
    print()
