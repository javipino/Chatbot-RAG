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

// ── Stage 5b: Reference Chasing (LLM-based) ──
// Use DeepSeek-V3.2 to analyze results and identify missing legal articles that should be retrieved.
// Non-reasoning model: efficient tokens, clean output, no reasoning overhead.
async function identifyMissingReferences(query, results, context) {
    // Build a summary of what we already have
    const sourceSummary = results.map((r, i) =>
        `[${i}] ${r.law || '?'} > ${r.section || '?'}`
    ).join('\n');

    const textSnippets = results.map((r, i) =>
        `[${i}] ${(r.text || '').substring(0, 150)}`
    ).join('\n');

    try {
        const result = await httpsRequest({
            hostname: READER_ENDPOINT,
            path: `/openai/deployments/DeepSeek-V3.2/chat/completions?api-version=2024-10-21`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': READER_KEY }
        }, {
            messages: [
                {
                    role: 'system',
                    content: `Identifica artículos de ley española que faltan para responder la pregunta del usuario.
RESPONDE SOLO líneas con formato: ARTICULO|NOMBRE_LEY
Ejemplo de respuesta:
48|Estatuto Trabajadores
177|Ley General Seguridad Social
Máximo 3 líneas. Si no falta nada, responde: NINGUNO`
                },
                {
                    role: 'user',
                    content: `Pregunta: ${query}\n\nFragmentos disponibles:\n${sourceSummary}\n\nTexto:\n${textSnippets}\n\nArtículos que FALTAN:`
                }
            ],
            max_tokens: 200
        });

        const content = result.choices?.[0]?.message?.content || '';
        if (context?.log) context.log(`DeepSeek ref analysis raw: ${content.substring(0, 300)}`);

        if (content.includes('NINGUNO') || !content.trim()) return [];

        // Parse pipe-delimited lines: "48|Estatuto Trabajadores" or "48|Estatuto Trabajadores|motivo"
        const refs = [];
        for (const line of content.split('\n')) {
            const parts = line.trim().split('|');
            if (parts.length >= 2) {
                // Extract article number from first field (handles "48", "Art. 48", "artículo 48.4")
                const artMatch = parts[0].trim().match(/(\d+(?:\.\d+)?)/);
                // Extract article number from motivo field if first field was an ordinal (1, 2, 3)
                const motivoArtMatch = parts.length >= 3 ? parts[2].trim().match(/art[íi]culo\s+(\d+(?:\.\d+)?)/i) : null;
                
                const artNum = motivoArtMatch ? motivoArtMatch[1] : (artMatch ? artMatch[1] : null);
                if (artNum && parts[1].trim().length > 3) {
                    refs.push({
                        art: artNum,
                        ley: parts[1].trim(),
                        motivo: parts[2]?.trim() || ''
                    });
                }
            }
        }

        // Fallback: try JSON format if model produced it
        if (refs.length === 0) {
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return parsed.filter(r => r.art && r.ley).slice(0, 3);
                } catch { /* ignore parse error */ }
            }
        }

        return refs.slice(0, 3);
    } catch (e) {
        if (context?.log) context.log(`DeepSeek ref analysis failed: ${e.message}`);
    }
    return [];
}

async function chaseReferences(missingRefs, context) {
    if (!missingRefs.length) return [];

    const qdrantUrl = new URL(QDRANT_URL);
    const allMatched = [];

    for (const ref of missingRefs) {
        try {
            // Extract law keywords for Qdrant text filter
            const lawWords = ref.ley.replace(/Texto refundido de la Ley del?/gi, '').trim()
                .split(/\s+/).filter(w => w.length > 3).slice(0, 2).join(' ');
            const artBase = ref.art.split('.')[0];

            if (context?.log) context.log(`  Chasing Art.${artBase} (law filter: "${lawWords}")`);

            // Use Qdrant scroll with payload text filter
            const scrollResult = await httpsRequest({
                hostname: qdrantUrl.hostname,
                port: qdrantUrl.port || 6333,
                path: '/collections/normativa/points/scroll',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY }
            }, {
                limit: 5,
                with_payload: true,
                filter: {
                    must: [
                        { key: 'section', match: { text: `Artículo ${artBase}` } },
                        { key: 'law', match: { text: lawWords } }
                    ]
                }
            });

            const points = (scrollResult.result?.points || []).map(p => ({
                ...p.payload,
                score: 1.0,
                collection: 'normativa',
                id: p.id,
                _chased: true,
                _reason: ref.motivo || `Referenced: Art.${ref.art} ${ref.ley}`
            }));

            if (context?.log) context.log(`  → Found ${points.length} chunks for Art.${artBase}`);
            allMatched.push(...points);
        } catch (err) {
            if (context?.log) context.log(`  Scroll failed for Art.${ref.art}: ${err.message}`);
        }
    }

    return allMatched;
}

// ── Stage 5c: Context Evaluator (Kimi K2.5) — iterative ──
// Kimi evaluates if context is sufficient. If not, it requests more articles and drops irrelevant ones.
// Returns: { ready: true } or { ready: false, need: [{art, ley}], drop: [indices] }
const KIMI_DEPLOYMENT = 'Kimi-K2.5';

