// ── Stage 1: Query Expansion (GPT-5 Nano) ──
// Decomposes user query into 1-4 search queries with legal terminology.

const { callNano } = require('../services/openai');

const EXPAND_SYSTEM_PROMPT = `Eres un asistente legal. Tu tarea es descomponer la pregunta del usuario en las BÚSQUEDAS NECESARIAS para encontrar toda la normativa relevante en una base de datos de legislación laboral y de Seguridad Social española.

RESPONDE SOLO con un JSON array de strings. Cada string es una búsqueda independiente.

Reglas:
- Si la pregunta es SIMPLE (un solo concepto), devuelve UN array con una sola query expandida.
  Ejemplo: "¿cuántos días de vacaciones tengo?" → ["vacaciones anuales retribuidas artículo 38 Estatuto de los Trabajadores derecho a vacaciones período de disfrute"]
- Si la pregunta es COMPLEJA (compara, relaciona o involucra varios conceptos), devuelve VARIAS queries, una por cada concepto que hay que buscar por separado.
  Ejemplo: "¿el trabajo de una empleada del hogar es pluriempleo o pluriactividad?" →
  ["pluriempleo Seguridad Social alta simultánea mismo régimen artículo 148 LGSS cotización",
   "pluriactividad Seguridad Social alta simultánea distintos regímenes artículo 149 LGSS",
   "régimen especial empleadas del hogar Sistema Especial trabajadores del hogar artículo 250-251 LGSS"]
- Si la pregunta es una CONTINUACIÓN de la conversación (ej: "¿y si no me las dan?"), usa el historial para entender el tema y genera queries completas y autocontenidas.
- Máximo 4 queries. Si la pregunta necesita más, agrupa los conceptos más cercanos.
- Cada query debe ser autocontenida (no depender de las otras).
- Incluye siempre términos técnicos legales Y los coloquiales.
- Traduce los términos coloquiales a sus equivalentes legales:
  * "baja de maternidad/paternidad" → "suspensión del contrato por nacimiento y cuidado de menor, artículo 48 ET"
  * "despido" → "extinción del contrato de trabajo, despido objetivo, disciplinario, artículo 49-56 ET"
  * "paro" → "prestación por desempleo, artículo 262-267 LGSS"
  * "baja médica" → "incapacidad temporal, artículo 169-176 LGSS"
  * "pensión" → "prestación contributiva de jubilación, artículo 204-215 LGSS"
  * "contrato temporal" → "contrato de duración determinada, artículo 15 ET"
  * "finiquito" → "liquidación de haberes, extinción del contrato"

RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.`;

/**
 * Expand a user query into 1-4 search queries using GPT-5 Nano
 * @param {string} query - User's natural language question
 * @param {Array} conversationHistory - Previous messages for context
 * @returns {Promise<string[]>} Array of expanded search queries
 */
async function expandQuery(query, conversationHistory) {
    try {
        const messages = [{ role: 'system', content: EXPAND_SYSTEM_PROMPT }];

        // Add recent conversation for context (last 4 messages, trimmed)
        if (conversationHistory?.length > 0) {
            const recent = conversationHistory.slice(-4);
            for (const msg of recent) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messages.push({
                        role: msg.role,
                        content: (msg.content || '').substring(0, 300),
                    });
                }
            }
        }

        // Ensure current query is the final user message
        const lastMsg = messages[messages.length - 1];
        if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== query) {
            messages.push({ role: 'user', content: query });
        }

        const content = await callNano(messages);

        // Parse JSON array (handle markdown backticks if model adds them)
        const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
            const queries = JSON.parse(match[0]);
            if (Array.isArray(queries) && queries.length > 0 && queries.every(q => typeof q === 'string')) {
                return queries.slice(0, 4);
            }
        }

        // Fallback: plain text → single query
        if (content.trim().length > 0) return [content.trim()];
        return [query];
    } catch (e) {
        console.warn('Query expansion failed, using original:', e.message);
        return [query];
    }
}

module.exports = { expandQuery };
