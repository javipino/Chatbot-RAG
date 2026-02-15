// ── RAG route — full pipeline orchestration ──
// Pipeline: S1 (expand) → S2-S4 (search) → S5b (refs) → S5 (unified answer+eval)

const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const { expandQuery } = require('../pipeline/expand');
const { searchAll } = require('../pipeline/search');
const { expandReferences } = require('../pipeline/enrich');
const { buildContext, generateAnswer } = require('../pipeline/answer');
const { fetchChunksByIds, fetchByArticleFilter } = require('../services/qdrant');
const { embed } = require('../services/openai');
const { buildSparseVector } = require('../services/tfidf');

const router = express.Router();

const CARRYOVER_SCORE = 0.5;     // Default score for carryover chunks (USED in previous turn)
const MAX_CHUNKS_TO_MODEL = 25;  // Max chunks sent to GPT-5.2

router.post('/', requireApiKey, async (req, res) => {
    try {
        const messages = req.body?.messages || [];
        const previousChunkIds = req.body?.previousChunkIds || [];
        if (!messages.length) {
            return res.status(400).json({ error: 'No messages provided' });
        }

        const userMessage = messages.filter(m => m.role === 'user').pop();
        if (!userMessage) {
            return res.status(400).json({ error: 'No user message found' });
        }

        const query = userMessage.content;
        const hasCarryover = previousChunkIds.length > 0;
        const LOG = (stage, msg) => console.log(`[${stage}] ${msg}`);
        LOG('INIT', `Query: "${query.substring(0, 150)}"`);
        if (hasCarryover) LOG('INIT', `Carryover: ${previousChunkIds.length} chunk IDs from previous turn`);

        // ── Stage 1: Query Expansion ──
        let expandedQueries;
        try {
            expandedQueries = await expandQuery(query, messages, hasCarryover);
        } catch (e) { e._ragStage = '1-Expand'; throw e; }
        LOG('S1-EXPAND', `${expandedQueries.length} queries generated:`);
        expandedQueries.forEach((q, i) => LOG('S1-EXPAND', `  [${i}] "${q}"`));

        // ── Carryover: fetch previous context chunks ──
        let carryoverChunks = [];
        if (hasCarryover) {
            try {
                carryoverChunks = await fetchChunksByIds(previousChunkIds);
                carryoverChunks.forEach(c => { c._carryover = true; });
                LOG('CARRYOVER', `Fetched ${carryoverChunks.length}/${previousChunkIds.length} chunks from previous turn`);
            } catch (e) {
                LOG('CARRYOVER', `ERROR (non-fatal): ${e.message}`);
            }
        }

        // ── Stages 2-4: Embed + Sparse + Hybrid Search ──
        let searchResults = [], debugSearchDetail = {};
        if (expandedQueries.length > 0) {
            try {
                const searchOutput = await searchAll(expandedQueries, LOG);
                searchResults = searchOutput.results;
                debugSearchDetail = searchOutput.debugDetail;
            } catch (e) { e._ragStage = '2-4-Search'; throw e; }
        } else {
            LOG('S2-S4', 'No new queries — using carryover context only');
        }

        LOG('S4-RESULTS', `Search returned ${searchResults.length} candidates:`);
        searchResults.forEach((r, i) => {
            LOG('S4-RESULTS', `  [${i}] id=${r.id} score=${(r.weightedScore || r.score || 0).toFixed(4)} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 80)}`);
        });

        // ── Merge carryover chunks (previous turn context, prepended for priority) ──
        let mergedResults = [...searchResults];
        if (carryoverChunks.length > 0) {
            const newIds = new Set(searchResults.map(r => r.id));
            const uniqueCarryover = carryoverChunks.filter(c => !newIds.has(c.id));
            LOG('CARRYOVER', `Merging ${uniqueCarryover.length} carryover chunks (${carryoverChunks.length - uniqueCarryover.length} already in new results)`);
            mergedResults = [...uniqueCarryover, ...searchResults];
        }

        // ── Stage 5b: Reference Expansion ──
        let allResults = [...mergedResults];
        let debugRefChasing = { refsFound: 0, chasedAdded: 0, error: null };
        try {
            const refOutput = await expandReferences(mergedResults, LOG);
            allResults = [...allResults, ...refOutput.added];
            debugRefChasing.refsFound = refOutput.refsFound;
            debugRefChasing.chasedAdded = refOutput.added.length;
        } catch (refErr) {
            debugRefChasing.error = refErr.message;
            LOG('S5b-REFS', `ERROR (non-fatal): ${refErr.message}`);
        }

        // ── Scoring & Cap: normalize scores, sort, trim ──
        for (const r of allResults) {
            if (r._score == null) {
                r._score = r._carryover ? CARRYOVER_SCORE : (r.weightedScore || r.score || 0);
            }
        }
        allResults.sort((a, b) => (b._score || 0) - (a._score || 0));
        if (allResults.length > MAX_CHUNKS_TO_MODEL) {
            LOG('S5-CAP', `Trimming ${allResults.length} → ${MAX_CHUNKS_TO_MODEL} chunks (cut ${allResults.length - MAX_CHUNKS_TO_MODEL} lowest-score)`);
            allResults = allResults.slice(0, MAX_CHUNKS_TO_MODEL);
        }

        // ── Stage 5: Unified Answer + Evaluation (GPT-5.2) ──
        LOG('S5-ANSWER', `Context: ${allResults.length} chunks`);
        allResults.forEach((r, i) => {
            const tag = r._carryover ? ' [CARRY]' : r._refReason ? ' [REF]' : '';
            LOG('S5-ANSWER', `  [${i}] id=${r.id} score=${(r._score || 0).toFixed(4)} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 80)}${tag}`);
        });

        const ragContext = buildContext(allResults);
        LOG('S5-ANSWER', `Context size: ${ragContext.length} chars`);

        let answerResult;
        try {
            answerResult = await generateAnswer(ragContext, messages);
        } catch (e) { e._ragStage = '5-Answer(GPT-5.2)'; throw e; }

        const { answer, used, drop, need } = answerResult;
        LOG('S5-ANSWER', `Response length: ${answer.length} chars`);
        LOG('S5-ANSWER', `USED indices: [${used.join(',')}]`);
        LOG('S5-ANSWER', `DROP indices: [${drop.join(',')}]`);
        if (need.length > 0) LOG('S5-ANSWER', `NEED: ${need.map(n => n.type === 'article' ? `Art.${n.art} ${n.ley}` : `Q:"${n.query}"`).join(', ')}`);

        // ── NEED iteration: if GPT-5.2 requests missing info, fetch & retry once ──
        let finalAnswer = answer;
        if (need.length > 0) {
            LOG('S5-NEED', `Fetching ${need.length} NEED requests...`);
            try {
                const existingIds = new Set(allResults.map(r => r.id));
                let allNewChunks = [];

                // Split NEEDs by type
                const articleNeeds = need.filter(n => n.type === 'article');
                const queryNeeds = need.filter(n => n.type === 'query');

                // Fetch article-specific NEEDs
                if (articleNeeds.length > 0) {
                    LOG('S5-NEED', `Fetching ${articleNeeds.length} article requests: ${articleNeeds.map(n => `Art.${n.art} ${n.ley}`).join(', ')}`);
                    const articleChunks = await fetchByArticleFilter(articleNeeds, embed, buildSparseVector, LOG);
                    allNewChunks.push(...articleChunks.filter(r => !existingIds.has(r.id)));
                }

                // Fetch query-type NEEDs via search pipeline
                if (queryNeeds.length > 0) {
                    const queries = queryNeeds.map(n => n.query);
                    LOG('S5-NEED', `Running ${queries.length} search queries: ${queries.map(q => `"${q}"`).join(', ')}`);
                    const searchOutput = await searchAll(queries, LOG);
                    allNewChunks.push(...searchOutput.results.filter(r => !existingIds.has(r.id)));
                }

                // Dedup
                const seenNew = new Set();
                const newChased = allNewChunks.filter(r => {
                    if (seenNew.has(r.id) || existingIds.has(r.id)) return false;
                    seenNew.add(r.id);
                    return true;
                });
                LOG('S5-NEED', `Got ${newChased.length} new chunks`);

                if (newChased.length > 0) {
                    // Score NEED chunks and merge
                    for (const r of newChased) {
                        if (r._score == null) r._score = r.weightedScore || r.score || 0.3;
                    }
                    allResults = [...allResults, ...newChased];
                    // Re-sort and soft-cap retry (allow +5 over base cap for NEED)
                    allResults.sort((a, b) => (b._score || 0) - (a._score || 0));
                    const retryCap = MAX_CHUNKS_TO_MODEL + 5;
                    if (allResults.length > retryCap) {
                        LOG('S5-NEED', `Retry cap: ${allResults.length} → ${retryCap} chunks`);
                        allResults = allResults.slice(0, retryCap);
                    }
                    const ragContext2 = buildContext(allResults);
                    LOG('S5-NEED', `Retrying answer with ${allResults.length} chunks (${ragContext2.length} chars)`);
                    const answerResult2 = await generateAnswer(ragContext2, messages);
                    finalAnswer = answerResult2.answer;
                    // Update used/drop from retry
                    used.length = 0; used.push(...answerResult2.used);
                    drop.length = 0; drop.push(...answerResult2.drop);
                    LOG('S5-NEED', `Retry USED: [${answerResult2.used.join(',')}], DROP: [${answerResult2.drop.join(',')}]`);
                }
            } catch (needErr) {
                LOG('S5-NEED', `ERROR (non-fatal): ${needErr.message}`);
            }
        }

        // ── Build contextChunkIds for carryover (exclude DROP indices) ──
        const dropSet = new Set(drop);
        const contextChunkIds = allResults
            .map((r, i) => dropSet.has(i) ? null : r.id)
            .filter(id => id !== null);
        // Deduplicate
        const uniqueContextIds = [...new Set(contextChunkIds)];

        LOG('S5-ANSWER', `Carryover: ${uniqueContextIds.length} chunk IDs (${drop.length} dropped)`);

        // Build response
        const sources = allResults
            .filter((_, i) => !dropSet.has(i))
            .map(r => ({
                id: r.id,
                law: r.law || '',
                section: r.section || '',
                chapter: r.chapter || '',
                collection: r.collection,
                _carryover: r._carryover || false,
            }));

        res.json({
            choices: [{ message: { role: 'assistant', content: finalAnswer } }],
            sources,
            contextChunkIds: uniqueContextIds,
            _debug: {
                expandedQueries: expandedQueries.map(q => q.substring(0, 150)),
                searchDetail: debugSearchDetail,
                searchResults: searchResults.length,
                refChasing: debugRefChasing,
                usedIndices: used,
                dropIndices: drop,
                needRequests: need,
                totalSources: allResults.length,
                finalSources: allResults.map((r, i) => ({
                    id: r.id,
                    law: r.law || '',
                    section: (r.section || '').substring(0, 60),
                    collection: r.collection,
                    dropped: dropSet.has(i),
                    carryover: r._carryover || false,
                })),
            },
        });

    } catch (err) {
        const stage = err._ragStage || 'unknown';
        const detail = err.message || String(err);
        console.error(`RAG error [Stage ${stage}]:`, detail);
        res.status(500).json({ error: `[Stage ${stage}] ${detail}` });
    }
});

module.exports = router;