async function evaluateContext(query, results, context) {
    const numbered = results.map((r, i) => {
        const parts = [`[${i}] ${r.law || '?'} > ${r.section || '?'}`];
        if (r.text) parts.push(r.text.substring(0, 200));
        return parts.join('\n');
    }).join('\n\n');

    try {
        const result = await httpsRequest({
            hostname: READER_ENDPOINT,
            path: `/openai/deployments/${KIMI_DEPLOYMENT}/chat/completions?api-version=2025-01-01-preview`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': READER_KEY }
        }, {
            messages: [
                {
                    role: 'system',
                    content: `Eres un evaluador de contexto legal. Tu tarea es decidir si los fragmentos proporcionados son SUFICIENTES para responder la pregunta del usuario sobre legislación laboral española.

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

Ejemplo de respuesta B:
NEED|48|Estatuto Trabajadores
NEED|177|LGSS
DROP|0,3,7`
                },
                {
                    role: 'user',
                    content: `Pregunta: ${query}\n\nFragmentos disponibles:\n${numbered}`
                }
            ],
            max_completion_tokens: 2048,
            reasoning_effort: 'low'
        });

        const content = result.choices?.[0]?.message?.content || '';
        if (context?.log) context.log(`Kimi eval raw: ${content.substring(0, 300)}`);

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
        if (context?.log) context.log(`Kimi eval failed: ${e.message}`);
        return { ready: true, need: [], drop: [] }; // On error, proceed with what we have
    }
}

// ── Stage 6: Call GPT for final answer ──
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

        // Stage 2: Embed EXPANDED query
        const embedding = await embedQuery(expandedQuery);

        // Stage 3: Build sparse vector from expanded query
        const sparseVector = buildSparseVector(expandedQuery);

        // Stage 4: Search all collections (hybrid: dense + sparse, RRF fusion)
        const searchResults = await searchAllCollections(embedding, sparseVector);
        context.log(`Search results: ${searchResults.length} from ${new Set(searchResults.map(r => r.collection)).size} collections`);

        // Stage 5: Rerank with Nano
        const rerankedResults = await rerankResults(query, searchResults);
        context.log(`After reranking: ${rerankedResults.length} results`);

        // Stage 5b: Reference Chasing (DeepSeek — cheap first pass)
        let allResults = [...rerankedResults];
        let debugRefChasing = { missingRefs: [], chasedAdded: 0, error: null };
        try {
            const missingRefs = await identifyMissingReferences(query, rerankedResults, context);
            debugRefChasing.missingRefs = missingRefs.map(r => `Art.${r.art} ${r.ley}`);
            if (missingRefs.length > 0) {
                context.log(`5b: DeepSeek identified ${missingRefs.length} missing: ${missingRefs.map(r => `Art.${r.art} ${r.ley}`).join(', ')}`);
                const chasedResults = await chaseReferences(missingRefs, context);
                if (chasedResults.length > 0) {
                    const existingIds = new Set(allResults.map(r => r.id));
                    const newResults = chasedResults.filter(r => !existingIds.has(r.id));
                    allResults = [...allResults, ...newResults];
                    debugRefChasing.chasedAdded = newResults.length;
                    context.log(`5b: Added ${newResults.length} chased chunks`);
                }
            }
        } catch (refErr) {
            debugRefChasing.error = refErr.message;
            context.log.error('5b failed (non-fatal):', refErr.message);
        }

        // Stage 5c: Iterative Context Evaluation (Kimi K2.5)
        // Kimi checks if context is complete. If not, it requests more articles and drops irrelevant ones.
        const MAX_ITERATIONS = 2;
        let debugEval = { iterations: 0, needed: [], dropped: [], errors: [] };
        try {
            for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
                const evaluation = await evaluateContext(query, allResults, context);
                debugEval.iterations = iter + 1;

                if (evaluation.ready) {
                    context.log(`5c: Kimi says READY after iteration ${iter + 1}`);
                    break;
                }

                context.log(`5c iter ${iter + 1}: need=${evaluation.need.length}, drop=${evaluation.drop.length}`);

                // Drop irrelevant sources first (by index, descending to preserve indices)
                if (evaluation.drop.length > 0) {
                    const dropSet = new Set(evaluation.drop);
                    const before = allResults.length;
                    allResults = allResults.filter((_, i) => !dropSet.has(i));
                    const dropped = before - allResults.length;
                    debugEval.dropped.push(...evaluation.drop);
                    context.log(`  Dropped ${dropped} irrelevant chunks`);
                }

                // Chase additional refs requested by Kimi
                if (evaluation.need.length > 0) {
                    debugEval.needed.push(...evaluation.need.map(r => `Art.${r.art} ${r.ley}`));
                    const chasedMore = await chaseReferences(evaluation.need, context);
                    if (chasedMore.length > 0) {
                        const existingIds = new Set(allResults.map(r => r.id));
                        const newChased = chasedMore.filter(r => !existingIds.has(r.id));
                        allResults = [...allResults, ...newChased];
                        context.log(`  Added ${newChased.length} new chunks from Kimi request`);
                    }
                }

                // If Kimi didn't need anything more but dropped some, we're done
                if (evaluation.need.length === 0) break;
            }
        } catch (evalErr) {
            debugEval.errors.push(evalErr.message);
            context.log.error('5c eval failed (non-fatal):', evalErr.message);
        }

        // Stage 6: Build context + call GPT-5.2 (single call with clean, complete context)
        const ragContext = buildContext(allResults);
        const answer = await callGPT(ragContext, messages);

        const sources = allResults.map(r => ({
            law: r.law || '',
            section: r.section || '',
            chapter: r.chapter || '',
            collection: r.collection,
            _chased: r._chased || false
        }));

        context.res = {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
                choices: [{
                    message: { role: 'assistant', content: answer }
                }],
                sources,
                _debug: {
                    expandedQuery: expandedQuery.substring(0, 200),
                    searchResults: searchResults.length,
                    rerankedResults: rerankedResults.length,
                    refChasing: debugRefChasing,
                    contextEval: debugEval,
                    totalSources: allResults.length
                }
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
