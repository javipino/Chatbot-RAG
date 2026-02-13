const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──
const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

const READER_ENDPOINT = process.env.AZURE_OPENAI_READER_ENDPOINT || 'openai-reader-javi.cognitiveservices.azure.com';
const READER_KEY = process.env.AZURE_OPENAI_READER_KEY;

const GPT_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com';
const GPT_KEY = process.env.AZURE_OPENAI_KEY;

const EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';
const NANO_DEPLOYMENT = 'gpt-5-nano';
const GPT_DEPLOYMENT = 'gpt-5.2';

// Colecciones y sus pesos para cross-collection search
const COLLECTIONS = [
    { name: 'normativa', weight: 1.0 },
    { name: 'sentencias', weight: 0.8 },
    { name: 'criterios_inss', weight: 0.9 },
];

const SYSTEM_PROMPT = `Eres un experto en legislación laboral y de Seguridad Social española.
Respondes preguntas basándote EXCLUSIVAMENTE en los fragmentos de normativa que se te proporcionan como contexto.

Reglas:
- Cita siempre la ley, capítulo y artículo específico en tu respuesta.
- Si el contexto proporcionado no contiene información suficiente para responder, dilo claramente.
- Responde en español, de forma clara y estructurada.
- Si hay varias normas relevantes, menciona todas.
- Usa un tono profesional pero accesible.

Jerarquía normativa (CRÍTICO - aplica siempre):
- Cuando haya CONTRADICCIÓN entre fuentes, prevalece la norma de mayor rango:
  1. Leyes orgánicas y Estatutos (ET, LGSS, LETA, etc.)
  2. Reales Decretos-ley
  3. Reales Decretos y Reglamentos (como RD 295/2009)
  4. Órdenes ministeriales
  5. Disposiciones transitorias (pueden estar superadas por la regulación definitiva)
- Si un reglamento dice una cosa y la ley dice otra, LA LEY PREVALECE SIEMPRE.
- Las disposiciones transitorias con fechas pasadas pueden estar derogadas implícitamente por la regulación actual.
- Ejemplo: si el Art. 48 del Estatuto de los Trabajadores fija una duración de suspensión diferente a la que indica un reglamento de desarrollo, prevalece el Estatuto.
- Cuando respondas, indica la fuente de mayor rango y, si detectas contradicción con otra fuente de menor rango, señálalo brevemente.`;

// ── TF-IDF Vocabulary (lazy loaded) ──
let _vocab = null;
function loadVocabulary() {
    if (_vocab) return _vocab;
    try {
        const vocabPath = path.join(__dirname, '..', 'data', 'tfidf_vocabulary.json');
        _vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'));
        return _vocab;
    } catch (e) {
        console.warn('Warning: Could not load TF-IDF vocabulary:', e.message);
        return null;
    }
}

// ── Tokenizer (must match build_tfidf.js exactly) ──
const STOPWORDS_ES = new Set([
    'a', 'al', 'algo', 'algunas', 'algunos', 'ante', 'antes', 'como', 'con',
    'contra', 'cual', 'cuando', 'de', 'del', 'desde', 'donde', 'durante',
    'e', 'el', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era', 'esa', 'esas',
    'ese', 'eso', 'esos', 'esta', 'estaba', 'estado', 'estar', 'estas', 'este',
    'esto', 'estos', 'fue', 'ha', 'hace', 'hacia', 'hasta', 'hay', 'la', 'las',
    'le', 'les', 'lo', 'los', 'mas', 'me', 'mi', 'muy', 'nada',
    'ni', 'no', 'nos', 'nosotros', 'nuestro', 'nuestra', 'o', 'otra', 'otras',
    'otro', 'otros', 'para', 'pero', 'por', 'porque', 'que', 'quien',
    'se', 'sea', 'ser', 'si', 'sin', 'sino', 'sobre',
    'somos', 'son', 'su', 'sus', 'te', 'ti', 'tiene', 'todo',
    'toda', 'todos', 'todas', 'tu', 'tus', 'un', 'una', 'uno', 'unos', 'unas',
    'usted', 'ustedes', 'ya', 'yo',
    'dicho', 'dicha', 'dichos', 'dichas', 'mismo', 'misma', 'mismos', 'mismas',
    'cada', 'caso', 'cuyo', 'cuya', 'cuyos', 'cuyas',
    'han', 'haber', 'haya', 'he', 'hemos',
    'manera', 'mediante', 'parte', 'pues', 'respecto',
    'sera', 'seran', 'sido', 'siendo', 'tan', 'tanto', 'tres', 'vez', 'dos',
]);

