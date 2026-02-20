/**
 * upload_criterios_qdrant.js — Upload criterios INSS to Qdrant collection "criterios_inss".
 *
 * One point per criterio (no chunking).
 * Dense embedding text: descripcion + palabras_clave.
 * Sparse vector: precomputed in criterios_sparse_vectors.json.
 *
 * Usage:
 *   node src/scripts/upload_criterios_qdrant.js --limit 50 --wipe
 *   node src/scripts/upload_criterios_qdrant.js --resume
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');
const DATA_PATH = path.join(ROOT, 'data', 'chunks', 'criterios_enriched.json');
const SPARSE_PATH = path.join(ROOT, 'data', 'chunks', 'criterios_sparse_vectors.json');
const PROGRESS_PATH = path.join(ROOT, 'data', 'chunks', 'criterios_upload_progress.json');

const args = process.argv.slice(2);
const batchSizeArg = args.includes('--batch-size')
    ? parseInt(args[args.indexOf('--batch-size') + 1], 10)
    : 40;
const limitArg = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1], 10)
    : 0;
const resumeMode = args.includes('--resume');
const wipeMode = args.includes('--wipe');

const COLLECTION = 'criterios_inss';

function loadEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        console.error(`ERROR: .env not found at ${ENV_PATH}`);
        process.exit(1);
    }

    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '');
        if (!process.env[key]) process.env[key] = value;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build text for dense embedding. Criterios are short, so we use
 * descripcion (concise summary) + palabras_clave (domain keywords).
 */
function buildEmbeddingText(item) {
    const desc = item.descripcion || '';
    const keywords = Array.isArray(item.palabras_clave) ? item.palabras_clave.join(', ') : '';
    const merged = `${desc}\n${keywords}`.trim();

    // Fallback: titulo + beginning of text
    const fallback = [item.titulo || '', (item.text || '').slice(0, 1200)].join('\n').trim();
    const text = merged || fallback;

    const maxChars = 12000;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
}

async function embedBatch(texts) {
    const endpoint = process.env.AZURE_OPENAI_READER_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_READER_KEY;

    const url = `https://${endpoint}/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-06-01`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify({ input: texts }),
    });

    if (!response.ok) {
        throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    return json.data.map(x => x.embedding);
}

async function upsertBatch(points) {
    const qdrantUrl = process.env.QDRANT_URL;
    const apiKey = process.env.QDRANT_API_KEY;

    const response = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points?wait=true`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify({ points }),
    });

    if (!response.ok) {
        throw new Error(`Qdrant upsert ${response.status}: ${await response.text()}`);
    }

    return response.json();
}

async function recreateCollectionIfNeeded() {
    const qdrantUrl = process.env.QDRANT_URL;
    const apiKey = process.env.QDRANT_API_KEY;

    if (!wipeMode) return;

    console.log('Deleting existing collection...');
    try {
        await fetch(`${qdrantUrl}/collections/${COLLECTION}`, {
            method: 'DELETE',
            headers: { 'api-key': apiKey },
        });
    } catch (_) {
        // ignore
    }

    await sleep(1500);

    console.log('Creating collection...');
    const create = await fetch(`${qdrantUrl}/collections/${COLLECTION}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify({
            vectors: {
                'text-dense': { size: 1536, distance: 'Cosine' },
            },
            sparse_vectors: {
                'text-sparse': {},
            },
        }),
    });

    if (!create.ok) {
        throw new Error(`Failed creating collection: ${await create.text()}`);
    }

    console.log('Collection ready.\n');
    await sleep(1500);
}

function parseNumericId(item, fallbackIndex) {
    const fromId = Number(item.criterio_id);
    if (Number.isFinite(fromId) && fromId > 0) return Math.trunc(fromId);
    return 800000000 + fallbackIndex;
}

