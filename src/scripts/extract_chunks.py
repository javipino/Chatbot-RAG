import fitz, json, re, os

PDF_PATH = "/home/javier/rag-ss/pdfs/normativa/CODIGO_Laboral_y_SS_BOE.pdf"
OUT_DIR = "/home/javier/rag-ss/chunks"
os.makedirs(OUT_DIR, exist_ok=True)

doc = fitz.open(PDF_PATH)
toc = doc.get_toc()
num_pages = len(doc)

SECTION_SIGN = "\u00A7"  # §

# Step 1: Identify each law/norm (L1 entries starting with §)
laws = []
for i, entry in enumerate(toc):
    level, title, page = entry
    if level == 1 and title.strip().startswith(SECTION_SIGN):
        laws.append({"idx": i, "title": title.strip(), "start_page": page})

# Set end page for each law
for i in range(len(laws) - 1):
    laws[i]["end_page"] = laws[i + 1]["start_page"]
laws[-1]["end_page"] = num_pages + 1

print(f"Found {len(laws)} laws/norms")
for l in laws[:10]:
    print(f"  {l['title'][:80]}  (pp. {l['start_page']}-{l['end_page']-1})")
print("  ...")
for l in laws[-5:]:
    print(f"  {l['title'][:80]}  (pp. {l['start_page']}-{l['end_page']-1})")

# Step 2: For each law, extract text and split by article pattern
chunks = []
skip_sections = ["Sumario", "ndice Sistem"]

for law in laws:
    law_title = law["title"]
    # Skip index/summary pages
    if any(s in law_title for s in skip_sections):
        continue

    # Extract text page by page for this law
    start_p = law["start_page"] - 1  # 0-indexed
    end_p = min(law["end_page"] - 1, num_pages)  # exclusive, 0-indexed

    full_text = ""
    for p in range(start_p, end_p):
        full_text += doc[p].get_text() + "\n"

    # Split by article patterns
    # Artículo N. or Disposición adicional/transitoria/derogatoria/final
    art_pattern = re.compile(
        r'\n(Art[ií]culo\s+\d+[a-z]?(?:\s+bis|\s+ter|\s+qu[aá]ter|\s+quinquies|\s+sexies|\s+septies|\s+octies)?\.\s*[^\n]*)\n'
        r'|'
        r'\n(Disposici[oó]n\s+(?:adicional|transitoria|derogatoria|final)\s+[^\n]*)\n',
        re.IGNORECASE
    )

    splits = list(art_pattern.finditer(full_text))

    if not splits:
        # No articles found, store as single chunk
        if len(full_text.strip()) > 100:
            chunks.append({
                "law": law_title,
                "section": "Texto completo",
                "text": full_text.strip()[:8000],
                "pages": f"{law['start_page']}-{law['end_page']-1}"
            })
        continue

    # Also capture preamble text before first article
    preamble = full_text[:splits[0].start()].strip()
    if len(preamble) > 200:
        chunks.append({
            "law": law_title,
            "section": "Preambulo / Exposicion de motivos",
            "text": preamble[:8000],
        })

    # Create chunks between article matches
    for j, match in enumerate(splits):
        art_title = (match.group(1) or match.group(2)).strip()
        start_pos = match.start()
        end_pos = splits[j + 1].start() if j + 1 < len(splits) else len(full_text)

        text = full_text[start_pos:end_pos].strip()

        # Clean up common PDF artifacts
        # Fix hyphenated line breaks: "word-\nrest" -> "wordrest"
        text = re.sub(r'(\w)-\n(\w)', r'\1\2', text)
        # Collapse multiple blank lines
        text = re.sub(r'\n{3,}', '\n\n', text)

        # Skip very short chunks (headers only)
        if len(text) < 50:
            continue

        # Sub-chunk if excessively long (>6000 chars)
        if len(text) > 6000:
            # Try to split at paragraph boundaries
            paragraphs = text.split('\n\n')
            current_chunk = ""
            part_num = 1
            for para in paragraphs:
                if len(current_chunk) + len(para) > 5500 and current_chunk:
                    chunks.append({
                        "law": law_title,
                        "section": f"{art_title} (parte {part_num})",
                        "text": current_chunk.strip(),
                    })
                    part_num += 1
                    current_chunk = para + "\n\n"
                else:
                    current_chunk += para + "\n\n"
            if current_chunk.strip():
                suffix = f" (parte {part_num})" if part_num > 1 else ""
                chunks.append({
                    "law": law_title,
                    "section": art_title + suffix,
                    "text": current_chunk.strip(),
                })
        else:
            chunks.append({
                "law": law_title,
                "section": art_title,
                "text": text.strip(),
            })

doc.close()

print(f"\nTotal chunks: {len(chunks)}")

# Show some stats
text_lens = [len(c["text"]) for c in chunks]
print(f"Avg chunk size: {sum(text_lens)//len(text_lens)} chars")
print(f"Min: {min(text_lens)}, Max: {max(text_lens)}")
print(f"Median: {sorted(text_lens)[len(text_lens)//2]}")
print(f"Chunks > 5000 chars: {sum(1 for l in text_lens if l > 5000)}")
print(f"Chunks < 200 chars: {sum(1 for l in text_lens if l < 200)}")

# Show unique laws
law_names = set(c["law"] for c in chunks)
print(f"\nUnique laws/norms: {len(law_names)}")

# Show sample
print("\n=== SAMPLE CHUNKS ===")
for c in chunks[50:53]:
    print(f"\n--- {c['law'][:70]}")
    print(f"    {c['section'][:70]} ---")
    print(c["text"][:500])
    print(f"[{len(c['text'])} chars]")

# Save
out_path = os.path.join(OUT_DIR, "normativa_chunks.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(chunks, f, ensure_ascii=False, indent=2)
print(f"\nSaved to {out_path}")
print(f"File size: {os.path.getsize(out_path) / 1024 / 1024:.1f} MB")