const SUFFIXES = [
    'imientos', 'amiento', 'imiento', 'aciones', 'uciones', 'idades',
    'amente', 'adores', 'ancias', 'encias', 'mente', 'acion', 'ucion',
    'adora', 'antes', 'ibles', 'istas', 'idad', 'ivas', 'ivos',
    'ador', 'ante', 'anza', 'able', 'ible', 'ista', 'osa', 'oso',
    'iva', 'ivo', 'dad', 'ion',
    'ando', 'endo', 'iendo', 'ados', 'idos', 'adas', 'idas',
    'ado', 'ido', 'ada', 'ida',
    'ara', 'era', 'ira', 'aran', 'eran', 'iran',
    'aba', 'ian',
    'es', 'as', 'os',
    'ar', 'er', 'ir',
];

function stemEs(word) {
    if (word.length <= 4) return word;
    for (const suffix of SUFFIXES) {
        if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
            return word.slice(0, -suffix.length);
        }
    }
    if (word.endsWith('s') && word.length > 4) return word.slice(0, -1);
    return word;
}

function tokenize(text) {
    text = text.toLowerCase()
        .replace(/[áà]/g, 'a').replace(/[éè]/g, 'e')
        .replace(/[íì]/g, 'i').replace(/[óò]/g, 'o')
        .replace(/[úùü]/g, 'u').replace(/ñ/g, 'ny');
    return (text.match(/[a-z0-9]+/g) || [])
        .filter(t => !STOPWORDS_ES.has(t) && t.length >= 2)
        .map(t => stemEs(t));
}

// ── Build sparse vector from query text ──
function buildSparseVector(text) {
    const vocab = loadVocabulary();
    if (!vocab) return null;

    const tokens = tokenize(text);
    if (!tokens.length) return null;

    const tf = {};
    for (const t of tokens) {
        tf[t] = (tf[t] || 0) + 1;
    }

    const indices = [];
    const values = [];
    const { terms, avg_doc_length, bm25_k1: k1, bm25_b: b } = vocab;

    for (const [term, count] of Object.entries(tf)) {
        if (terms[term]) {
            const { idx, idf } = terms[term];
            const tfScore = count / (count + k1 * (1 - b + b * tokens.length / avg_doc_length));
            const score = tfScore * idf;
            if (score > 0.01) {
                indices.push(idx);
                values.push(Math.round(score * 10000) / 10000);
            }
        }
    }

    return indices.length > 0 ? { indices, values } : null;
}

// ── HTTP helper ──
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

