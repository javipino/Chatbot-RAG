// ── Environment & Constants ──

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

const READER_ENDPOINT = process.env.AZURE_OPENAI_READER_ENDPOINT || 'openai-reader-javi.cognitiveservices.azure.com';
const READER_KEY = process.env.AZURE_OPENAI_READER_KEY;

const PRINCIPAL_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com';
const PRINCIPAL_KEY = process.env.AZURE_OPENAI_KEY;

const RAG_API_KEY = process.env.RAG_API_KEY;

const EMBEDDING_DEPLOYMENT = 'text-embedding-3-small';
const NANO_DEPLOYMENT = 'gpt-5-nano';
const GPT52_DEPLOYMENT = 'gpt-5.2';

// Cross-collection weights for hybrid search
const COLLECTIONS = [
    { name: 'normativa', weight: 1.0 },
    { name: 'sentencias', weight: 0.8 },
    { name: 'criterios_inss', weight: 0.9 },
];

const SYSTEM_PROMPT = `Eres un experto en legislación laboral y de Seguridad Social española.
Te proporcionamos fragmentos de normativa como contexto. Úsalos como base principal, pero puedes razonar, conectar ideas entre fragmentos, y aplicar lógica jurídica para dar respuestas completas y útiles.

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
    PRINCIPAL_ENDPOINT,
    PRINCIPAL_KEY,
    RAG_API_KEY,
    EMBEDDING_DEPLOYMENT,
    NANO_DEPLOYMENT,
    GPT52_DEPLOYMENT,
    COLLECTIONS,
    SYSTEM_PROMPT,
};
