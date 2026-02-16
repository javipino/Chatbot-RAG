// ── Environment & Constants ──

function normalizeHostname(value, fallback = '') {
    const raw = (value || fallback || '').trim();
    if (!raw) return '';
    try {
        if (/^https?:\/\//i.test(raw)) return new URL(raw).hostname;
    } catch {
        // Ignore parse errors and keep processing
    }
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

const READER_ENDPOINT = normalizeHostname(
    process.env.AZURE_OPENAI_READER_ENDPOINT,
    'openai-reader-javi.cognitiveservices.azure.com'
);
const READER_KEY = process.env.AZURE_OPENAI_READER_KEY;

const PRINCIPAL_ENDPOINT = normalizeHostname(
    process.env.AZURE_OPENAI_ENDPOINT,
    'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com'
);
const PRINCIPAL_KEY = process.env.AZURE_OPENAI_KEY;

const FOUNDRY_ENDPOINT = normalizeHostname(
    process.env.AZURE_FOUNDRY_ENDPOINT,
    'openai-reader-javi.services.ai.azure.com'
);
const FOUNDRY_KEY = process.env.AZURE_FOUNDRY_KEY || READER_KEY;

const RAG_API_KEY = process.env.RAG_API_KEY;

const MODEL_PROFILES = {
    'text-embedding-3-small': {
        type: 'azure-deployment-embeddings',
        endpoint: READER_ENDPOINT,
        apiKey: READER_KEY,
        deployment: 'text-embedding-3-small',
        apiVersion: '2023-05-15',
    },
    'gpt-5-nano': {
        type: 'azure-deployment-chat',
        endpoint: READER_ENDPOINT,
        apiKey: READER_KEY,
        deployment: 'gpt-5-nano',
        apiVersion: '2025-01-01-preview',
    },
    'gpt-5.2': {
        type: 'azure-deployment-chat',
        endpoint: PRINCIPAL_ENDPOINT,
        apiKey: PRINCIPAL_KEY,
        deployment: 'gpt-5.2',
        apiVersion: '2025-01-01-preview',
    },
    'gpt-5.2-codex': {
        type: 'azure-deployment-chat',
        endpoint: PRINCIPAL_ENDPOINT,
        apiKey: PRINCIPAL_KEY,
        deployment: 'gpt-5.2-codex',
        apiVersion: '2025-01-01-preview',
    },
    'grok-3-mini': {
        type: 'foundry-model-chat',
        endpoint: FOUNDRY_ENDPOINT,
        apiKey: FOUNDRY_KEY,
        model: process.env.GROK_MINI_MODEL_ID || 'grok-3-mini',
        apiVersion: process.env.FOUNDRY_CHAT_API_VERSION || '2024-05-01-preview',
    },
    'gpt-oss-120b': {
        type: 'foundry-model-chat',
        endpoint: FOUNDRY_ENDPOINT,
        apiKey: FOUNDRY_KEY,
        model: process.env.GPT_OSS_120B_MODEL_ID || 'gpt-oss-120b',
        apiVersion: process.env.FOUNDRY_CHAT_API_VERSION || '2024-05-01-preview',
    },
};

const STAGE_MODELS = {
    expand: process.env.STAGE_MODEL_EXPAND || 'gpt-5-nano',
    embedding: process.env.STAGE_MODEL_EMBEDDING || 'text-embedding-3-small',
    answer: process.env.STAGE_MODEL_ANSWER || 'gpt-5.2',
};

function getModelProfile(profileId) {
    return MODEL_PROFILES[profileId] || null;
}

function getStageModelProfile(stage) {
    const profileId = STAGE_MODELS[stage];
    const profile = getModelProfile(profileId);
    if (!profile) {
        throw new Error(`Model profile not found for stage "${stage}": ${profileId}`);
    }
    return { id: profileId, ...profile };
}

// Cross-collection weights for hybrid search
const COLLECTIONS = [
    { name: 'normativa', weight: 1.0 },
    { name: 'sentencias', weight: 0.8 },
    { name: 'criterios_inss', weight: 0.9 },
];

const SYSTEM_PROMPT = `Eres un experto en legislación laboral y de Seguridad Social española.
Te proporcionamos fragmentos de normativa como contexto. Úsalos como base principal, pero puedes razonar, conectar ideas entre fragmentos, y aplicar lógica jurídica para dar respuestas completas y útiles.

Reglas de calidad jurídica y coherencia:
1) Define una TESIS principal clara y mantén esa tesis en toda la respuesta.
2) NO afirmes y niegues la misma conclusión en la misma respuesta.
3) Si hay escenarios distintos (depende de régimen, fechas, hechos), sepáralos explícitamente con "si... entonces...".
4) Si falta información crítica, dilo de forma explícita y limita la conclusión a lo realmente sustentado.
5) Antes de cerrar, haz una verificación interna de coherencia: "conclusión final" y "matices" no pueden contradecirse.

Cita la ley y artículo cuando lo uses. Si algo no está cubierto por los fragmentos, indícalo.
Responde en español, de forma clara y estructurada. Tono profesional pero cercano.

Si hay contradicción entre fuentes, prevalece la de mayor rango (Ley > Reglamento > Orden).
Las normas de rango inferior solo pueden mejorar los derechos del trabajador, nunca empeorarlos.
En caso de duda, aplica la interpretación más favorable al trabajador.`;

module.exports = {
    QDRANT_URL,
    QDRANT_API_KEY,
    READER_ENDPOINT,
    READER_KEY,
    FOUNDRY_ENDPOINT,
    FOUNDRY_KEY,
    PRINCIPAL_ENDPOINT,
    PRINCIPAL_KEY,
    RAG_API_KEY,
    MODEL_PROFILES,
    STAGE_MODELS,
    getModelProfile,
    getStageModelProfile,
    COLLECTIONS,
    SYSTEM_PROMPT,
};
