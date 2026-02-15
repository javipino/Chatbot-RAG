// ── Stage 5b: Reference Expansion ──

const { fetchChunksByIds } = require('../services/qdrant');

const MAX_REFS_PER_CHUNK = 3;
const MAX_TOTAL_REFS = 15;       // Global cap on total reference chunks added
const REF_SCORE_FACTOR = 0.8;    // Refs inherit parentScore × this factor

// ── Law rank hierarchy for directional ref filtering ──
// Only follow refs that point to HIGHER or EQUAL rank laws
const LAW_RANK = {
    'Constitución Española [parcial]': 1,
    'Ley Orgánica de Libertad Sindical': 1,
    // Leyes orgánicas y estatutos
    'Texto refundido de la Ley del Estatuto de los Trabajadores': 2,
    'Texto refundido de la Ley General de la Seguridad Social': 2,
    'Ley del Estatuto del trabajo autónomo': 2,
    'Texto refundido de la Ley sobre Infracciones y Sanciones en el Orden Social': 2,
    'Ley reguladora de la jurisdicción social': 2,
    'Ley de Prevención de Riesgos Laborales': 2,
    'Ley de Empleo [parcial]': 2,
    'Ley de trabajo a distancia [parcial]': 2,
    'Ley de protección social de las personas trabajadoras del sector marítimo-pesquero': 2,
};
// Everything else (Reglamentos, RDs, Órdenes) defaults to rank 3+

function getLawRank(lawName) {
    if (!lawName) return 99;
    if (LAW_RANK[lawName] !== undefined) return LAW_RANK[lawName];
    // Classify by name patterns
    if (/^Ley\b/i.test(lawName)) return 2;
    if (/Reglamento General/i.test(lawName)) return 3;
    if (/Real Decreto/i.test(lawName)) return 4;
    return 5; // Órdenes, convenios, etc.
}

/**
 * Check if a ref target is a sibling (same article, different part)
 */
function isSibling(source, target) {
    if (!source.section || !target.section || source.law !== target.law) return false;
    // Extract base article number: "Artículo 308.  Cotización... (parte 2)" → "308"
    const getArtBase = (sec) => {
        const m = sec.match(/^Artículo\s+(\d+(?:\s*(?:bis|ter|quater|quinquies))?)/i);
        return m ? m[1].trim().toLowerCase() : null;
    };
    const srcArt = getArtBase(source.section);
    const tgtArt = getArtBase(target.section);
    return srcArt && tgtArt && srcArt === tgtArt && source.id !== target.id;
}

/**
 * Stage 5b: Expand pre-computed references from reranked results.
 * Filtering rules:
 *  1. Only follow refs pointing to HIGHER or EQUAL rank laws (upward direction)
 *  2. Always follow sibling refs (same article, different parts)
 *  3. Cap at MAX_REFS_PER_CHUNK per source chunk
 */
async function expandReferences(results, log) {
    const existingIds = new Set(results.map(r => r.id));
    const neededIds = new Set();
    const refSources = new Map(); // refId → source info for logging

    // First pass: collect all ref IDs to fetch (we need payload to filter)
    const allRefIds = new Set();
    for (const r of results) {
        for (const refId of (r.refs || [])) {
            if (!existingIds.has(refId)) allRefIds.add(refId);
        }
    }

    if (allRefIds.size === 0) {
        log('S5b-REFS', 'No pre-computed references to fetch');
        return { added: [], refsFound: 0 };
    }

    // Fetch all candidate refs in one batch
    log('S5b-REFS', `Fetching ${allRefIds.size} candidate refs to filter...`);
    const fetched = await fetchChunksByIds([...allRefIds]);
    const fetchedMap = new Map(fetched.map(f => [f.id, f]));

    // Second pass: apply directional + sibling filtering
    for (const r of results) {
        const refs = r.refs || [];
        if (refs.length === 0) continue;

        const srcRank = getLawRank(r.law);
        let kept = [];
        let skipped = [];

        for (const refId of refs) {
            if (existingIds.has(refId) || neededIds.has(refId)) continue;
            const target = fetchedMap.get(refId);
            if (!target) continue;

            const tgtRank = getLawRank(target.law);
            const isSib = isSibling(r, target);

            // Keep if: sibling OR target is higher/equal rank
            if (isSib || tgtRank <= srcRank) {
                kept.push({ id: refId, reason: isSib ? 'sibling' : 'upward', target });
            } else {
                skipped.push({ id: refId, target });
            }
        }

        // Cap per chunk
        kept = kept.slice(0, MAX_REFS_PER_CHUNK);

        if (kept.length > 0 || skipped.length > 0) {
            log('S5b-REFS', `id=${r.id} (${(r.section || '?').substring(0, 40)}) → ${kept.length} kept, ${skipped.length} filtered out`);
        }

        const parentScore = r.weightedScore || r.score || 0;
        for (const k of kept) {
            neededIds.add(k.id);
            const inheritedScore = parentScore * REF_SCORE_FACTOR;
            const existing = refSources.get(k.id);
            if (!existing || inheritedScore > existing.score) {
                refSources.set(k.id, { reason: k.reason, score: inheritedScore });
            }
        }
    }

    // Collect the filtered results, assign inherited scores
    let newResults = [...neededIds]
        .map(id => {
            const chunk = fetchedMap.get(id);
            if (!chunk || existingIds.has(chunk.id)) return null;
            const info = refSources.get(id);
            chunk._score = info ? info.score : 0;
            chunk._refReason = info ? info.reason : '?';
            return chunk;
        })
        .filter(Boolean);

    // Sort by inherited score descending, apply global cap
    newResults.sort((a, b) => (b._score || 0) - (a._score || 0));
    const beforeCap = newResults.length;
    if (newResults.length > MAX_TOTAL_REFS) {
        log('S5b-REFS', `Global cap: ${beforeCap} → ${MAX_TOTAL_REFS} refs (cut ${beforeCap - MAX_TOTAL_REFS} lowest-score)`);
        newResults = newResults.slice(0, MAX_TOTAL_REFS);
    }

    if (newResults.length > 0) {
        log('S5b-REFS', `Added ${newResults.length} referenced chunks${beforeCap > MAX_TOTAL_REFS ? ` (capped from ${beforeCap})` : ''} (${allRefIds.size - beforeCap} filtered out):`);
        newResults.forEach(r => {
            log('S5b-REFS', `  + id=${r.id} [${r._refReason}] score=${(r._score || 0).toFixed(4)} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 60)}`);
        });
    } else {
        log('S5b-REFS', `All ${allRefIds.size} candidate refs filtered out (no upward/sibling matches)`);
    }

    return { added: newResults, refsFound: allRefIds.size };
}

module.exports = { expandReferences };
