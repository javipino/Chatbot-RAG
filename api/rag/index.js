const https = require('https');

// ── Config (from environment variables) ──
const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT || 'ai-search-javi.search.windows.net';
const SEARCH_KEY = process.env.AZURE_SEARCH_KEY;
const SEARCH_INDEX = process.env.AZURE_SEARCH_INDEX || 'normativa';

const OPENAI_ENDPOINT = process.env.AZURE_OPENAI_READER_ENDPOINT || 'openai-reader-javi.cognitiveservices.azure.com';
const OPENAI_KEY = process.env.AZURE_OPENAI_READER_KEY;
const EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';

const GPT_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com';
const GPT_KEY = process.env.AZURE_OPENAI_KEY;
const GPT_DEPLOYMENT = 'gpt-5.2';

const SYSTEM_PROMPT = `Eres un experto en legislación laboral y de Seguridad Social española. 
Respondes preguntas basándote EXCLUSIVAMENTE en los fragmentos de normativa que se te proporcionan como contexto.
Reglas:
- Cita siempre la ley, capítulo y artículo específico en tu respuesta.
- Si el contexto proporcionado no contiene información suficiente para responder, dilo claramente.
- Responde en español, de forma clara y estructurada.
- Si hay varias normas relevantes, menciona todas.
- Usa un tono profesional pero accesible.`;

// ── Helpers ──
function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString();
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`));
                } else {
                    resolve(JSON.parse(data));
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function httpsRequestStream(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            if (res.statusCode >= 400) {
                const chunks = [];
                res.on('data', d => chunks.push(d));
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString().substring(0, 500)}`)));
            } else {
                resolve(res);
            }
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ── Step 1: Generate embedding ──
async function embedQuery(query) {
    const result = await httpsRequest({
        hostname: OPENAI_ENDPOINT,
        path: `/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=2023-05-15`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': OPENAI_KEY }
    }, { input: query });
    return result.data[0].embedding;
}

// ── Step 2: Hybrid search (vector + text + semantic) ──
async function searchDocuments(query, embedding, lawFilter) {
    const searchBody = {
        search: query,
        vectorQueries: [{
            kind: 'vector',
            vector: embedding,
            fields: 'text_vector',
            k: 8,
            exhaustive: false
        }],
        queryType: 'semantic',
        semanticConfiguration: 'default-semantic',
        top: 8,
        select: 'law,chapter,section,text,resumen',
        captions: 'extractive',
        answers: 'extractive'
    };

    if (lawFilter) {
        searchBody.filter = `law eq '${lawFilter.replace(/'/g, "''")}'`;
    }

    const result = await httpsRequest({
        hostname: SEARCH_ENDPOINT,
        path: `/indexes/${SEARCH_INDEX}/docs/search?api-version=2024-07-01`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': SEARCH_KEY }
    }, searchBody);

    return result.value || [];
}

// ── Step 3: Build context ──
function buildContext(results) {
    if (!results.length) return 'No se encontraron resultados relevantes en la normativa.';

    return results.map((doc, i) => {
        const parts = [`[Fuente ${i + 1}]`, `Ley: ${doc.law}`];
        if (doc.chapter) parts.push(`Capítulo: ${doc.chapter}`);
        parts.push(`Sección: ${doc.section}`);
        if (doc.resumen) parts.push(`Resumen: ${doc.resumen}`);
        parts.push(`Texto: ${doc.text}`);
        return parts.join('\n');
    }).join('\n\n---\n\n');
}

// ── Step 4: Call GPT with streaming ──
async function callGPTStream(context, messages) {
    const augmentedMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: `CONTEXTO DE NORMATIVA VIGENTE:\n\n${context}` }
    ];

    const recentHistory = messages.slice(-6);
    for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            augmentedMessages.push({ role: msg.role, content: msg.content });
        }
    }

    return httpsRequestStream({
        hostname: GPT_ENDPOINT,
        path: `/openai/deployments/${GPT_DEPLOYMENT}/chat/completions?api-version=2025-01-01-preview`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': GPT_KEY }
    }, {
        messages: augmentedMessages,
        temperature: 0.1,
        reasoning_effort: 'high',
        stream: true
    });
}

// ── Main handler ──
module.exports = async function (context, req) {
    try {
        const body = req.body || {};
        const messages = body.messages || [];
        const lawFilter = body.lawFilter || null;

        if (!messages.length) {
            context.res = { status: 400, body: { error: 'No messages provided' } };
            return;
        }

        const userMessage = messages.filter(m => m.role === 'user').pop();
        if (!userMessage) {
            context.res = { status: 400, body: { error: 'No user message found' } };
            return;
        }

        const query = userMessage.content;

        // Step 1: Embed
        const embedding = await embedQuery(query);

        // Step 2: Search
        const results = await searchDocuments(query, embedding, lawFilter);

        // Step 3: Build context
        const ragContext = buildContext(results);

        // Step 4: Stream GPT response
        const gptStream = await callGPTStream(ragContext, messages);

        const sources = results.map(r => ({
            law: r.law,
            section: r.section,
            chapter: r.chapter || ''
        }));

        // Collect streamed response
        const responseChunks = [];
        await new Promise((resolve, reject) => {
            gptStream.on('data', chunk => responseChunks.push(chunk));
            gptStream.on('end', resolve);
            gptStream.on('error', reject);
        });

        const fullResponse = Buffer.concat(responseChunks).toString();

        // Parse SSE events
        let assistantContent = '';
        for (const line of fullResponse.split('\n')) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                    const event = JSON.parse(line.slice(6));
                    const delta = event.choices?.[0]?.delta?.content;
                    if (delta) assistantContent += delta;
                } catch (e) { /* skip */ }
            }
        }

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
                choices: [{
                    message: { role: 'assistant', content: assistantContent }
                }],
                sources
            }
        };

    } catch (err) {
        context.log.error('RAG error:', err.message);
        context.res = {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: { error: err.message }
        };
    }
};
