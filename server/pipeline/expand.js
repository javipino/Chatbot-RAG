// ── Stage 1: Query Expansion (GPT-5 Nano) ──
// Decomposes user query into 1-4 short keyword search queries.

const { callNano } = require('../services/openai');

const EXPAND_SYSTEM_PROMPT = `Eres un asistente legal. Tu tarea es generar las PALABRAS CLAVE de búsqueda necesarias para encontrar normativa relevante en una base de datos de legislación laboral y de Seguridad Social española.

RESPONDE SOLO con un JSON array de strings. Cada string es una búsqueda de 3-6 palabras clave.

Reglas:
- Cada query debe ser CORTA: solo 3-6 palabras clave relevantes. NO escribas frases completas.
- NO incluyas números de artículo (ej: "artículo 48", "art. 250"). La búsqueda semántica no los necesita.
- Incluye el término técnico-legal Y el coloquial si son distintos.
- Si la pregunta es SIMPLE (un solo concepto), devuelve UN array con una sola query.
  Ejemplo: "¿cuántos días de vacaciones tengo?" → ["vacaciones anuales retribuidas días disfrute"]
- Si la pregunta es COMPLEJA (compara o involucra varios conceptos), devuelve VARIAS queries (una por concepto).
  Ejemplo: "¿qué diferencia hay entre despido objetivo y disciplinario?" →
  ["despido objetivo causas indemnización",
   "despido disciplinario causas procedimiento"]
- Equivalencias coloquiales a términos legales:
  * "baja de maternidad" → "suspensión contrato nacimiento cuidado menor"
  * "despido" → "extinción contrato despido"
  * "paro" → "prestación desempleo"
  * "baja médica" → "incapacidad temporal prestación"
  * "pensión" → "jubilación prestación contributiva"
  * "finiquito" → "liquidación haberes extinción contrato"
- Máximo 4 queries. Agrupa conceptos cercanos si son más.

RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.`;

const EXPAND_FOLLOWUP_PROMPT = `Eres un asistente legal. El usuario hace una pregunta de CONTINUACIÓN sobre la conversación previa.
Ya tenemos el contexto normativo de la pregunta anterior (se inyectará automáticamente).
Tu tarea es generar SOLO las búsquedas ADICIONALES necesarias para los conceptos NUEVOS que aparecen en esta pregunta de continuación.

RESPONDE SOLO con un JSON array de strings (3-6 palabras clave cada una).
- Si la pregunta no introduce conceptos nuevos (ej: "¿puedes explicarlo mejor?"), devuelve un array vacío: []
- Si introduce conceptos nuevos, genera queries SOLO para esos conceptos nuevos.
  Ejemplo (si la conversación era sobre vacaciones): "¿y si no me las dan?" → ["sanción incumplimiento empresario vacaciones reclamación"]
- NO repitas búsquedas de conceptos que ya se trataron en la conversación anterior.
- Máximo 3 queries nuevas.

RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.`;

/**
 * Expand a user query into 1-4 search queries using GPT-5 Nano
 * @param {string} query - User's natural language question
 * @param {Array} conversationHistory - Previous messages for context
 * @param {boolean} hasCarryover - Whether previous chunk IDs are available
 * @returns {Promise<string[]>} Array of expanded search queries
 */
async function expandQuery(query, conversationHistory, hasCarryover = false) {
    try {
        // Determine if this is a follow-up question with carryover context
        const isFollowUp = hasCarryover && conversationHistory?.length > 1;
        const systemPrompt = isFollowUp ? EXPAND_FOLLOWUP_PROMPT : EXPAND_SYSTEM_PROMPT;

        const messages = [{ role: 'system', content: systemPrompt }];

        // For follow-ups, add minimal conversation context so Nano understands the topic
        if (isFollowUp && conversationHistory?.length > 0) {
            const recent = conversationHistory.slice(-4);
            for (const msg of recent) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messages.push({
                        role: msg.role,
                        content: (msg.content || '').substring(0, 200),
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
            if (Array.isArray(queries) && queries.every(q => typeof q === 'string')) {
                // For follow-ups, empty array is valid (no new concepts)
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
