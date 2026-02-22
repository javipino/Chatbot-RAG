/**
 * reembed_criterios_expanded.js
 * 
 * Fetches all criterios from Qdrant, expands acronyms in palabras_clave,
 * re-generates dense embeddings with the expanded text, and updates
 * the vectors in Qdrant (payload untouched).
 * 
 * Usage: node src/scripts/reembed_criterios_expanded.js [--dry-run]
 * 
 * Requires .env with:
 *   QDRANT_URL, QDRANT_API_KEY
 *   AZURE_OPENAI_READER_ENDPOINT, AZURE_OPENAI_READER_KEY
 */

const fs = require('fs');
const https = require('https');
const http = require('http');

// ── Load .env ──────────────────────────────────────────────────
const env = {};
fs.readFileSync('.env', 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([^#=]+)=(.+)/);
    if (m) env[m[1].trim()] = m[2].trim();
});

const DRY_RUN = process.argv.includes('--dry-run');
const EMBED_BATCH_SIZE = 50;   // Azure OpenAI supports up to 2048 inputs
const UPSERT_BATCH_SIZE = 100; // Qdrant batch size
const EMBED_MODEL = 'text-embedding-3-small';
const COLLECTION = 'criterios_inss';

// ── Acronym dictionary ─────────────────────────────────────────
// Format: acronym → expansion (will become "ACRONYM (expansion)")
// Only substantive domain terms — NOT legal citation prefixes (RD, art., etc.)
const ACRONYMS = {
    // Benefits & concepts
    'CRBG': 'complemento para la reducción de la brecha de género',
    'IT': 'incapacidad temporal',
    'IP': 'incapacidad permanente',
    'IPT': 'incapacidad permanente total',
    'IPA': 'incapacidad permanente absoluta',
    'GI': 'gran invalidez',
    'IMV': 'ingreso mínimo vital',
    'SMI': 'salario mínimo interprofesional',

    // Regimes
    'RETA': 'Régimen Especial de Trabajadores Autónomos',
    'REA': 'Régimen Especial Agrario',
    'SOVI': 'Seguro Obligatorio de Vejez e Invalidez',
    'REMC': 'Régimen Especial de la Minería del Carbón',

    // Institutions & bodies
    'INSS': 'Instituto Nacional de la Seguridad Social',
    'TGSS': 'Tesorería General de la Seguridad Social',
    'SEPE': 'Servicio Público de Empleo Estatal',
    'EVI': 'Equipo de Valoración de Incapacidades',
    'MUFACE': 'Mutualidad General de Funcionarios Civiles del Estado',
    'MUGEJU': 'Mutualidad General Judicial',
    'ISFAS': 'Instituto Social de las Fuerzas Armadas',
    'IMSERSO': 'Instituto de Mayores y Servicios Sociales',
    'ONCE': 'Organización Nacional de Ciegos Españoles',

    // Laws
    'LGSS': 'Ley General de la Seguridad Social',
    'LET': 'Ley del Estatuto de los Trabajadores',
    'ET': 'Estatuto de los Trabajadores',
    'LIMV': 'Ley del Ingreso Mínimo Vital',
    'LPRL': 'Ley de Prevención de Riesgos Laborales',
    'PRL': 'prevención de riesgos laborales',
    'EBEP': 'Estatuto Básico del Empleado Público',

    // Employment
    'ERE': 'expediente de regulación de empleo',
    'ERTE': 'expediente de regulación temporal de empleo',

    // Courts
    'TJUE': 'Tribunal de Justicia de la Unión Europea',
    'TS': 'Tribunal Supremo',
    'TC': 'Tribunal Constitucional',
    'TSJ': 'Tribunal Superior de Justicia',

    // Other
    'CEE': 'Centro Especial de Empleo',
    'AT': 'accidente de trabajo',
    'EP': 'enfermedad profesional',
    'IRPF': 'Impuesto sobre la Renta de las Personas Físicas',
    'IPREM': 'Indicador Público de Renta de Efectos Múltiples',
    'TRADE': 'trabajador autónomo económicamente dependiente',
};

// ── HTTP helpers ───────────────────────────────────────────────
function request(url, method, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const opts = { method, headers, hostname: u.hostname, port: u.port, path: u.pathname + u.search };
        const req = lib.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${d.substring(0, 500)}`));
                } else {
                    try { resolve(JSON.parse(d)); }
                    catch { reject(new Error(`Parse error: ${d.substring(0, 300)}`)); }
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function ensureHttps(u) { return u.startsWith('https://') ? u : 'https://' + u; }

// ── Embedding ──────────────────────────────────────────────────
async function embedBatch(texts) {
    const ep = ensureHttps(env.AZURE_OPENAI_READER_ENDPOINT);
    const url = `${ep}/openai/deployments/${EMBED_MODEL}/embeddings?api-version=2024-06-01`;
    const r = await request(url, 'POST',
        { 'api-key': env.AZURE_OPENAI_READER_KEY, 'Content-Type': 'application/json' },
        { input: texts, model: EMBED_MODEL });
    // Sort by index to ensure order matches input
    return r.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

// ── Acronym expander ───────────────────────────────────────────
function expandAcronyms(text) {
    let expanded = text;
    let changes = [];
    for (const [acr, full] of Object.entries(ACRONYMS)) {
        // Match whole-word acronym (not already followed by opening paren)
        const regex = new RegExp(`\\b${acr}\\b(?!\\s*\\()`, 'g');
        if (regex.test(expanded)) {
            changes.push(acr);
            expanded = expanded.replace(regex, `${acr} (${full})`);
        }
    }
    return { expanded, changes };
}

// ── Build embedding text (matches upload_criterios_qdrant.js) ──
function buildEmbeddingText(descripcion, palabrasClave) {
    const desc = descripcion || '';
    const keywords = (palabrasClave || []).join(', ');
    return `${desc}\n${keywords}`;
}

// ── Qdrant helpers ─────────────────────────────────────────────
async function scrollAll() {
    const points = [];
    let offset = null;
    while (true) {
        const body = {
            limit: 100,
            with_payload: { include: ['descripcion', 'palabras_clave', 'criterio_num'] },
            with_vector: false
        };
        if (offset) body.offset = offset;

        const r = await request(
            `${env.QDRANT_URL}/collections/${COLLECTION}/points/scroll`,
            'POST',
            { 'api-key': env.QDRANT_API_KEY, 'Content-Type': 'application/json' },
            body
        );
        points.push(...r.result.points);
        offset = r.result.next_page_offset;
        if (!offset) break;
    }
    return points;
}

async function updateVectors(batch) {
    // PUT /collections/{name}/points/vectors
    const url = `${env.QDRANT_URL}/collections/${COLLECTION}/points/vectors`;
    await request(url, 'PUT',
        { 'api-key': env.QDRANT_API_KEY, 'Content-Type': 'application/json' },
        {
            points: batch.map(b => ({
                id: b.id,
                vector: { 'text-dense': b.vector }
            }))
        }
    );
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
    console.log(`=== Re-embed criterios with expanded acronyms ===`);
    console.log(`Collection: ${COLLECTION}`);
    console.log(`Dry run: ${DRY_RUN}`);
    console.log(`Acronyms defined: ${Object.keys(ACRONYMS).length}\n`);

    // 1. Fetch all points
    console.log('Fetching all criterios from Qdrant...');
    const points = await scrollAll();
    console.log(`Fetched ${points.length} points\n`);

    // 2. Build expanded embedding texts
    let totalExpansions = 0;
    const acronymStats = new Map(); // acronym → count of chunks affected
    const tasks = [];

    for (const p of points) {
        const desc = p.payload.descripcion || '';
        const kws = p.payload.palabras_clave || [];
        const criterioNum = p.payload.criterio_num || '?';

        const originalText = buildEmbeddingText(desc, kws);
        const { expanded: expandedText, changes } = expandAcronyms(originalText);

        if (changes.length > 0) {
            totalExpansions++;
            for (const c of changes) {
                acronymStats.set(c, (acronymStats.get(c) || 0) + 1);
            }
        }

        tasks.push({
            id: p.id,
            criterioNum,
            originalText,
            expandedText,
            changes,
            needsUpdate: expandedText !== originalText
        });
    }

    // Stats
    const needUpdate = tasks.filter(t => t.needsUpdate);
    console.log(`=== EXPANSION STATS ===`);
    console.log(`Chunks needing update: ${needUpdate.length} / ${tasks.length}`);
    console.log(`\nAcronyms expanded:`);
    const sortedStats = [...acronymStats.entries()].sort((a, b) => b[1] - a[1]);
    for (const [acr, count] of sortedStats) {
        console.log(`  ${acr.padEnd(10)} → ${ACRONYMS[acr].substring(0, 50).padEnd(52)} (${count} chunks)`);
    }

    // Show samples
    console.log(`\n=== SAMPLES (first 5 changed) ===`);
    for (const t of needUpdate.slice(0, 5)) {
        console.log(`\n--- Criterio ${t.criterioNum} (id=${t.id}) ---`);
        console.log(`Changes: ${t.changes.join(', ')}`);
        console.log(`BEFORE: ${t.originalText.substring(0, 200)}`);
        console.log(`AFTER:  ${t.expandedText.substring(0, 200)}`);
    }

    if (DRY_RUN) {
        console.log('\n=== DRY RUN — no changes made ===');
        return;
    }

    // 3. Embed ALL texts (even unchanged, to ensure consistency)
    // We re-embed everything so the embeddings are all from the same model call session
    console.log(`\n=== EMBEDDING ${tasks.length} texts in batches of ${EMBED_BATCH_SIZE} ===`);
    const allTexts = tasks.map(t => t.expandedText);
    const allVectors = [];

    for (let i = 0; i < allTexts.length; i += EMBED_BATCH_SIZE) {
        const batch = allTexts.slice(i, i + EMBED_BATCH_SIZE);
        const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(allTexts.length / EMBED_BATCH_SIZE);
        process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} texts)...`);

        const vectors = await embedBatch(batch);
        allVectors.push(...vectors);
        console.log(` done (${allVectors.length}/${allTexts.length})`);

        // Rate limiting: small delay between batches
        if (i + EMBED_BATCH_SIZE < allTexts.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    console.log(`\nEmbedded ${allVectors.length} texts`);

    // 4. Update vectors in Qdrant
    console.log(`\n=== UPDATING VECTORS in Qdrant (batches of ${UPSERT_BATCH_SIZE}) ===`);
    const updatePayloads = tasks.map((t, i) => ({ id: t.id, vector: allVectors[i] }));

    for (let i = 0; i < updatePayloads.length; i += UPSERT_BATCH_SIZE) {
        const batch = updatePayloads.slice(i, i + UPSERT_BATCH_SIZE);
        const batchNum = Math.floor(i / UPSERT_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(updatePayloads.length / UPSERT_BATCH_SIZE);
        process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} points)...`);

        await updateVectors(batch);
        console.log(` done`);

        if (i + UPSERT_BATCH_SIZE < updatePayloads.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log(`\n=== COMPLETE ===`);
    console.log(`Updated ${updatePayloads.length} vectors in ${COLLECTION}`);
    console.log(`${needUpdate.length} had acronym expansions, rest re-embedded for consistency`);
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