async function main() {
    loadEnv();

    const required = ['QDRANT_URL', 'QDRANT_API_KEY', 'AZURE_OPENAI_READER_ENDPOINT', 'AZURE_OPENAI_READER_KEY'];
    for (const key of required) {
        if (!process.env[key]) {
            console.error(`Missing env var: ${key}`);
            process.exit(1);
        }
    }

    if (!fs.existsSync(DATA_PATH)) {
        console.error(`Input not found: ${DATA_PATH}`);
        process.exit(1);
    }
    if (!fs.existsSync(SPARSE_PATH)) {
        console.error(`Sparse vectors not found: ${SPARSE_PATH}`);
        process.exit(1);
    }

    const allItems = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    const allSparse = JSON.parse(fs.readFileSync(SPARSE_PATH, 'utf-8'));

    if (allItems.length !== allSparse.length) {
        console.error(`Mismatch: items=${allItems.length}, sparse=${allSparse.length}`);
        process.exit(1);
    }

    const items = limitArg > 0 ? allItems.slice(0, limitArg) : allItems;
    const sparseVectors = limitArg > 0 ? allSparse.slice(0, limitArg) : allSparse;

    console.log('=== Upload Criterios INSS to Qdrant ===\n');
    console.log(`Collection: ${COLLECTION}`);
    console.log(`Items: ${items.length}`);
    console.log(`Batch size: ${batchSizeArg}`);
    console.log(`Resume: ${resumeMode}`);
    console.log(`Wipe: ${wipeMode}\n`);

    await recreateCollectionIfNeeded();

    let uploaded = new Set();
    if (resumeMode && fs.existsSync(PROGRESS_PATH)) {
        const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
        uploaded = new Set(progress.uploaded_ids || []);
        console.log(`Resuming with ${uploaded.size} already uploaded\n`);
    }

    let ok = 0;
    let err = 0;
    const start = Date.now();

    for (let i = 0; i < items.length; i += batchSizeArg) {
        const end = Math.min(i + batchSizeArg, items.length);

        const batchItems = [];
        const batchSparse = [];
        const batchIdx = [];

        for (let j = i; j < end; j++) {
            const id = parseNumericId(items[j], j);
            if (!uploaded.has(id)) {
                batchItems.push(items[j]);
                batchSparse.push(sparseVectors[j]);
                batchIdx.push({ sourceIndex: j, pointId: id });
            }
        }

        if (batchItems.length === 0) continue;

        try {
            const texts = batchItems.map(buildEmbeddingText);
            const embeddings = await embedBatch(texts);

            const points = batchItems.map((item, idx) => {
                const pointId = batchIdx[idx].pointId;
                const sparse = batchSparse[idx] || { indices: [], values: [] };

                return {
                    id: pointId,
                    vector: {
                        'text-dense': embeddings[idx],
                        'text-sparse': {
                            indices: sparse.indices || [],
                            values: sparse.values || [],
                        },
                    },
                    payload: {
                        // Compatibility with current backend ChunkResult model
                        law: item.criterio_num || '',
                        chapter: item.fecha || '',
                        section: 'Criterio INSS',
                        text: item.text || '',
                        resumen: item.descripcion || '',
                        palabras_clave: item.palabras_clave || [],
                        refs: [],

                        // Criterios-specific fields
                        criterio_id: item.criterio_id || null,
                        criterio_num: item.criterio_num || '',
                        titulo: item.titulo || '',
                        descripcion: item.descripcion || '',
                        fecha: item.fecha || '',
                        emisor: item.emisor || '',
                        estado: item.estado || '',
                        normativa_refs: item.normativa_refs || [],
                    },
                };
            });

            await upsertBatch(points);

            for (const x of batchIdx) uploaded.add(x.pointId);
            ok += batchItems.length;

            fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
                uploaded_ids: [...uploaded],
                total: items.length,
                timestamp: new Date().toISOString(),
            }));

            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            const rate = (ok / Math.max(1, Number(elapsed))).toFixed(2);
            const eta = ((items.length - ok) / Math.max(0.01, Number(rate))).toFixed(0);
            console.log(`[${ok}/${items.length}] batch ${i}-${end} OK | ${rate} item/s | ETA ${eta}s`);

            await sleep(2000);
        } catch (e) {
            err += batchItems.length;
            console.error(`[ERROR] batch ${i}-${end}: ${e.message}`);

            if (String(e.message).includes('429')) {
                console.log('Rate limited. Waiting 60s...');
                await sleep(60000);
                i -= batchSizeArg;
            } else {
                await sleep(2000);
            }
        }
    }

    const totalSec = ((Date.now() - start) / 1000).toFixed(1);
    console.log('\n=== Upload completed ===');
    console.log(`Uploaded: ${ok}/${items.length}`);
    console.log(`Errors: ${err}`);
    console.log(`Time: ${totalSec}s`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
