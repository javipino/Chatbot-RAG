// ── Stage 5: LLM-based Reranking (GPT-5 Nano) ──

const { callNano } = require('../services/openai');

/**
 * Rerank search results using GPT-5 Nano
 * @param {string} query - Original user query
 * @param {Object[]} results - Search results to rerank
 * @param {number} topK - Max results to keep (dynamic: 8×N_queries, capped at 16)
 * @returns {Promise<Object[]>} reranked results
 */
async function rerankResults(query, results, topK = 8) {
    if (results.length <= 3) return results;

    try {
        const fragmentsText = results.map((r, i) =>
            `[${i}] (${r.collection}) ${r.section || ''}: ${(r.text || '').substring(0, 300)}`
        ).join('\n\n');

        const content = await callNano([
            {
                role: 'system',
                content: `Evalúa la relevancia de cada fragmento para responder la pregunta del usuario.
Devuelve SOLO un JSON array con los índices ordenados de más a menos relevante.
Ejemplo: [3, 0, 5, 1]
Incluye solo los fragmentos relevantes (máximo ${topK}). Si un fragmento no es relevante, no lo incluyas.
Criterios de prioridad:
- Prioriza leyes principales (Estatuto de los Trabajadores, LGSS, LETA) sobre reglamentos de desarrollo.
- Prioriza artículos vigentes sobre disposiciones transitorias con fechas pasadas.
- Prioriza texto sustantivo sobre referencias procedimentales.`,
            },
            {
                role: 'user',
                content: `Pregunta: ${query}\n\nFragmentos:\n${fragmentsText}`,
            },
        ]);

        const match = content.match(/\[[\d,\s]+\]/);
        if (match) {
            const rankedIndices = JSON.parse(match[0]);
            const reranked = rankedIndices
                .filter(i => i >= 0 && i < results.length)
                .map(i => results[i])
                .slice(0, topK);
            if (reranked.length > 0) return reranked;
        }
    } catch (e) {
        console.warn('Reranking failed, using original order:', e.message);
    }

    return results.slice(0, topK);
}

module.exports = { rerankResults };
