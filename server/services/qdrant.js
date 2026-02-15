// ── Qdrant vector database operations ──

const { httpsRequest } = require('./http');
const { QDRANT_URL, QDRANT_API_KEY, COLLECTIONS } = require('../config');

/**
 * Get Qdrant connection info from URL
 */
function qdrantConn() {
    const url = new URL(QDRANT_URL);
    return {
        hostname: url.hostname,
        port: url.port || 6333,
        headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
    };
}

/**
 * Hybrid search (dense + sparse RRF) in one collection
 * @param {string} collectionName
 * @param {number[]} denseVector
 * @param {{ indices: number[], values: number[] }|null} sparseVector
 * @param {number} topK
 * @returns {Promise<Object[]>} results with payload + score + collection
 */
async function searchCollection(collectionName, denseVector, sparseVector, topK = 10) {
    const conn = qdrantConn();

    const queryBody = {
        limit: topK,
        with_payload: true,
        prefetch: [
            { query: denseVector, using: 'text-dense', limit: 20 },
        ],
        query: { fusion: 'rrf' },
    };

    if (sparseVector) {
        queryBody.prefetch.push({
            query: { indices: sparseVector.indices, values: sparseVector.values },
            using: 'text-sparse',
            limit: 20,
        });
    }

    const result = await httpsRequest({
        hostname: conn.hostname,
        port: conn.port,
        path: `/collections/${collectionName}/points/query`,
        method: 'POST',
        headers: conn.headers,
    }, queryBody);

    return (result.result?.points || []).map(point => ({
        ...point.payload,
        score: point.score,
        collection: collectionName,
        id: point.id,
    }));
}

/**
 * Cross-collection search + weighted merge (top 20)
 */
async function searchAllCollections(denseVector, sparseVector) {
    const promises = COLLECTIONS.map(col =>
        searchCollection(col.name, denseVector, sparseVector, 10)
            .then(results => results.map(r => ({
                ...r,
                weightedScore: r.score * col.weight,
            })))
            .catch(err => {
                if (!err.message.includes('404')) {
                    console.warn(`Search in ${col.name} failed:`, err.message);
                }
                return [];
            })
    );

    const allResults = (await Promise.all(promises)).flat();
    allResults.sort((a, b) => b.weightedScore - a.weightedScore);
    return allResults.slice(0, 20);
}

/**
 * Fetch chunks by point IDs from normativa collection
 */
async function fetchChunksByIds(ids) {
    if (!ids.length) return [];
    const conn = qdrantConn();

    const result = await httpsRequest({
        hostname: conn.hostname,
        port: conn.port,
        path: '/collections/normativa/points',
        method: 'POST',
        headers: conn.headers,
    }, { ids, with_payload: true, with_vector: false });

    return (result.result || []).map(p => ({
        ...p.payload,
        score: 0.5,
        collection: 'normativa',
        id: p.id,
        _chased: true,
        _reason: 'Pre-computed reference',
    }));
}

/**
 * Fetch chunks by article reference — dual strategy (metadata filter + semantic fallback)
 * @param {Array<{art: string, ley: string}>} refs
 * @param {Function} embedFn - embed function for semantic search
 * @param {Function} buildSparseFn - sparse vector builder
 * @param {Function} log - logger
 */
async function fetchByArticleFilter(refs, embedFn, buildSparseFn, log) {
    const conn = qdrantConn();
    const allMatched = [];

    for (const ref of refs) {
        try {
            const artBase = ref.art.split('.')[0];
            const lawWords = ref.ley.replace(/Texto refundido de la Ley del?/gi, '').trim()
                .split(/\s+/).filter(w => w.length > 3).slice(0, 2).join(' ');
            const searchQuery = `Artículo ${ref.art} ${ref.ley}`;
            const seenIds = new Set();
            let points = [];

            // Strategy 1: Exact metadata filter
            try {
                const filterResult = await httpsRequest({
                    hostname: conn.hostname,
                    port: conn.port,
                    path: '/collections/normativa/points/scroll',
                    method: 'POST',
                    headers: conn.headers,
                }, {
                    limit: 5,
                    with_payload: true,
                    filter: {
                        must: [
                            { key: 'section', match: { text: `Artículo ${artBase}` } },
                            { key: 'law', match: { text: lawWords } },
                        ],
                    },
                });
                const filterPoints = filterResult.result?.points || [];
                log('S5c-FETCH', `  Filter found ${filterPoints.length} for Art.${artBase} (${lawWords})`);
                for (const p of filterPoints) { seenIds.add(p.id); points.push(p); }
            } catch (filterErr) {
                log('S5c-FETCH', `  Filter failed: ${filterErr.message}`);
            }

            // Strategy 2: Semantic search (robust — works even if metadata doesn't match)
            try {
                const refEmbedding = await embedFn(searchQuery);
                const refSparse = buildSparseFn(searchQuery);

                const prefetch = [
                    { query: refEmbedding, using: 'text-dense', limit: 10 },
                ];
                if (refSparse) {
                    prefetch.push({
                        query: { indices: refSparse.indices, values: refSparse.values },
                        using: 'text-sparse',
                        limit: 10,
                    });
                }

                const lawKeyword = lawWords.split(' ')[0];
                const semanticFilter = lawKeyword
                    ? { must: [{ key: 'law', match: { text: lawKeyword } }] }
                    : undefined;

                const queryBody = {
                    limit: 5,
                    with_payload: true,
                    prefetch,
                    query: { fusion: 'rrf' },
                };
                if (semanticFilter) queryBody.filter = semanticFilter;

                const semanticResult = await httpsRequest({
                    hostname: conn.hostname,
                    port: conn.port,
                    path: '/collections/normativa/points/query',
                    method: 'POST',
                    headers: conn.headers,
                }, queryBody);

                const semPoints = semanticResult.result?.points || [];
                log('S5c-FETCH', `  Semantic found ${semPoints.length} for "${searchQuery}"`);
                for (const p of semPoints) {
                    if (!seenIds.has(p.id)) { seenIds.add(p.id); points.push(p); }
                }
            } catch (semErr) {
                log('S5c-FETCH', `  Semantic fallback failed: ${semErr.message}`);
            }

            log('S5c-FETCH', `  Total: ${points.length} chunks for Art.${artBase} ${ref.ley}`);

            for (const p of points) {
                allMatched.push({
                    ...p.payload,
                    score: p.score || 0.5,
                    collection: 'normativa',
                    id: p.id,
                    _chased: true,
                    _reason: `Eval requested: Art.${ref.art} ${ref.ley}`,
                });
            }
        } catch (err) {
            log('S5c-FETCH', `  Chase failed for Art.${ref.art}: ${err.message}`);
        }
    }

    return allMatched;
}

module.exports = {
    searchCollection,
    searchAllCollections,
    fetchChunksByIds,
    fetchByArticleFilter,
};
