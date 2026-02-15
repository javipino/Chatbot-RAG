// ── Stage 6: Build Context & Generate Answer (GPT-5.2) ──

const { callGPT52 } = require('../services/openai');
const { SYSTEM_PROMPT } = require('../config');

/**
 * Build context string from search results for the answer model
 */
function buildContext(results) {
    if (!results.length) return 'No se encontraron resultados relevantes en la normativa.';

    return results.map((doc, i) => {
        const parts = [`[Fuente ${i + 1} — ${doc.collection}]`];
        if (doc.law) parts.push(`Ley: ${doc.law}`);
        if (doc.chapter) parts.push(`Capítulo: ${doc.chapter}`);
        if (doc.section) parts.push(`Sección: ${doc.section}`);
        if (doc.resumen) parts.push(`Resumen: ${doc.resumen}`);
        if (doc.text) parts.push(`Texto: ${doc.text}`);
        return parts.join('\n');
    }).join('\n\n---\n\n');
}

/**
 * Call GPT-5.2 with context + conversation to generate final answer
 * @param {string} context - Formatted context from search results
 * @param {Array} messages - Conversation messages
 * @returns {Promise<string>} Answer text
 */
async function generateAnswer(context, messages) {
    const augmentedMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: `CONTEXTO DE NORMATIVA VIGENTE:\n\n${context}` },
    ];

    // Include last 6 messages of conversation
    const recentHistory = messages.slice(-6);
    for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            augmentedMessages.push({ role: msg.role, content: msg.content });
        }
    }

    return callGPT52(augmentedMessages);
}

module.exports = { buildContext, generateAnswer };
