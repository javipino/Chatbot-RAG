// ── Azure OpenAI service calls ──

const { httpsRequest } = require('./http');
const {
    READER_ENDPOINT, READER_KEY,
    PRINCIPAL_ENDPOINT, PRINCIPAL_KEY,
    EMBEDDING_DEPLOYMENT, NANO_DEPLOYMENT, GPT52_DEPLOYMENT,
} = require('../config');

/**
 * Embed text using text-embedding-3-small (Reader endpoint)
 * @param {string} text
 * @returns {Promise<number[]>} 1536-dim embedding
 */
async function embed(text) {
    const result = await httpsRequest({
        hostname: READER_ENDPOINT,
        path: `/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=2023-05-15`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': READER_KEY },
    }, { input: text });
    return result.data[0].embedding;
}

/**
 * Call GPT-5 Nano (Reader endpoint) — for expansion, reranking, etc.
 * @param {Array} messages - Chat messages
 * @returns {Promise<string>} response content
 */
async function callNano(messages) {
    const result = await httpsRequest({
        hostname: READER_ENDPOINT,
        path: `/openai/deployments/${NANO_DEPLOYMENT}/chat/completions?api-version=2025-01-01-preview`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': READER_KEY },
    }, { messages });
    return result.choices?.[0]?.message?.content || '';
}

/**
 * Call GPT-5.2 (Principal endpoint) — for evaluation and final answer
 * @param {Array} messages - Chat messages
 * @returns {Promise<string>} response content
 */
async function callGPT52(messages) {
    const result = await httpsRequest({
        hostname: PRINCIPAL_ENDPOINT,
        path: `/openai/deployments/${GPT52_DEPLOYMENT}/chat/completions?api-version=2025-01-01-preview`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': PRINCIPAL_KEY },
    }, { messages });
    return result.choices?.[0]?.message?.content || '';
}

/**
 * Forward a raw request to any Azure OpenAI endpoint (chat proxy)
 * @param {string} hostname
 * @param {string} path
 * @param {string} apiKey
 * @param {Object} body
 * @returns {Promise<{statusCode: number, body: string}>}
 */
async function forwardRequest(hostname, targetPath, apiKey, body) {
    const https = require('https');
    const bodyStr = JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const options = {
            hostname,
            port: 443,
            path: targetPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': apiKey,
                'Content-Length': Buffer.byteLength(bodyStr),
            },
            timeout: 120000,
        };

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                resolve({ statusCode: response.statusCode, body: data });
            });
        });

        request.on('error', reject);
        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Timeout conectando al endpoint'));
        });

        request.write(bodyStr);
        request.end();
    });
}

module.exports = { embed, callNano, callGPT52, forwardRequest };
