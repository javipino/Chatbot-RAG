/**
 * enrich_pending.js — Enriquece los chunks pendientes de v3 con GPT-5 Nano.
 *
 * Lee normativa_chunks_v3_enriched.json y enrichment_pending.json,
 * llama a Nano para cada chunk con enrichment null, y guarda el resultado.
 *
 * Uso:
 *   node src/scripts/enrich_pending.js [--concurrency 5] [--dry-run]
 *
 * Requiere .env con: AZURE_OPENAI_READER_ENDPOINT, AZURE_OPENAI_READER_KEY
 */

const fs = require('fs');
const path = require('path');

// --- Rutas ---
const V3_ENRICHED_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_v3_enriched.json');
const PENDING_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'enrichment_pending.json');
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// --- Args ---
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const concurrencyArg = args.indexOf('--concurrency') !== -1
    ? parseInt(args[args.indexOf('--concurrency') + 1]) : 5;

const MAX_TEXT_CHARS = 2000;
const MAX_RETRIES = 3;
const SAVE_EVERY = 25;
const DEPLOYMENT = 'gpt-5-nano';

const SYSTEM_PROMPT = `Eres un experto en legislación laboral y de Seguridad Social española.
Responde SIEMPRE con JSON válido, sin texto adicional ni bloques de código markdown.`;

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

function buildPrompt(chunk) {
    const text = chunk.text.slice(0, MAX_TEXT_CHARS);
    return `Analiza este fragmento de legislación y devuelve un JSON con:
1. "resumen": Resumen de 1-2 frases en español llano explicando qué regula.
2. "palabras_clave": Lista de 5-8 conceptos clave para búsqueda semántica.
3. "preguntas": Lista de 3-4 preguntas que este artículo respondería, formuladas como las haría un ciudadano o profesional de RRHH.

LEY: ${chunk.law}
CAPÍTULO: ${chunk.chapter || ''}
SECCIÓN: ${chunk.section}

TEXTO:
${text}

Responde SOLO con JSON válido.`;
}

function parseResponse(content) {
    if (!content) return null;
    let clean = content.trim();
    // Strip markdown code fences
    if (clean.startsWith('```')) {
        clean = clean.split('\n', 1).length > 1
            ? clean.slice(clean.indexOf('\n') + 1) : clean.slice(3);
        if (clean.includes('```')) {
            clean = clean.slice(0, clean.lastIndexOf('```'));
        }
    }
    try {
        return JSON.parse(clean);
    } catch {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch { /* ignore */ }
        }
    }
    return null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichOne(chunk, idx, endpoint, apiKey) {
    // Skip very short chunks
    if (chunk.text.length < 60) {
        return { resumen: 'Artículo derogado o sin contenido sustantivo.', palabras_clave: [], preguntas: [] };
    }

    const url = `https://${endpoint}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=2024-12-01-preview`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: buildPrompt(chunk) },
                    ],
                    max_completion_tokens: 4096,
                }),
            });

            if (resp.status === 429) {
                const wait = 15 * (attempt + 1);
                console.log(`  [${idx}] Rate limited (429), waiting ${wait}s...`);
                await sleep(wait * 1000);
                continue;
            }

            if (!resp.ok) {
                const err = await resp.text();
                throw new Error(`API ${resp.status}: ${err.slice(0, 200)}`);
            }

            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content;
            const parsed = parseResponse(content);

            if (parsed && parsed.resumen) {
                return parsed;
            }
            console.log(`  [${idx}] Parse failed (attempt ${attempt + 1}), retrying...`);
            await sleep(2000);
        } catch (err) {
            console.error(`  [${idx}] Error (attempt ${attempt + 1}): ${err.message}`);
            if (err.message.includes('429')) {
                await sleep(30000);
            } else {
                await sleep(3000);
            }
        }
    }

    console.warn(`  [${idx}] FAILED after ${MAX_RETRIES} attempts — using fallback`);
    return {
        resumen: `[Pendiente] ${chunk.section}`,
        palabras_clave: [],
        preguntas: [],
    };
}