// ── Stage 1: Query Expansion with Nano (context-aware) ──
async function expandQuery(query, conversationHistory) {
    try {
        // Build conversation context for Nano so it understands follow-up questions
        const nanoMessages = [
            {
                role: 'system',
                content: `Eres un asistente legal. Tu tarea es reformular la pregunta del usuario para buscar en una base de datos de normativa laboral y de Seguridad Social española.

Reglas:
- Si la pregunta es clara por sí sola, expándela con sinónimos legales y artículos relevantes.
- Si la pregunta es una continuación de la conversación (ej: "¿y si no me las dan?"), usa el historial para entender el tema y genera una query completa y autocontenida.
- Responde SOLO con la query expandida, sin explicaciones.
- Incluye términos técnicos del derecho laboral español.
- IMPORTANTE: Traduce siempre los términos coloquiales a sus equivalentes legales:
  * "baja de maternidad/paternidad" → "suspensión del contrato por nacimiento y cuidado de menor, artículo 48 Estatuto de los Trabajadores, prestación por nacimiento"
  * "despido" → "extinción del contrato de trabajo, despido objetivo, disciplinario, artículo 49-56 ET"
  * "paro" → "prestación por desempleo, artículo 262-267 LGSS"
  * "baja médica" → "incapacidad temporal, artículo 169-176 LGSS"
  * "pensión" → "prestación contributiva de jubilación, artículo 204-215 LGSS"
  * "contrato temporal" → "contrato de duración determinada, artículo 15 ET"
  * "finiquito" → "liquidación de haberes, extinción del contrato"
- Incluye siempre las dos versiones: el término coloquial Y el término legal formal.`
            }
        ];

        // Add recent conversation for context (last 4 messages max, trimmed)
        if (conversationHistory && conversationHistory.length > 0) {
            const recent = conversationHistory.slice(-4);
            for (const msg of recent) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    nanoMessages.push({
                        role: msg.role,
                        content: (msg.content || '').substring(0, 300)
                    });
                }
            }
        }

        // Add the current query as the final user message (if not already the last)
        const lastMsg = nanoMessages[nanoMessages.length - 1];
        if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== query) {
            nanoMessages.push({ role: 'user', content: query });
        }

        const result = await httpsRequest({
            hostname: READER_ENDPOINT,
            path: `/openai/deployments/${NANO_DEPLOYMENT}/chat/completions?api-version=2025-01-01-preview`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': READER_KEY }
        }, {
            messages: nanoMessages,
            max_completion_tokens: 200
        });
        return result.choices?.[0]?.message?.content || query;
    } catch (e) {
        console.warn('Query expansion failed, using original:', e.message);
        return query;
    }
}

// ── Stage 2: Embed query ──
async function embedQuery(query) {
    const result = await httpsRequest({
        hostname: READER_ENDPOINT,
        path: `/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=2023-05-15`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': READER_KEY }
    }, { input: query });
    return result.data[0].embedding;
}

// ── Stage 4: Hybrid search in one Qdrant collection ──
async function searchCollection(collectionName, denseVector, sparseVector, topK = 10) {
    const qdrantUrl = new URL(QDRANT_URL);

    const queryBody = {
        limit: topK,
        with_payload: true,
        prefetch: [
            {
                query: denseVector,
                using: 'text-dense',
                limit: 20
            }
        ],
        query: { fusion: 'rrf' }
    };

    if (sparseVector) {
        queryBody.prefetch.push({
            query: {
                indices: sparseVector.indices,
                values: sparseVector.values
            },
            using: 'text-sparse',
            limit: 20
        });
    }

    const result = await httpsRequest({
        hostname: qdrantUrl.hostname,
        port: qdrantUrl.port || 6333,
        path: `/collections/${collectionName}/points/query`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY }
    }, queryBody);

    return (result.result?.points || []).map(point => ({
        ...point.payload,
        score: point.score,
        collection: collectionName,
        id: point.id
    }));
}

// ── Stage 4b: Cross-collection search + weighted merge ──
async function searchAllCollections(denseVector, sparseVector) {
    const promises = COLLECTIONS.map(col =>
        searchCollection(col.name, denseVector, sparseVector, 10)
            .then(results => results.map(r => ({
                ...r,
                weightedScore: r.score * col.weight
            })))
            .catch(err => {
                // Collections without data return empty results, not errors
                if (!err.message.includes('404')) {
                    console.warn(`Search in ${col.name} failed:`, err.message);
                }
                return [];
            })
    );

    const allResults = (await Promise.all(promises)).flat();
    allResults.sort((a, b) => b.weightedScore - a.weightedScore);
    return allResults.slice(0, 20);
}

