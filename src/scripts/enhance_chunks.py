import fitz, json, re, os

PDF_PATH = "/home/javier/rag-ss/pdfs/normativa/CODIGO_Laboral_y_SS_BOE.pdf"
IN_PATH = "/home/javier/rag-ss/chunks/normativa_chunks_clean.json"
OUT_PATH = "/home/javier/rag-ss/chunks/normativa_chunks_v2.json"

# ── Step 1: Load PDF TOC and build hierarchy map ──
doc = fitz.open(PDF_PATH)
toc = doc.get_toc()
doc.close()

SECTION_SIGN = "\u00A7"  # §

# Build hierarchy: for each L3 article entry, find its L2 ancestors
# TOC structure: L1 = law (§ N. name), L2 = TÍTULO/CAPÍTULO/Sección, L3 = article

# First, build a map of all TOC entries with their hierarchy context
# For each TOC entry, walk backwards to find parent L2 and L1 entries
toc_hierarchy = {}  # key = (law_title_raw, article_title_normalized) -> chapter_path

current_l1 = ""
current_l2_stack = []  # stack of L2 entries (reset on new L1)

for i, (level, title, page) in enumerate(toc):
    title = title.strip()
    
    if level == 1:
        current_l1 = title
        current_l2_stack = []
    elif level == 2:
        # L2 might be nested (TÍTULO > CAPÍTULO > Sección)
        # Reset deeper levels when we see a new one at same or higher structural level
        # Simple approach: just track the stack
        
        # Determine structural depth of this L2 entry
        # Hierarchy order: LIBRO > TÍTULO > CAPÍTULO > SUBSECCIÓN > SECCIÓN
        t_upper = title.upper()
        if any(t_upper.startswith(x) for x in ['LIBRO']):
            current_l2_stack = [title]  # Reset everything
        elif any(t_upper.startswith(x) for x in ['TÍTULO', 'TITULO']):
            # Keep LIBRO, reset everything else
            current_l2_stack = [s for s in current_l2_stack 
                               if s.upper().startswith(('LIBRO',))]
            current_l2_stack.append(title)
        elif any(t_upper.startswith(x) for x in ['CAPÍTULO', 'CAPITULO', 'CAP.']):
            # Keep LIBRO + TÍTULO, reset CAPÍTULO and below
            current_l2_stack = [s for s in current_l2_stack 
                               if s.upper().startswith(('LIBRO', 'TÍTULO', 'TITULO'))]
            current_l2_stack.append(title)
        elif any(t_upper.startswith(x) for x in ['SUBSECCIÓN', 'SUBSECCION']):
            # Keep LIBRO + TÍTULO + CAPÍTULO, reset SUBSECCIÓN and below
            current_l2_stack = [s for s in current_l2_stack 
                               if s.upper().startswith(('LIBRO', 'TÍTULO', 'TITULO', 'CAPÍTULO', 'CAPITULO', 'CAP.'))]
            current_l2_stack.append(title)
        elif any(t_upper.startswith(x) for x in ['SECCIÓN', 'SECCION', 'SECC.']):
            # Keep everything above SECCIÓN
            current_l2_stack = [s for s in current_l2_stack 
                               if not s.upper().startswith(('SECCIÓN', 'SECCION', 'SECC.'))]
            current_l2_stack.append(title)
        else:
            # Other L2 entries (e.g., "Disposiciones adicionales")
            current_l2_stack = [s for s in current_l2_stack 
                               if s.upper().startswith(('LIBRO', 'TÍTULO', 'TITULO'))]
            current_l2_stack.append(title)
    elif level == 3:
        # Article entry - store its hierarchy
        # Normalize the title for matching
        art_norm = re.sub(r'\s+', ' ', title).strip()
        key = (current_l1, art_norm)
        chapter_path = " > ".join(current_l2_stack) if current_l2_stack else ""
        toc_hierarchy[key] = chapter_path

print(f"TOC hierarchy entries: {len(toc_hierarchy)}")

# Show some examples
examples = list(toc_hierarchy.items())[:5]
for (law, art), path in examples:
    print(f"  [{law[:50]}] {art[:40]} -> {path[:60]}")


# ── Step 2: Load chunks and enhance ──
chunks = json.load(open(IN_PATH, encoding="utf-8"))
print(f"\nLoaded {len(chunks)} chunks")


def clean_law_title(law):
    """Remove § N. prefix from law titles."""
    # "§ 71. Texto refundido de la Ley General..." -> "Texto refundido de la Ley General..."
    return re.sub(r'^§\s*\d+\.\s*', '', law).strip()


