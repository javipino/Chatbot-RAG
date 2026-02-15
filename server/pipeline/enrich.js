// ── Stages 5b + 5c: Reference Expansion & Context Evaluation ──

const { callGPT52, embed } = require('../services/openai');
const { buildSparseVector } = require('../services/tfidf');
const { fetchChunksByIds, fetchByArticleFilter } = require('../services/qdrant');

const MAX_EVAL_ITERATIONS = 2;

/**
 * Stage 5b: Expand pre-computed references from reranked results
 * Each chunk has a `refs` array of chunk IDs it references.
 */
async function expandReferences(results, log) {
    const existingIds = new Set(results.map(r => r.id));
    const neededIds = new Set();

    for (const r of results) {
        const refs = r.refs || [];
        if (refs.length > 0) {
            log('S5b-REFS', `id=${r.id} (${(r.section || '?').substring(0, 40)}) refs: [${refs.join(', ')}]`);
        }
        for (const refId of refs) {
            if (!existingIds.has(refId) && !neededIds.has(refId)) {
                neededIds.add(refId);
            }
        }
    }

    if (neededIds.size === 0) {
        log('S5b-REFS', 'No pre-computed references to fetch');
        return { added: [], refsFound: 0 };
    }

    log('S5b-REFS', `Fetching ${neededIds.size} referenced chunks: [${[...neededIds].join(', ')}]`);
    const fetched = await fetchChunksByIds([...neededIds]);
    const newResults = fetched.filter(r => !existingIds.has(r.id));

    log('S5b-REFS', `Added ${newResults.length} referenced chunks:`);
    newResults.forEach(r => {
        log('S5b-REFS', `  + id=${r.id} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 60)}`);
    });

    return { added: newResults, refsFound: neededIds.size };
}

/**
 * Stage 5c: Iterative context evaluation with GPT-5.2
 * Evaluates if context is sufficient; if not, requests more articles and drops irrelevant ones.
 */
async function evaluateAndEnrich(query, allResults, log) {
    const debugEval = { iterations: 0, needed: [], dropped: [], errors: [] };

    log('S5c-EVAL', `Starting context evaluation (max ${MAX_EVAL_ITERATIONS} iters) with ${allResults.length} chunks`);

    try {
        for (let iter = 0; iter < MAX_EVAL_ITERATIONS; iter++) {
            log('S5c-EVAL', `--- Iteration ${iter + 1} ---`);
            log('S5c-EVAL', `Current context (${allResults.length} chunks):`);
            allResults.forEach((r, i) => {
                log('S5c-EVAL', `  [${i}] id=${r.id} (${r.collection}) ${r.law || '?'} > ${(r.section || '?').substring(0, 60)}${r._chased ? ' [CHASED]' : ''}`);
            });

            const evaluation = await _callEvaluator(query, allResults, log);
            debugEval.iterations = iter + 1;

            if (evaluation.ready) {
                log('S5c-EVAL', 'GPT-5.2 says READY ✓');
                break;
            }

            log('S5c-EVAL', `GPT-5.2 says NOT READY: need=${evaluation.need.length}, drop=${evaluation.drop.length}`);

            // Drop irrelevant sources
            if (evaluation.drop.length > 0) {
                const dropSet = new Set(evaluation.drop);
                log('S5c-EVAL', `Dropping indices: [${evaluation.drop.join(', ')}]`);
                evaluation.drop.forEach(i => {
                    if (allResults[i]) {
                        log('S5c-EVAL', `  ✗ [${i}] id=${allResults[i].id} ${allResults[i].law || '?'} > ${(allResults[i].section || '?').substring(0, 60)}`);
                    }
                });
                const before = allResults.length;
                allResults = allResults.filter((_, i) => !dropSet.has(i));
                debugEval.dropped.push(...evaluation.drop);
                log('S5c-EVAL', `Dropped ${before - allResults.length} chunks (${allResults.length} remaining)`);
            }

            // Fetch additional articles requested by evaluator
            if (evaluation.need.length > 0) {
                log('S5c-EVAL', `Fetching ${evaluation.need.length} NEED requests:`);
                evaluation.need.forEach(r => log('S5c-EVAL', `  → Art.${r.art} ${r.ley}`));
                debugEval.needed.push(...evaluation.need.map(r => `Art.${r.art} ${r.ley}`));

                const chasedMore = await fetchByArticleFilter(evaluation.need, embed, buildSparseVector, log);
                log('S5c-EVAL', `fetchByArticleFilter returned ${chasedMore.length} chunks:`);
                chasedMore.forEach(r => {
                    log('S5c-EVAL', `  id=${r.id} ${r.law || '?'} > ${(r.section || '?').substring(0, 60)} [${r._reason || ''}]`);
                });

                if (chasedMore.length > 0) {
                    const existingIds = new Set(allResults.map(r => r.id));
                    const newChased = chasedMore.filter(r => !existingIds.has(r.id));
                    allResults = [...allResults, ...newChased];
                    log('S5c-EVAL', `Added ${newChased.length} new chunks (${chasedMore.length - newChased.length} duplicates skipped)`);
                }
            }

            if (evaluation.need.length === 0) break;
        }
    } catch (evalErr) {
        debugEval.errors.push(evalErr.message);
        log('S5c-EVAL', `ERROR (non-fatal): ${evalErr.message}`);
    }

    return { results: allResults, debugEval };
}

