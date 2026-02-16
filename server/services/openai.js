// ── Azure OpenAI service calls ──

const { httpsRequest } = require('./http');
const {
    getStageModelProfile,
} = require('../config');

function extractMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                if (part && typeof part.content === 'string') return part.content;
                return '';
            })
            .join('')
            .trim();
    }
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

async function callChatWithProfile(profile, messages) {
    if (!profile || !profile.type) {
        throw new Error('Invalid chat model profile');
    }

    if (profile.type === 'azure-deployment-chat') {
        const result = await httpsRequest({
            hostname: profile.endpoint,
            path: `/openai/deployments/${profile.deployment}/chat/completions?api-version=${profile.apiVersion}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': profile.apiKey },
        }, { messages });
        return extractMessageContent(result.choices?.[0]?.message?.content);
    }

    if (profile.type === 'foundry-model-chat') {
        const result = await httpsRequest({
            hostname: profile.endpoint,
            path: `/models/chat/completions?api-version=${profile.apiVersion}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': profile.apiKey },
        }, {
            model: profile.model,
            messages,
        });
        return extractMessageContent(result.choices?.[0]?.message?.content);
    }

    throw new Error(`Unsupported chat profile type: ${profile.type}`);
}

async function embedWithProfile(profile, text) {
    if (!profile || !profile.type) {
        throw new Error('Invalid embedding model profile');
    }

    if (profile.type === 'azure-deployment-embeddings') {
        const result = await httpsRequest({
            hostname: profile.endpoint,
            path: `/openai/deployments/${profile.deployment}/embeddings?api-version=${profile.apiVersion}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': profile.apiKey },
        }, { input: text });
        return result.data?.[0]?.embedding;
    }

    if (profile.type === 'foundry-model-embeddings') {
        const result = await httpsRequest({
            hostname: profile.endpoint,
            path: `/models/embeddings?api-version=${profile.apiVersion}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': profile.apiKey },
        }, {
            model: profile.model,
            input: text,
        });
        return result.data?.[0]?.embedding;
    }

    throw new Error(`Unsupported embedding profile type: ${profile.type}`);
}

/**
 * Embed text using text-embedding-3-small (Reader endpoint)
 * @param {string} text
 * @returns {Promise<number[]>} 1536-dim embedding
 */
async function embed(text) {
    const profile = getStageModelProfile('embedding');
    const embedding = await embedWithProfile(profile, text);
    if (!Array.isArray(embedding)) {
        throw new Error(`Invalid embedding response from profile "${profile.id}"`);
    }
    return embedding;
}

/**
 * Call GPT-5 Nano (Reader endpoint) — for expansion, reranking, etc.
 * @param {Array} messages - Chat messages
 * @returns {Promise<string>} response content
 */
async function callNano(messages) {
    const profile = getStageModelProfile('expand');
    return callChatWithProfile(profile, messages);
}

/**
 * Call GPT-5.2 (Principal endpoint) — for evaluation and final answer
 * @param {Array} messages - Chat messages
 * @returns {Promise<string>} response content
 */
async function callGPT52(messages) {
    const profile = getStageModelProfile('answer');
    return callChatWithProfile(profile, messages);
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