// ── Stage 5: Reranker with Nano ──
async function rerankResults(query, results) {
    if (results.length <= 3) return results;

    try {
        const fragmentsText = results.map((r, i) =>
            `[${i}] (${r.collection}) ${r.section || ''}: ${(r.text || '').substring(0, 300)}`
        ).join('\n\n');

        const result = await httpsRequest({
            hostname: READER_ENDPOINT,
            path: `/openai/deployments/${NANO_DEPLOYMENT}/chat/completions?api-version=2025-01-01-preview`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': READER_KEY }
        }, {
            messages: [
                {
                    role: 'system',
                    content: `Evalúa la relevancia de cada fragmento para responder la pregunta del usuario.
Devuelve SOLO un JSON array con los índices ordenados de más a menos relevante.
Ejemplo: [3, 0, 5, 1]
Incluye solo los fragmentos relevantes (máximo 8). Si un fragmento no es relevante, no lo incluyas.
Criterios de prioridad:
- Prioriza leyes principales (Estatuto de los Trabajadores, LGSS, LETA) sobre reglamentos de desarrollo.
- Prioriza artículos vigentes sobre disposiciones transitorias con fechas pasadas.
- Prioriza texto sustantivo sobre referencias procedimentales.`
                },
                {
                    role: 'user',
                    content: `Pregunta: ${query}\n\nFragmentos:\n${fragmentsText}`
                }
            ],
            max_completion_tokens: 200
        });

        const content = result.choices?.[0]?.message?.content || '';
        const match = content.match(/\[[\d,\s]+\]/);
        if (match) {
            const rankedIndices = JSON.parse(match[0]);
            const reranked = rankedIndices
                .filter(i => i >= 0 && i < results.length)
                .map(i => results[i])
                .slice(0, 8);
            if (reranked.length > 0) return reranked;
        }
    } catch (e) {
        console.warn('Reranking failed, using original order:', e.message);
    }

    return results.slice(0, 8);
}

// ── Stage 6: Build context ──
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

// ── Stage 6b: Call GPT for final answer ──
async function callGPT(context, messages) {
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

    const result = await httpsRequest({
        hostname: GPT_ENDPOINT,
        path: `/openai/deployments/${GPT_DEPLOYMENT}/chat/completions?api-version=2025-01-01-preview`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': GPT_KEY }
    }, {
        messages: augmentedMessages,
        max_completion_tokens: 4096
    });

    return result.choices?.[0]?.message?.content || 'No se pudo generar una respuesta.';
}

// ── Main handler ──
module.exports = async function (context, req) {
    try {
        const body = req.body || {};
        const messages = body.messages || [];

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
        context.log(`RAG query: "${query.substring(0, 100)}"`);

        // Stage 1: Query Expansion (Nano) — context-aware with conversation history
        const expandedQuery = await expandQuery(query, messages);
        context.log(`Expanded: "${expandedQuery.substring(0, 150)}"`);

        // Stage 2: Embed EXPANDED query (critical: expanded query contains legal terms
        // that match the actual normative text, e.g. "nacimiento" vs colloquial "maternidad")
        const embedding = await embedQuery(expandedQuery);

        // Stage 3: Build sparse vector from expanded query
        const sparseVector = buildSparseVector(expandedQuery);

        // Stage 4: Search all collections (hybrid: dense + sparse, RRF fusion)
        const searchResults = await searchAllCollections(embedding, sparseVector);
        context.log(`Search results: ${searchResults.length} from ${new Set(searchResults.map(r => r.collection)).size} collections`);

        // Stage 5: Rerank with Nano
        const rerankedResults = await rerankResults(query, searchResults);
        context.log(`After reranking: ${rerankedResults.length} results`);

        // Stage 6: Build context + call GPT
        const ragContext = buildContext(rerankedResults);
        const answer = await callGPT(ragContext, messages);

        const sources = rerankedResults.map(r => ({
            law: r.law || '',
            section: r.section || '',
            chapter: r.chapter || '',
            collection: r.collection
        }));

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
                choices: [{
                    message: { role: 'assistant', content: answer }
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
