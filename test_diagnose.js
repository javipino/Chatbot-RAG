// Diagnose mislabeled chunks - understand the pattern
const fs = require('fs');
const chunks = JSON.parse(fs.readFileSync('data/chunks/normativa_chunks_enriched.json', 'utf-8'));

// Show chunks 107-115 with full section and first 200 chars of text
console.log('=== Chunks around Art. 48 ET (IDs 107-115) ===\n');
for (let i = 107; i <= 115 && i < chunks.length; i++) {
  const c = chunks[i];
  console.log(`[${i}] section: "${c.section}"`);
  console.log(`     law: "${(c.law || '').substring(0, 60)}"`);
  console.log(`     text (first 150): "${(c.text || '').substring(0, 150)}"`);
  console.log(`     text length: ${(c.text || '').length}`);
  console.log('');
}

// Now check: how many chunks have section starting with lowercase "artículo"?
// These are likely continuation chunks with inherited wrong section
const lowercase = chunks.filter(c => (c.section || '').match(/^artículo \d/));
console.log(`\n=== Chunks with lowercase "artículo" section: ${lowercase.length} total ===\n`);
for (const c of lowercase.slice(0, 20)) {
  const idx = chunks.indexOf(c);
  console.log(`  [${idx}] "${(c.section || '').substring(0, 80)}" | law: ${(c.law || '').substring(0, 40)} | ${(c.text || '').length} chars`);
}
if (lowercase.length > 20) console.log(`  ... (and ${lowercase.length - 20} more)`);

// Check: chunks where section doesn't match any "Artículo" pattern in text
// This detects chunks where text talks about a different article than section says
console.log('\n=== Spot-check: chunks where text mentions "Artículo 48" but section does NOT contain "48" ===\n');
const art48InText = chunks.filter(c => 
  (c.text || '').includes('Artículo 48.') &&
  !(c.section || '').includes('48') &&
  (c.law || '').includes('Estatuto')
);
for (const c of art48InText) {
  const idx = chunks.indexOf(c);
  console.log(`  [${idx}] section: "${(c.section || '').substring(0, 80)}"`);
  const textIdx = c.text.indexOf('Artículo 48.');
  console.log(`    text around Art.48 ref: "...${c.text.substring(Math.max(0, textIdx - 30), textIdx + 60)}..."`);
}
