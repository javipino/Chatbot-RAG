// Fix mislabeled chunks in normativa_chunks_enriched.json
// Problem: The PDF extractor split articles at mid-sentence "artículo X.Y" references,
// creating continuation chunks with wrong section metadata.
// Pattern: lowercase "artículo N" sections are continuations of the previous proper "Artículo N" section.

const fs = require('fs');
const path = require('path');

const CHUNKS_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_enriched.json');
const chunks = JSON.parse(fs.readFileSync(CHUNKS_PATH, 'utf-8'));

console.log(`Loaded ${chunks.length} chunks\n`);

// Strategy: For each chunk, if section starts with lowercase "artículo" (not "Artículo"),
// it's a continuation of a previous article. Walk backwards to find the last proper
// "Artículo N" section from the same law.

let fixCount = 0;
const fixes = [];

for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  const section = c.section || '';
  
  // Detect mislabeled: starts with lowercase "artículo" (a continuation, not a real header)
  if (section.match(/^artículo\s+\d/i) && !section.match(/^Artículo\s+\d/)) {
    // Walk backwards to find the parent article (same law, proper "Artículo N" section)
    let parentSection = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = chunks[j];
      if ((prev.law || '') !== (c.law || '')) break; // Different law, stop
      
      const prevSection = prev.section || '';
      if (prevSection.match(/^Artículo\s+\d/) || prevSection.match(/^Disposición\s+/i)) {
        // Found the parent — extract the base article title (without part numbers)
        parentSection = prevSection.replace(/\s*\(parte \d+\)$/, '');
        break;
      }
    }
    
    if (parentSection) {
      // Determine part number - count consecutive continuation chunks
      let partNum = 2; // The parent was part 1
      for (let k = i - 1; k >= 0; k--) {
        const prev = chunks[k];
        if ((prev.law || '') !== (c.law || '')) break;
        const prevSection = prev.section || '';
        // Count any chunk that's either the parent (part 1) or another continuation already fixed
        if (prevSection.match(/^Artículo\s+\d/) || prevSection.match(/^Disposición\s+/i)) {
          // This is the parent, check if it already has parts
          const partMatch = prevSection.match(/\(parte (\d+)\)$/);
          if (partMatch) {
            partNum = parseInt(partMatch[1]) + (i - k);
          } else {
            partNum = 1 + (i - k);
          }
          break;
        }
      }
      
      const newSection = `${parentSection} (parte ${partNum})`;
      fixes.push({
        index: i,
        oldSection: section.substring(0, 80),
        newSection: newSection,
        law: (c.law || '').substring(0, 60)
      });
      fixCount++;
    }
  }
}

console.log(`Found ${fixCount} chunks to fix:\n`);
for (const f of fixes.slice(0, 30)) {
  console.log(`  [${f.index}] "${f.oldSection}"`);
  console.log(`       → "${f.newSection}"`);
  console.log(`       law: ${f.law}`);
  console.log('');
}
if (fixes.length > 30) {
  console.log(`  ... and ${fixes.length - 30} more\n`);
}

// Check specific case: chunks 109-112
console.log('=== Art. 48 ET case (109-112) ===');
for (let i = 109; i <= 112; i++) {
  const fix = fixes.find(f => f.index === i);
  if (fix) {
    console.log(`  [${i}] "${fix.oldSection}" → "${fix.newSection}"`);
  } else {
    console.log(`  [${i}] "${(chunks[i].section || '').substring(0, 80)}" (no change needed)`);
  }
}