async function main() {
    loadEnv();

    const endpoint = process.env.AZURE_OPENAI_READER_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_READER_KEY;

    if (!endpoint || !apiKey) {
        console.error('ERROR: AZURE_OPENAI_READER_ENDPOINT y AZURE_OPENAI_READER_KEY requeridos en .env');
        process.exit(1);
    }

    console.log('=== Enrich Pending Chunks (v3) ===\n');

    // 1. Cargar chunks y pendientes
    const chunks = JSON.parse(fs.readFileSync(V3_ENRICHED_PATH, 'utf-8'));
    const pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'));
    const pendingIndices = pending.pending_indices;

    // Filter to only truly pending (null resumen)
    const toEnrich = pendingIndices.filter(i => chunks[i] && chunks[i].resumen === null);

    console.log(`  Total chunks: ${chunks.length}`);
    console.log(`  Pendientes registrados: ${pendingIndices.length}`);
    console.log(`  Pendientes reales (resumen null): ${toEnrich.length}`);
    console.log(`  Concurrencia: ${concurrencyArg}`);
    console.log(`  Deployment: ${DEPLOYMENT}`);
    console.log(`  Endpoint: ${endpoint}\n`);

    if (dryRun) {
        console.log('[DRY-RUN] Mostrando primeros 5 pendientes:');
        for (const idx of toEnrich.slice(0, 5)) {
            const c = chunks[idx];
            console.log(`  [${idx}] ${c.section?.slice(0, 60)} (${c.text?.length || 0} chars)`);
        }
        return;
    }

    if (toEnrich.length === 0) {
        console.log('¡No hay chunks pendientes! Todo enriquecido.');
        return;
    }

    // 2. Enriquecer con concurrencia limitada
    const startTime = Date.now();
    let done = 0;
    let errors = 0;

    // Process in concurrent batches
    for (let i = 0; i < toEnrich.length; i += concurrencyArg) {
        const batch = toEnrich.slice(i, i + concurrencyArg);
        const promises = batch.map(idx =>
            enrichOne(chunks[idx], idx, endpoint, apiKey).then(result => {
                chunks[idx].resumen = result.resumen;
                chunks[idx].palabras_clave = result.palabras_clave;
                chunks[idx].preguntas = result.preguntas;
                done++;
            }).catch(err => {
                console.error(`  [${idx}] Unhandled: ${err.message}`);
                errors++;
                done++;
            })
        );

        await Promise.all(promises);

        // Progress
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (done / elapsed * 1).toFixed(1);
        const eta = ((toEnrich.length - done) / (rate || 1)).toFixed(0);
        console.log(`  [${done}/${toEnrich.length}] ${elapsed}s elapsed, ~${rate}/s, ETA ~${eta}s`);

        // Save progress periodically
        if (done % SAVE_EVERY === 0 || done === toEnrich.length) {
            fs.writeFileSync(V3_ENRICHED_PATH, JSON.stringify(chunks, null, 2), 'utf-8');
        }

        // Small delay between batches for rate limiting
        await sleep(1000);
    }

    // 3. Final save
    fs.writeFileSync(V3_ENRICHED_PATH, JSON.stringify(chunks, null, 2), 'utf-8');

    // Update pending file
    const stillPending = toEnrich.filter(i => chunks[i].resumen === null || chunks[i].resumen?.startsWith('[Pendiente]'));
    fs.writeFileSync(PENDING_PATH, JSON.stringify({
        pending_indices: stillPending,
        total_v3: chunks.length,
        matched: chunks.length - stillPending.length,
        needs_enrichment: stillPending.length,
        timestamp: new Date().toISOString(),
    }, null, 2), 'utf-8');

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Enrichment completado ===`);
    console.log(`  Enriquecidos: ${done - errors}`);
    console.log(`  Errores: ${errors}`);
    console.log(`  Pendientes restantes: ${stillPending.length}`);
    console.log(`  Tiempo: ${totalTime}s`);
    console.log(`  Guardado: ${V3_ENRICHED_PATH}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
