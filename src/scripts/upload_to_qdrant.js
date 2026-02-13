/**
 * upload_to_qdrant.js — Sube chunks enriquecidos a Qdrant Cloud con embeddings + sparse vectors.
 *
 * Para cada chunk:
 * 1. Genera embedding con text-embedding-3-small (Azure OpenAI)
 * 2. Carga sparse vector precalculado (de build_tfidf.js)
 * 3. Sube a Qdrant con payload (law, chapter, section, text, resumen, palabras_clave)
 *
 * Uso:
 *   node src/scripts/upload_to_qdrant.js [--collection normativa] [--batch-size 50] [--resume]
 *
 * Requiere .env con: QDRANT_URL, QDRANT_API_KEY, AZURE_OPENAI_READER_ENDPOINT, AZURE_OPENAI_READER_KEY
 */

const fs = require('fs');
const path = require('path');

// --- Configuración ---
const CHUNKS_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_v3_enriched.json');
const SPARSE_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_sparse_vectors.json');
const PROGRESS_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'qdrant_upload_progress.json');
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// Parse args
const args = process.argv.slice(2);
const collectionArg = args.indexOf('--collection') !== -1 ? args[args.indexOf('--collection') + 1] : 'normativa';
const batchSizeArg = args.indexOf('--batch-size') !== -1 ? parseInt(args[args.indexOf('--batch-size') + 1]) : 50;
const resumeMode = args.includes('--resume');
const wipeMode = args.includes('--wipe');

// --- Cargar .env ---
function loadEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        console.error('ERROR: .env not found at', ENV_PATH);
        process.exit(1);
    }
    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
}