/**
 * Internal: call GPT-5.2 evaluator
 */
async function _callEvaluator(query, results, log) {
    const numbered = results.map((r, i) => {
        const parts = [`[${i}] ${r.law || '?'} > ${r.section || '?'}`];
        if (r.text) parts.push(r.text.substring(0, 200));
        return parts.join('\n');
    }).join('\n\n');

    try {
        const content = await callGPT52([
            {
                role: 'system',
                content: `Eres un evaluador de contexto legal. Tu tarea es decidir si los fragmentos proporcionados son SUFICIENTES para responder la pregunta del usuario sobre legislación laboral española.

IMPORTANTE: Puedes usar tu conocimiento preentrenado para IDENTIFICAR qué artículos o leyes faltan (líneas NEED), pero NO para evaluar si el contenido de los fragmentos es correcto o completo — solo evalúa lo que ves en el texto proporcionado.

RESPONDE con EXACTAMENTE uno de estos formatos:

OPCIÓN A — Si el contexto es SUFICIENTE para responder:
READY

OPCIÓN B — Si FALTA información crítica:
NEED|número_artículo|nombre_ley
DROP|índices_irrelevantes

Reglas para NEED:
- Solo pide artículos que sean IMPRESCINDIBLES para responder correctamente
- Máximo 3 líneas NEED
- Usa el nombre corto de la ley (ej: "Estatuto Trabajadores", "LGSS")

Reglas para DROP:
- Lista los índices [N] de fragmentos que NO aportan nada a la respuesta
- Separados por comas en UNA sola línea
- Si todos son relevantes, no incluyas línea DROP

Regla especial:
- Si la pregunta involucra derechos del trabajador, asegura que tienes los artículos base del Estatuto de los Trabajadores (ET). Si no los ves en los fragmentos, pídelos con NEED.

Ejemplo de respuesta B:
NEED|48|Estatuto Trabajadores
NEED|177|LGSS
DROP|0,3,7`,
            },
            {
                role: 'user',
                content: `Pregunta: ${query}\n\nFragmentos disponibles:\n${numbered}`,
            },
        ]);

        log('S5c-EVAL', `GPT-5.2 eval raw: ${content.substring(0, 300)}`);

        if (content.includes('READY')) {
            return { ready: true, need: [], drop: [] };
        }

        // Parse NEED lines
        const need = [];
        for (const line of content.split('\n')) {
            const needMatch = line.trim().match(/^NEED\|(.+)\|(.+)$/);
            if (needMatch) {
                const artMatch = needMatch[1].trim().match(/(\d+(?:\.\d+)?)/);
                if (artMatch) {
                    need.push({ art: artMatch[1], ley: needMatch[2].trim() });
                }
            }
        }

        // Parse DROP line
        let drop = [];
        const dropMatch = content.match(/^DROP\|([\d,\s]+)$/m);
        if (dropMatch) {
            drop = dropMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        }

        return { ready: false, need: need.slice(0, 3), drop };
    } catch (e) {
        log('S5c-EVAL', `GPT-5.2 eval failed: ${e.message}`);
        return { ready: true, need: [], drop: [] }; // On error, proceed
    }
}

module.exports = { expandReferences, evaluateAndEnrich };