def clean_text(text):
    """Normalize line breaks: remove PDF column-break \n, keep paragraph \n\n."""
    # First, protect real paragraph breaks (double newline)
    text = text.replace('\n\n', '\x00PARA\x00')
    # Replace single newlines with space
    text = text.replace('\n', ' ')
    # Restore paragraph breaks as single newline
    text = text.replace('\x00PARA\x00', '\n')
    # Collapse multiple spaces
    text = re.sub(r'  +', ' ', text)
    # Clean up spaces around paragraph breaks
    text = re.sub(r' *\n *', '\n', text)
    # Collapse multiple paragraph breaks
    text = re.sub(r'\n{2,}', '\n', text)
    # Remove leading § N prefix from preamble text bodies
    text = re.sub(r'^§\s*\d+\s*', '', text)
    return text.strip()


def find_chapter(law_raw, section):
    """Find chapter context for a chunk by matching its section to TOC L3 entries."""
    # Normalize section title for matching
    sec_norm = re.sub(r'\s+', ' ', section).strip()
    # Remove "(parte N)" suffix
    sec_norm = re.sub(r'\s*\(parte \d+\)$', '', sec_norm).strip()
    
    # Try exact match first
    key = (law_raw, sec_norm)
    if key in toc_hierarchy:
        return toc_hierarchy[key]
    
    # Try fuzzy match: just the article number
    art_match = re.match(r'(Art[ií]culo\s+\d+[a-z]?(?:\s+bis|\s+ter|\s+qu[aá]ter)?\.)', sec_norm)
    if art_match:
        art_prefix = art_match.group(1)
        for (law_key, art_key), path in toc_hierarchy.items():
            if law_key == law_raw and art_key.startswith(art_prefix):
                return path
    
    # Try matching Disposiciones
    disp_match = re.match(r'(Disposici[oó]n\s+\w+\s+\w+)', sec_norm, re.IGNORECASE)
    if disp_match:
        disp_prefix = disp_match.group(1).lower()
        for (law_key, art_key), path in toc_hierarchy.items():
            if law_key == law_raw and art_key.lower().startswith(disp_prefix):
                return path
    
    return ""


# Process all chunks
enhanced = []
matched = 0
unmatched_examples = []

for c in chunks:
    law_raw = c['law']
    law_clean = clean_law_title(law_raw)
    section = c['section']
    text_clean = clean_text(c['text'])
    
    chapter = find_chapter(law_raw, section)
    if chapter:
        matched += 1
    elif section != "Preambulo / Exposicion de motivos" and section != "Texto completo":
        if len(unmatched_examples) < 5:
            unmatched_examples.append(f"  {law_raw[:50]} | {section[:50]}")
    
    chunk = {
        "law": law_clean,
        "chapter": chapter,
        "section": section,
        "text": text_clean,
    }
    if 'pages' in c:
        chunk['pages'] = c['pages']
    enhanced.append(chunk)

print(f"\nChapter matched: {matched}/{len(chunks)} ({matched*100//len(chunks)}%)")
if unmatched_examples:
    print(f"Unmatched examples:")
    for ex in unmatched_examples:
        print(ex)

# Stats
text_lens = [len(c['text']) for c in enhanced]
print(f"\n=== FINAL STATS ===")
print(f"Total chunks: {len(enhanced)}")
print(f"Avg size: {sum(text_lens)//len(text_lens)} chars")
print(f"Min: {min(text_lens)}, Max: {max(text_lens)}")

# Save
with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(enhanced, f, ensure_ascii=False, indent=2)
print(f"\nSaved to {OUT_PATH}")
print(f"File size: {os.path.getsize(OUT_PATH) / 1024 / 1024:.1f} MB")

# ── Show samples ──
print("\n=== SAMPLE ENHANCED CHUNKS ===")

# Find Art 205 LGSS
for c in enhanced:
    if 'Ley General de la Seguridad Social' in c['law'] and 'Artículo 205.' in c['section']:
        print(json.dumps(c, ensure_ascii=False, indent=2))
        break

print("\n---\n")

# Find ET Art 18
for c in enhanced:
    if 'Estatuto de los Trabajadores' in c['law'] and 'Artículo 18.' in c['section']:
        print(json.dumps(c, ensure_ascii=False, indent=2))
        break

print("\n---\n")

# Find a Disposición transitoria from LGSS
for c in enhanced:
    if 'Ley General de la Seguridad Social' in c['law'] and 'Disposición transitoria' in c['section'] and len(c['text']) > 300:
        print(json.dumps(c, ensure_ascii=False, indent=2))
        break

print("\n---\n")

# Preamble
for c in enhanced:
    if 'Estatuto de los Trabajadores' in c['law'] and 'Preambulo' in c['section']:
        print(json.dumps(c, ensure_ascii=False, indent=2)[:800])
        print("...")
        break
