// ── RAG route — full pipeline orchestration ──

const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const { expandQuery } = require('../pipeline/expand');
const { searchAll } = require('../pipeline/search');
const { rerankResults } = require('../pipeline/rerank');
const { expandReferences, evaluateAndEnrich } = require('../pipeline/enrich');
const { buildContext, generateAnswer } = require('../pipeline/answer');

const router = express.Router();

router.post('/', requireApiKey, async (req, res) => {
    try {
        const messages = req.body?.messages || [];
        if (!messages.length) {
            return res.status(400).json({ error: 'No messages provided' });
        }

        const userMessage = messages.filter(m => m.role === 'user').pop();
        if (!userMessage) {
            return res.status(400).json({ error: 'No user message found' });
        }

        const query = userMessage.content;
        const LOG = (stage, msg) => console.log(`[${stage}] ${msg}`);
        LOG('INIT', `Query: "${query.substring(0, 150)}"`);

        // ── Stage 1: Query Expansion ──
        let expandedQueries;
        try {
            expandedQueries = await expandQuery(query, messages);
        } catch (e) { e._ragStage = '1-Expand'; throw e; }
        LOG('S1-EXPAND', `${expandedQueries.length} queries generated:`);
        expandedQueries.forEach((q, i) => LOG('S1-EXPAND', `  [${i}] "${q}"`));

        // ── Stages 2-4: Embed + Sparse + Search ──
        let searchResults, debugSearchDetail;
        try {
            const searchOutput = await searchAll(expandedQueries, LOG);
            searchResults = searchOutput.results;
            debugSearchDetail = searchOutput.debugDetail;
        } catch (e) { e._ragStage = '2-4-Search'; throw e; }

        // Log candidates going into reranking
        LOG('S4→S5', `Candidates for reranking (${searchResults.length}):`);
        searchResults.forEach((r, i) => {
            LOG('S4→S5', `  [${i}] id=${r.id} score=${(r.weightedScore || r.score || 0).toFixed(4)} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 80)}`);
        });

        // ── Stage 5: Rerank ──
        const rerankTopK = Math.min(8 * expandedQueries.length, 16);
        let rerankedResults;
        try {
            rerankedResults = await rerankResults(query, searchResults, rerankTopK);
        } catch (e) { e._ragStage = '5-Rerank'; throw e; }
        LOG('S5-RERANK', `topK=${rerankTopK} → ${rerankedResults.length} survived:`);
        rerankedResults.forEach((r, i) => {
            LOG('S5-RERANK', `  [${i}] id=${r.id} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 80)}`);
        });

        // Log dropped by reranking
        const rerankedIds = new Set(rerankedResults.map(r => r.id));
        const droppedByRerank = searchResults.filter(r => !rerankedIds.has(r.id));
        if (droppedByRerank.length > 0) {
            LOG('S5-RERANK', `DROPPED by rerank (${droppedByRerank.length}):`);
            droppedByRerank.forEach(r => {
                LOG('S5-RERANK', `  ✗ id=${r.id} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 80)}`);
            });
        }

        // ── Stage 5b: Reference Expansion ──
        let allResults = [...rerankedResults];
        let debugRefChasing = { refsFound: 0, chasedAdded: 0, error: null };
        try {
            const refOutput = await expandReferences(rerankedResults, LOG);
            allResults = [...allResults, ...refOutput.added];
            debugRefChasing.refsFound = refOutput.refsFound;
            debugRefChasing.chasedAdded = refOutput.added.length;
        } catch (refErr) {
            debugRefChasing.error = refErr.message;
            LOG('S5b-REFS', `ERROR (non-fatal): ${refErr.message}`);
        }

        // ── Stage 5c: Iterative Context Evaluation ──
        let debugEval;
        try {
            const enrichOutput = await evaluateAndEnrich(query, allResults, LOG);
            allResults = enrichOutput.results;
            debugEval = enrichOutput.debugEval;
        } catch (evalErr) {
            debugEval = { iterations: 0, needed: [], dropped: [], errors: [evalErr.message] };
            LOG('S5c-EVAL', `ERROR (non-fatal): ${evalErr.message}`);
        }

        // ── Stage 6: Build Context + Answer ──
        LOG('S6-ANSWER', `Final context: ${allResults.length} chunks`);
        allResults.forEach((r, i) => {
            LOG('S6-ANSWER', `  [${i}] id=${r.id} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 80)}${r._chased ? ' [CHASED]' : ''}`);
        });

        const ragContext = buildContext(allResults);
        LOG('S6-ANSWER', `Context size: ${ragContext.length} chars`);

        let answer;
        try {
            answer = await generateAnswer(ragContext, messages);
        } catch (e) { e._ragStage = '6-Answer(GPT-5.2)'; throw e; }
        LOG('S6-ANSWER', `Response length: ${answer.length} chars`);

        // Build response
        const sources = allResults.map(r => ({
            law: r.law || '',
            section: r.section || '',
            chapter: r.chapter || '',
            collection: r.collection,
            _chased: r._chased || false,
        }));

        res.json({
            choices: [{ message: { role: 'assistant', content: answer } }],
            sources,
            _debug: {
                expandedQueries: expandedQueries.map(q => q.substring(0, 150)),
                searchDetail: debugSearchDetail,
                searchResults: searchResults.length,
                rerankedResults: rerankedResults.length,
                droppedByRerank: droppedByRerank.map(r => ({
                    id: r.id,
                    law: r.law || '',
                    section: (r.section || '').substring(0, 60),
                    collection: r.collection,
                })),
                refChasing: debugRefChasing,
                contextEval: debugEval,
                totalSources: allResults.length,
                finalSources: allResults.map(r => ({
                    id: r.id,
                    law: r.law || '',
                    section: (r.section || '').substring(0, 60),
                    collection: r.collection,
                    chased: r._chased || false,
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
