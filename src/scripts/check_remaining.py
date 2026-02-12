import json, re

chunks = json.load(open('/home/javier/rag-ss/chunks/normativa_chunks_clean.json'))

# Check remaining "CODIGO LABORAL" chunks
print("=== REMAINING CODIGO LABORAL ===")
for c in chunks:
    if re.search(r'C[OÓ]DIGO LABORAL', c['text']):
        # Find context
        m = re.search(r'C[OÓ]DIGO LABORAL', c['text'])
        start = max(0, m.start() - 80)
        end = min(len(c['text']), m.end() + 80)
        ctx = c['text'][start:end].replace('\n', '\\n')
        print(f"\n  {c['section'][:60]}")
        print(f"  ...{ctx}...")

# Check remaining page number patterns - show context
print("\n=== SAMPLE REMAINING PAGE NUMBERS ===")
count = 0
for c in chunks:
    matches = list(re.finditer(r'–\s*\d+\s*–', c['text']))
    if matches:
        count += 1
        if count <= 8:
            m = matches[0]
            start = max(0, m.start() - 60)
            end = min(len(c['text']), m.end() + 60)
            ctx = c['text'][start:end].replace('\n', '\\n')
            print(f"\n  [{c['section'][:50]}]")
            print(f"  ...{ctx}...")
print(f"\nTotal with remaining page nums: {count}")

# Check if page nums are at START of text (from being at beginning of a page)
at_start = 0
inline = 0
for c in chunks:
    matches = list(re.finditer(r'–\s*\d+\s*–', c['text']))
    for m in matches:
        before = c['text'][:m.start()].rstrip()
        if before.endswith('\n') or m.start() < 10:
            at_start += 1
        else:
            inline += 1
print(f"Page nums after newline: {at_start}, mid-line: {inline}")
