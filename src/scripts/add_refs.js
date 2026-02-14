/**
 * add_refs.js — Pre-compute inter-chunk references offline
 * 
 * For each chunk, parses its text to find legal article references,
 * resolves them to chunk indices in the corpus, and stores as a `refs` array.
 * 
 * Reference types:
 *  1. Same-law references: "artículo 48", "art. 12.3" → same law
 *  2. Cross-law references: "artículo 48 del Estatuto de los Trabajadores" → ET
 *  3. Multi-part articles: Art.48 references all its (parte N) chunks
 *  4. Disposiciones: "disposición transitoria tercera" within same law
 * 
 * Output: normativa_chunks_v3_enriched.json with added `refs` field per chunk
 *         Each ref = chunk index (number) in the same array
 * 
 * Usage: node src/scripts/add_refs.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_v3_enriched.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Law name aliases → canonical law name in corpus ──
// Maps short names / abbreviations found in text to the law field in chunks
const LAW_ALIASES = {
    // Estatuto de los Trabajadores
    'estatuto de los trabajadores': 'Texto refundido de la Ley del Estatuto de los Trabajadores',
    'ley del estatuto de los trabajadores': 'Texto refundido de la Ley del Estatuto de los Trabajadores',
    'texto refundido de la ley del estatuto de los trabajadores': 'Texto refundido de la Ley del Estatuto de los Trabajadores',
    'et': 'Texto refundido de la Ley del Estatuto de los Trabajadores',

    // LGSS
    'ley general de la seguridad social': 'Texto refundido de la Ley General de la Seguridad Social',
    'texto refundido de la ley general de la seguridad social': 'Texto refundido de la Ley General de la Seguridad Social',
    'lgss': 'Texto refundido de la Ley General de la Seguridad Social',

    // LETA
    'estatuto del trabajo autónomo': 'Ley del Estatuto del trabajo autónomo',
    'ley del estatuto del trabajo autónomo': 'Ley del Estatuto del trabajo autónomo',
    'leta': 'Ley del Estatuto del trabajo autónomo',

    // LISOS
    'ley sobre infracciones y sanciones en el orden social': 'Texto refundido de la Ley sobre Infracciones y Sanciones en el Orden Social',
    'lisos': 'Texto refundido de la Ley sobre Infracciones y Sanciones en el Orden Social',
    'ley de infracciones y sanciones': 'Texto refundido de la Ley sobre Infracciones y Sanciones en el Orden Social',

    // Constitución
    'constitución': 'Constitución Española [parcial]',
    'constitución española': 'Constitución Española [parcial]',
    'ce': 'Constitución Española [parcial]',

    // LRJS
    'ley reguladora de la jurisdicción social': 'Ley reguladora de la jurisdicción social',
    'lrjs': 'Ley reguladora de la jurisdicción social',

    // LO Libertad Sindical
    'ley orgánica de libertad sindical': 'Ley Orgánica de Libertad Sindical',
    'lols': 'Ley Orgánica de Libertad Sindical',

    // Ley de Empleo
    'ley de empleo': 'Ley de Empleo [parcial]',

    // Ley de Prevención de Riesgos Laborales
    'ley de prevención de riesgos laborales': 'Ley de Prevención de Riesgos Laborales',
    'lprl': 'Ley de Prevención de Riesgos Laborales',

    // Ley de trabajo a distancia
    'ley de trabajo a distancia': 'Ley de trabajo a distancia [parcial]',
};

// ── Build article index ──
function buildIndex(chunks) {
    // law -> artNum -> [chunk indices]
    const byLawArt = {};
    // law -> "disp_tipo_ordinal" -> [chunk indices]  (disposiciones)
    const byLawDisp = {};

    for (let i = 0; i < chunks.length; i++) {
        const law = chunks[i].law || '';
        const sec = chunks[i].section || '';

        // Articles: "Artículo 48", "Artículo 48 bis", etc.
        const artMatch = sec.match(/^Artículo\s+(\d+(?:\s*bis|\s*ter|\s*quater|\s*quinquies)?(?:\.\d+)?)/i);
        if (artMatch) {
            const artKey = normalizeArtNum(artMatch[1]);
            if (!byLawArt[law]) byLawArt[law] = {};
            if (!byLawArt[law][artKey]) byLawArt[law][artKey] = [];
            byLawArt[law][artKey].push(i);
        }

        // Disposiciones
        const dispMatch = sec.match(/^Disposición\s+(adicional|transitoria|derogatoria|final)\s+(\w+)/i);
        if (dispMatch) {
            const dispKey = `disp_${dispMatch[1].toLowerCase()}_${dispMatch[2].toLowerCase()}`;
            if (!byLawDisp[law]) byLawDisp[law] = {};
            if (!byLawDisp[law][dispKey]) byLawDisp[law][dispKey] = [];
            byLawDisp[law][dispKey].push(i);
        }
    }

    return { byLawArt, byLawDisp };
}

function normalizeArtNum(raw) {
    // "48 bis" → "48bis", "48.3" → "48.3", " 48 " → "48"
    return raw.trim().replace(/\s+/g, '').toLowerCase();
}

// ── Extract references from text ──
function extractRefs(text, selfLaw, index) {
    const refs = new Set();

    // Pattern 1: "artículo(s) N" with optional law name after
    // Captures: artículo 48, artículos 47 y 48, art. 12.3, arts. 51 y 52
    const artPattern = /(?:artículos?|arts?\.)\s*([\d]+(?:\s*bis|\s*ter|\s*quater|\s*quinquies)?(?:\.\d+)?(?:\s*(?:,\s*|\s+y\s+|\s+a\s+)\s*\d+(?:\s*bis|\s*ter)?(?:\.\d+)?)*)\s*(?:del?\s+(?:la\s+)?(?:texto\s+refundido\s+de\s+(?:la\s+)?)?(?:ley\s+(?:del?\s+|orgánica\s+de\s+|general\s+de\s+(?:la\s+)?|reguladora\s+de\s+la\s+)?)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ\s]+(?:del?\s+los?\s+)?[A-Za-záéíóúñ\s]*?)(?:[.,;)\s]|$))?/gi;
    
    let m;
    while ((m = artPattern.exec(text)) !== null) {
        const numsRaw = m[1];
        const lawContext = m[2] ? m[2].trim().replace(/\s+$/, '') : null;

        // Determine target law
        let targetLaw = selfLaw;
        if (lawContext) {
            const resolved = resolveLawName(lawContext);
            if (resolved) targetLaw = resolved;
        }

        // Extract all article numbers from the match
        const nums = numsRaw.match(/\d+(?:\s*(?:bis|ter|quater|quinquies))?(?:\.\d+)?/gi) || [];
        for (const n of nums) {
            refs.add(JSON.stringify({ law: targetLaw, art: normalizeArtNum(n) }));
        }
    }

    // Pattern 2: Abbreviated law references — "art. 48 ET", "art. 177 LGSS"
    const abbrPattern = /(?:artículos?|arts?\.)\s*(\d+(?:\s*bis|\s*ter)?(?:\.\d+)?(?:\s*(?:,\s*|\s+y\s+)\s*\d+(?:\s*bis|\s*ter)?(?:\.\d+)?)*)\s+(?:del?\s+)?(ET|LGSS|LETA|LISOS|CE|LRJS|LOLS|LPRL)\b/gi;
    while ((m = abbrPattern.exec(text)) !== null) {
        const nums = m[1].match(/\d+(?:\s*(?:bis|ter))?(?:\.\d+)?/gi) || [];
        const abbr = m[2].toLowerCase();
        const targetLaw = LAW_ALIASES[abbr];
        if (targetLaw) {
            for (const n of nums) {
                refs.add(JSON.stringify({ law: targetLaw, art: normalizeArtNum(n) }));
            }
        }
    }

    // Pattern 3: Disposiciones within same law
    const dispPattern = /disposición\s+(adicional|transitoria|derogatoria|final)\s+(\w+)/gi;
    while ((m = dispPattern.exec(text)) !== null) {
        refs.add(JSON.stringify({ law: selfLaw, disp: `disp_${m[1].toLowerCase()}_${m[2].toLowerCase()}` }));
    }

    return [...refs].map(r => JSON.parse(r));
}

function resolveLawName(rawName) {
    // Try exact match first
    const lower = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
    if (LAW_ALIASES[lower]) return LAW_ALIASES[lower];

    // Try partial match
    for (const [alias, canonical] of Object.entries(LAW_ALIASES)) {
        if (lower.includes(alias) || alias.includes(lower)) {
            return canonical;
        }
    }
    return null;
}

// ── Resolve references to chunk indices ──
function resolveRefs(parsedRefs, selfLaw, selfIndex, index) {
    const { byLawArt, byLawDisp } = index;
    const resolved = new Set();

    for (const ref of parsedRefs) {
        if (ref.art) {
            const law = ref.law || selfLaw;
            const artKey = ref.art;

            // Try exact match
            let chunks = byLawArt[law]?.[artKey];

            // If no exact match and artKey has decimals like "48.4", try base "48"
            if (!chunks && artKey.includes('.')) {
                const base = artKey.split('.')[0];
                chunks = byLawArt[law]?.[base];
            }

            if (chunks) {
                for (const idx of chunks) {
                    if (idx !== selfIndex) resolved.add(idx);
                }
            }
        }

        if (ref.disp) {
            const law = ref.law || selfLaw;
            const chunks = byLawDisp[law]?.[ref.disp];
            if (chunks) {
                for (const idx of chunks) {
                    if (idx !== selfIndex) resolved.add(idx);
                }
            }
        }
    }

    return [...resolved].sort((a, b) => a - b);
}

// ── Main ──
function main() {
    console.log('Loading chunks...');
    const chunks = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
    console.log(`Loaded ${chunks.length} chunks`);

    console.log('\nBuilding article index...');
    const index = buildIndex(chunks);
    const lawCount = Object.keys(index.byLawArt).length;
    let artCount = 0;
    for (const law in index.byLawArt) artCount += Object.keys(index.byLawArt[law]).length;
    console.log(`  ${lawCount} laws, ${artCount} unique articles indexed`);

    console.log('\nExtracting and resolving references...');
    let totalRefs = 0;
    let chunksWithRefs = 0;
    let maxRefs = 0;
    let maxRefsChunk = -1;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const selfLaw = chunk.law || '';
        const text = chunk.text || '';

        // Extract raw references from text
        const parsedRefs = extractRefs(text, selfLaw);

        // Resolve to chunk indices
        const resolvedRefs = resolveRefs(parsedRefs, selfLaw, i, index);

        // Add sibling references: if this chunk is part N of an article,
        // link to all other parts of the same article
        const sec = chunk.section || '';
        const artMatch = sec.match(/^Artículo\s+(\d+(?:\s*bis|\s*ter|\s*quater|\s*quinquies)?(?:\.\d+)?)/i);
        if (artMatch) {
            const artKey = normalizeArtNum(artMatch[1]);
            const siblings = index.byLawArt[selfLaw]?.[artKey] || [];
            for (const sib of siblings) {
                if (sib !== i) resolvedRefs.push(sib);
            }
        }

        // Deduplicate and sort
        chunk.refs = [...new Set(resolvedRefs)].sort((a, b) => a - b);

        if (chunk.refs.length > 0) {
            chunksWithRefs++;
            totalRefs += chunk.refs.length;
            if (chunk.refs.length > maxRefs) {
                maxRefs = chunk.refs.length;
                maxRefsChunk = i;
            }
        }

        if (i % 1000 === 0) process.stdout.write(`  ${i}/${chunks.length}\r`);
    }

    console.log(`\n\n=== Results ===`);
    console.log(`Chunks with refs: ${chunksWithRefs} / ${chunks.length} (${(100*chunksWithRefs/chunks.length).toFixed(1)}%)`);
    console.log(`Total refs: ${totalRefs}`);
    console.log(`Average refs per chunk (with refs): ${(totalRefs/chunksWithRefs).toFixed(1)}`);
    console.log(`Max refs: ${maxRefs} (chunk ${maxRefsChunk}: "${chunks[maxRefsChunk].section?.substring(0, 60)}")`);

    // Show some examples
    console.log('\n=== Sample refs ===');
    const samples = [
        // ET articles with many cross-refs
        ...chunks.map((c, i) => ({ i, ...c }))
            .filter(c => c.law.includes('Estatuto de los Trabajadores') && c.refs.length >= 3)
            .slice(0, 5),
        // LGSS samples
        ...chunks.map((c, i) => ({ i, ...c }))
            .filter(c => c.law.includes('Seguridad Social') && c.refs.length >= 3)
            .slice(0, 3)
    ];

    for (const s of samples) {
        console.log(`\n  [${s.i}] ${s.section?.substring(0, 60)}`);
        console.log(`       law: ${s.law.substring(0, 50)}`);
        console.log(`       refs (${s.refs.length}): ${s.refs.slice(0, 10).map(r => {
            const rc = chunks[r];
            return `[${r}]${rc.section?.substring(0, 30)}`;
        }).join(', ')}`);
    }

    // Distribution histogram
    console.log('\n=== Ref count distribution ===');
    const dist = {};
    for (const c of chunks) {
        const bucket = c.refs.length === 0 ? '0' : c.refs.length <= 2 ? '1-2' : c.refs.length <= 5 ? '3-5' : c.refs.length <= 10 ? '6-10' : '11+';
        dist[bucket] = (dist[bucket] || 0) + 1;
    }
    for (const [bucket, count] of Object.entries(dist)) {
        console.log(`  ${bucket}: ${count} chunks`);
    }

    if (!DRY_RUN) {
        console.log('\nSaving...');
        fs.writeFileSync(INPUT, JSON.stringify(chunks, null, 2), 'utf-8');
        console.log(`Saved ${chunks.length} chunks with refs to ${INPUT}`);
    } else {
        console.log('\n[DRY RUN] Not saving.');
    }
}

main();
