// ── Stages 2-4: Embed + Sparse + Hybrid Search ──
// Runs all expanded queries in parallel: embed → sparse → searchAllCollections → merge & dedup

const { embed } = require('../services/openai');
const { buildSparseVector } = require('../services/tfidf');
const { searchAllCollections } = require('../services/qdrant');

const SINGLE_QUERY_RESULTS = 10;
const MULTI_QUERY_TOTAL_RESULTS = 16;
const MULTI_QUERY_MIN_PER_QUERY = 3;

function computeSearchBudget(queryCount) {
    if (queryCount <= 1) {
        return { perQueryLimit: SINGLE_QUERY_RESULTS, totalLimit: SINGLE_QUERY_RESULTS };
    }

    const perQueryLimit = Math.max(
        MULTI_QUERY_MIN_PER_QUERY,
        Math.floor(MULTI_QUERY_TOTAL_RESULTS / queryCount)
    );
    const totalLimit = perQueryLimit * queryCount;

    return { perQueryLimit, totalLimit };
}

/**
 * Execute parallel hybrid search for all expanded queries
 * @param {string[]} expandedQueries - Array of search queries from Stage 1
 * @param {Function} log - Tagged logger
 * @returns {Promise<{ results: Object[], debugDetail: Object[] }>}
 */
async function searchAll(expandedQueries, log) {
    const allSearchResults = [];
    const seenIds = new Set();
    const debugDetail = [];
    const queryCount = expandedQueries.length;
    const { perQueryLimit, totalLimit } = computeSearchBudget(queryCount);

    log('S4-BUDGET', `Queries=${queryCount}, perQuery=${perQueryLimit}, totalCap=${totalLimit}`);

    // Run all queries in parallel (each does embed + sparse + search)
    const queryPromises = expandedQueries.map(async (expandedQuery, qi) => {
        // Stage 2: Embed
        const embedding = await embed(expandedQuery);
        log('S2-EMBED', `Query[${qi}] embedded → ${embedding.length} dims`);

        // Stage 3: Sparse vector
        const sparseVector = buildSparseVector(expandedQuery);
        if (sparseVector) {
            log('S3-SPARSE', `Query[${qi}] sparse → ${sparseVector.indices.length} terms`);
        } else {
            log('S3-SPARSE', `Query[${qi}] sparse → NULL (no matching terms)`);
        }

        // Stage 4: Cross-collection hybrid search
        const results = await searchAllCollections(embedding, sparseVector, perQueryLimit);
        const byCol = {};
        results.forEach(r => { byCol[r.collection] = (byCol[r.collection] || 0) + 1; });
        log('S4-SEARCH', `Query[${qi}] → ${results.length} results: ${Object.entries(byCol).map(([c, n]) => `${c}:${n}`).join(', ')}`);
        results.forEach((r, i) => {
            log('S4-SEARCH', `  [${i}] id=${r.id} score=${(r.weightedScore || r.score || 0).toFixed(4)} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 60)}`);
        });

        return { queryIndex: qi, results };
    });

    const allResultSets = await Promise.all(queryPromises);

    // Merge and deduplicate
    let dupeCount = 0;
    for (const { queryIndex, results: resultSet } of allResultSets) {
        debugDetail.push({
            queryIndex,
            query: expandedQueries[queryIndex].substring(0, 100),
            count: resultSet.length,
            topIds: resultSet.slice(0, 5).map(r => r.id),
        });

        for (const r of resultSet) {
            if (!seenIds.has(r.id)) {
                seenIds.add(r.id);
                allSearchResults.push(r);
            } else {
                dupeCount++;
                const existingIdx = allSearchResults.findIndex(x => x.id === r.id);
                if (existingIdx >= 0 && r.weightedScore > allSearchResults[existingIdx].weightedScore) {
                    allSearchResults[existingIdx] = r;
                }
            }
        }
    }

    // Sort by weighted score and apply global budget cap
    allSearchResults.sort((a, b) => (b.weightedScore || b.score) - (a.weightedScore || a.score));
    const results = allSearchResults.slice(0, totalLimit);
    log('S4-MERGE', `Total unique: ${allSearchResults.length}, dupes removed: ${dupeCount}, kept top ${totalLimit}: ${results.length}`);

    return { results, debugDetail };
}

module.exports = { searchAll };
