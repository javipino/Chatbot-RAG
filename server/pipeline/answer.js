// ── Stage 5: Unified Answer + Evaluation (GPT-5.2) ──
// Single call: answers the question, identifies useless refs (DROP), and requests missing articles (NEED).

const { callGPT52 } = require('../services/openai');
const { SYSTEM_PROMPT } = require('../config');

/**
 * Build numbered context string from search results
 */
function buildContext(results) {
    if (!results.length) return 'No se encontraron resultados relevantes en la normativa.';

    return results.map((doc, i) => {
        const parts = [`[${i}] ${doc.law || '?'} > ${doc.section || '?'}`];
        if (doc.chapter) parts.push(`Capítulo: ${doc.chapter}`);
        if (doc.resumen) parts.push(`Resumen: ${doc.resumen}`);
        if (doc.text) parts.push(`Texto: ${doc.text}`);
        return parts.join('\n');
    }).join('\n\n---\n\n');
}

const ANSWER_WRAPPER = `INSTRUCCIONES DE FORMATO DE RESPUESTA:

Responde a la pregunta del usuario usando los fragmentos de normativa proporcionados.

Tu respuesta DEBE tener EXACTAMENTE estas dos secciones, separadas por el delimitador:

1. Primero tu respuesta completa al usuario.

===META===

2. Después del delimitador, metadata en formato estructurado:

USED|índices de los fragmentos que has USADO (separados por comas)
DROP|índices de fragmentos que NO aportan nada (separados por comas)
NEED|... (solo si FALTA información CRÍTICA, máximo 2 líneas)

Formatos de NEED (elige el apropiado):
- Si sabes el artículo exacto: NEED|número_artículo|nombre_ley (la ley es OBLIGATORIA, sin ella no podemos buscar)
- Si necesitas información pero no sabes el artículo: NEED|palabras clave de búsqueda

Reglas para META:
- USED y DROP son OBLIGATORIOS. Si todos fueron útiles, pon DROP|ninguno
- NEED es OPCIONAL. Solo si realmente falta algo imprescindible.

Ejemplos:
===META===
USED|0,2,5,7
DROP|1,3,4,6
NEED|48|Estatuto Trabajadores
NEED|régimen especial trabajadores autónomos cotización`;

/**
 * Unified answer: responds + evaluates context in a single GPT-5.2 call
 * @param {string} context - Formatted context from search results
 * @param {Array} messages - Conversation messages
 * @returns {Promise<{answer: string, used: number[], drop: number[], need: Array<{type: string, art?: string, ley?: string, query?: string}>}>}
 */
async function generateAnswer(context, messages) {
    const augmentedMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: `CONTEXTO DE NORMATIVA:\n\n${context}` },
        { role: 'system', content: ANSWER_WRAPPER },
    ];

    // Include last 6 messages of conversation
    const recentHistory = messages.slice(-6);
    for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            augmentedMessages.push({ role: msg.role, content: msg.content });
        }
    }

    const raw = await callGPT52(augmentedMessages);

    // Parse response: split on ===META===
    const metaDelimiter = '===META===';
    const metaIdx = raw.indexOf(metaDelimiter);

    let answer, used = [], drop = [], need = [];

    if (metaIdx >= 0) {
        answer = raw.substring(0, metaIdx).trim();
        const metaSection = raw.substring(metaIdx + metaDelimiter.length).trim();

        for (const line of metaSection.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('USED|')) {
                const val = trimmed.substring(5).trim();
                if (val && val !== 'ninguno') {
                    used = val.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                }
            } else if (trimmed.startsWith('DROP|')) {
                const val = trimmed.substring(5).trim();
                if (val && val !== 'ninguno') {
                    drop = val.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                }
            } else if (trimmed.startsWith('NEED|')) {
                const parts = trimmed.split('|');
                if (parts.length >= 3) {
                    // Format: NEED|article_number|law_name
                    const artMatch = parts[1].trim().match(/(\d+(?:\.\d+)?)/);
                    if (artMatch) {
                        need.push({ type: 'article', art: artMatch[1], ley: parts[2].trim() });
                    }
                } else if (parts.length === 2 && parts[1].trim().length > 0) {
                    // Format: NEED|free text query
                    need.push({ type: 'query', query: parts[1].trim() });
                }
            }
        }
    } else {
        // No meta section — just use raw answer as-is
        answer = raw.trim();
    }

    return { answer, used, drop, need };
}

module.exports = { buildContext, generateAnswer };