// --- Embedding con Azure OpenAI ---
async function embedBatch(texts) {
    const endpoint = process.env.AZURE_OPENAI_READER_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_READER_KEY;

    const url = `https://${endpoint}/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-06-01`;

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify({
            input: texts,
            // 1536 dims (full) — Qdrant tiene espacio de sobra
        }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Embedding API error ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    return data.data.map(d => d.embedding);
}

// --- Upload batch a Qdrant ---
async function upsertBatch(collection, points) {
    const qdrantUrl = process.env.QDRANT_URL;
    const apiKey = process.env.QDRANT_API_KEY;

    const resp = await fetch(`${qdrantUrl}/collections/${collection}/points?wait=true`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify({ points }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Qdrant upsert error ${resp.status}: ${err}`);
    }

    return await resp.json();
}

// --- Construir texto para embedding ---
// text-embedding-3-small max = 8191 tokens (~32K chars). Truncamos a 30K para margen.
const MAX_EMBED_CHARS = 30000;
function buildEmbeddingText(chunk) {
    const parts = [];
    if (chunk.law) parts.push(chunk.law);
    if (chunk.section) parts.push(chunk.section);
    if (chunk.text) parts.push(chunk.text);
    const full = parts.join('\n');
    return full.length > MAX_EMBED_CHARS ? full.slice(0, MAX_EMBED_CHARS) : full;
}

// --- Sleep ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    loadEnv();

    const QDRANT_URL = process.env.QDRANT_URL;
    const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
    const READER_ENDPOINT = process.env.AZURE_OPENAI_READER_ENDPOINT;

    if (!QDRANT_URL || !QDRANT_API_KEY) {
        console.error('ERROR: QDRANT_URL y QDRANT_API_KEY requeridos en .env');
        process.exit(1);
    }
    if (!READER_ENDPOINT) {
        console.error('ERROR: AZURE_OPENAI_READER_ENDPOINT requerido en .env');
        process.exit(1);
    }

    console.log('=== Upload to Qdrant Cloud ===\n');
    console.log(`Colección: ${collectionArg}`);
    console.log(`Batch size: ${batchSizeArg}`);
    console.log(`Qdrant: ${QDRANT_URL}`);
    console.log(`Embeddings: ${READER_ENDPOINT}`);
    if (wipeMode) console.log(`⚠️  WIPE MODE: se borrará y recreará la colección`);
    console.log();

    // 0. Wipe collection if requested
    if (wipeMode) {
        console.log('Borrando colección existente...');
        try {
            const delResp = await fetch(`${QDRANT_URL}/collections/${collectionArg}`, {
                method: 'DELETE',
                headers: { 'api-key': QDRANT_API_KEY },
            });
            console.log(`  DELETE: ${delResp.status}`);
        } catch (e) {
            console.log(`  (No existía o error: ${e.message})`);
        }
        await sleep(2000);

        console.log('Recreando colección...');
        const createResp = await fetch(`${QDRANT_URL}/collections/${collectionArg}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'api-key': QDRANT_API_KEY },
            body: JSON.stringify({
                vectors: {
                    'text-dense': { size: 1536, distance: 'Cosine' },
                },
                sparse_vectors: {
                    'text-sparse': {},
                },
            }),
        });
        if (!createResp.ok) {
            const err = await createResp.text();
            console.error(`ERROR creando colección: ${err}`);
            process.exit(1);
        }
        console.log('  ✅ Colección recreada.\n');
        await sleep(2000);
    }

    // 1. Cargar chunks
    console.log('Cargando chunks...');
    const chunks = JSON.parse(fs.readFileSync(CHUNKS_PATH, 'utf-8'));
    console.log(`  ${chunks.length} chunks cargados.`);

    // 2. Cargar sparse vectors
    console.log('Cargando sparse vectors...');
    const sparseVectors = JSON.parse(fs.readFileSync(SPARSE_PATH, 'utf-8'));
    if (sparseVectors.length !== chunks.length) {
        console.error(`ERROR: Mismatch — ${chunks.length} chunks pero ${sparseVectors.length} sparse vectors`);
        process.exit(1);
    }
    console.log(`  ${sparseVectors.length} sparse vectors cargados.\n`);

    // 3. Cargar progreso si resume
    let uploaded = new Set();
    if (resumeMode && fs.existsSync(PROGRESS_PATH)) {
        const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
        uploaded = new Set(progress.uploaded_ids || []);
        console.log(`Resumiendo: ${uploaded.size} chunks ya subidos.\n`);
    }

    // 4. Procesar en batches
    const total = chunks.length;
    let successCount = uploaded.size;
    let errorCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < total; i += batchSizeArg) {
        const batchEnd = Math.min(i + batchSizeArg, total);
        const batchChunks = [];
        const batchSparse = [];
        const batchIndices = [];

        // Filtrar ya subidos
        for (let j = i; j < batchEnd; j++) {
            const id = j; // Usamos índice como ID
            if (!uploaded.has(id)) {
                batchChunks.push(chunks[j]);
                batchSparse.push(sparseVectors[j]);
                batchIndices.push(j);
            }
        }

        if (batchChunks.length === 0) continue;

        try {
            // Generar embeddings
            const texts = batchChunks.map(c => buildEmbeddingText(c));
            const embeddings = await embedBatch(texts);

            // Construir points para Qdrant
            const points = batchChunks.map((chunk, idx) => ({
                id: batchIndices[idx],
                vector: {
                    'text-dense': embeddings[idx],
                    'text-sparse': {
                        indices: batchSparse[idx].indices,
                        values: batchSparse[idx].values,
                    },
                },
                payload: {
                    law: chunk.law || '',
                    chapter: chunk.chapter || '',
                    section: chunk.section || '',
                    text: chunk.text || '',
                    resumen: chunk.resumen || '',
                    palabras_clave: chunk.palabras_clave || [],
                },
            }));

            // Upload
            await upsertBatch(collectionArg, points);

            // Marcar como subidos
            for (const idx of batchIndices) {
                uploaded.add(idx);
            }
            successCount += batchChunks.length;

            // Guardar progreso
            fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
                uploaded_ids: [...uploaded],
                total: total,
                timestamp: new Date().toISOString(),
            }));

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = (successCount / (elapsed || 1)).toFixed(1);
            const eta = ((total - successCount) / (rate || 1)).toFixed(0);
            console.log(`  [${successCount}/${total}] Batch ${i}-${batchEnd} OK (${elapsed}s, ${rate} chunks/s, ETA ${eta}s)`);

            // Rate limit: Azure OpenAI tiene ~350K tokens/min para embeddings
            await sleep(2000);

        } catch (err) {
            errorCount += batchChunks.length;
            console.error(`  [ERROR] Batch ${i}-${batchEnd}: ${err.message}`);

            // Retry con backoff
            if (err.message.includes('429') || err.message.includes('throttl')) {
                console.log('  Rate limited. Esperando 60s...');
                await sleep(60000);
                i -= batchSizeArg; // Reintentar este batch
            } else {
                await sleep(2000);
            }
        }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Upload completado ===`);
    console.log(`  Subidos: ${successCount}/${total}`);
    console.log(`  Errores: ${errorCount}`);
    console.log(`  Tiempo total: ${totalTime}s`);

    // Verificar conteo en Qdrant
    try {
        const resp = await fetch(`${QDRANT_URL}/collections/${collectionArg}`, {
            headers: { 'api-key': QDRANT_API_KEY },
        });
        const data = await resp.json();
        console.log(`  Points en Qdrant: ${data.result.points_count}`);
    } catch (e) {
        console.log(`  (No se pudo verificar conteo: ${e.message})`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
