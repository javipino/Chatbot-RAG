/**
 * enrich_criterios.js — Enriquece criterios INSS con GPT-5 Nano (palabras_clave) + regex (normativa_refs).
 *
 * Input:  data/chunks/criterios_raw.json
 * Output: data/chunks/criterios_enriched.json
 *
 * Añade:
 *   - palabras_clave: string[]
 *   - normativa_refs: string[]
 *
 * Uso:
 *   node src/scripts/enrich_criterios.js --limit 50 --concurrency 5
 *   node src/scripts/enrich_criterios.js --concurrency 5
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const IN_PATH = path.join(ROOT, 'data', 'chunks', 'criterios_raw.json');
const OUT_PATH = path.join(ROOT, 'data', 'chunks', 'criterios_enriched.json');
const PROGRESS_PATH = path.join(ROOT, 'data', 'chunks', 'criterios_enrichment_progress.json');
const ENV_PATH = path.join(ROOT, '.env');

const args = process.argv.slice(2);
const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 0;
const concurrencyArg = args.includes('--concurrency') ? parseInt(args[args.indexOf('--concurrency') + 1], 10) : 5;
const dryRun = args.includes('--dry-run');

const MAX_EXCERPT_CHARS = 3000;
const MAX_RETRIES = 3;
const SAVE_EVERY = 25;
const DEPLOYMENT = 'gpt-5-nano';
const API_VERSION = '2024-12-01-preview';

const SYSTEM_PROMPT = 'Eres un experto en Seguridad Social española y gestión de prestaciones del INSS. Responde SIEMPRE con JSON válido, sin texto adicional ni markdown.';

// Keywords que no aportan información (aparecen en casi todos los criterios)
const NOISE_KEYWORDS = new Set([
    'criterio de gestión',
    'criterios de gestión',
    'instituto nacional de la seguridad social',
    'inss',
    'seguridad social',
    'dirección general de ordenación',
    'dgoss',
    'informe dgoss',
    'criterio interpretativo',
    'texto refundido',
    'trlgss',
    'ley general de la seguridad social',
]);

// Arts procedimentales que son boilerplate
const PROCEDURAL_REFS = new Set([
    'art. 219 LRJS', 'art. 219.1 LRJS', 'art. 219.2 LRJS', 'art. 219.3 LRJS',
    'art. 220 LRJS', 'art. 221 LRJS', 'art. 222 LRJS', 'art. 223 LRJS',
    'art. 224 LRJS', 'art. 225 LRJS', 'art. 226 LRJS', 'art. 226.2 LRJS',
    'art. 227 LRJS', 'art. 228 LRJS', 'art. 235 LRJS',
]);

function loadEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        console.error(`ERROR: .env no encontrado en ${ENV_PATH}`);
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
 * Build excerpt for Nano. Criterios are typically short (3-8K chars),
 * so we can often send most of the text. Skip the INFORME DGOSS section
 * and focus on the main criterio body.
 */
function buildExcerpt(item, maxChars) {
    let text = item.text || '';

    // If merged with informe, use only the main criterio part
    const informeIdx = text.indexOf('--- INFORME DGOSS ---');
    if (informeIdx > 0) {
        text = text.substring(0, informeIdx);
    }

    // Criterios are short enough to fit mostly as-is
    if (text.length <= maxChars) return text;

    // If too long, take the beginning (which has ASUNTO + CRITERIO DE GESTIÓN)
    return text.substring(0, maxChars);
}

/**
 * Extracts normativa_refs by regex from full text (same approach as sentencias).
 */
function extractRefsFromText(text) {
    const regex = /art(?:ículo|\.?)\s*(\d+[\d\.]*\s*(?:bis|ter)?)\s+(?:del?\s+)?(?:la\s+)?(?:Ley\s+)?(?:Orgánica\s+)?(ET|LGSS|LETA|LISOS|CE|LRJS|LOLS|LPRL|LET|TRLGSS|TRET|TREBEP|EBEP|Estatuto de los Trabajadores|Ley General de la Seguridad Social)/gi;
    const refs = new Set();
    let m;
    while ((m = regex.exec(text)) !== null) {
        const num = m[1].trim();
        let ley = m[2].trim();
        if (/Estatuto de los Trabajadores/i.test(ley)) ley = 'ET';
        if (/Ley General de la Seguridad Social/i.test(ley)) ley = 'LGSS';
        ley = ley.toUpperCase();
        const key = 'art. ' + num + ' ' + ley;
        if (!PROCEDURAL_REFS.has(key)) refs.add(key);
    }
    return [...refs];
}

function buildPrompt(item) {
    const excerpt = buildExcerpt(item, MAX_EXCERPT_CHARS);

    return `Analiza este criterio de gestión del INSS y devuelve un JSON con:
"palabras_clave": Lista de 5-8 conceptos clave de Seguridad Social para búsqueda semántica.
NO incluyas términos genéricos como "INSS", "Seguridad Social", "criterio de gestión", "TRLGSS".
Céntrate en: tipo de prestación, colectivo afectado, situación jurídica concreta, régimen específico.

TÍTULO: ${item.titulo || ''}
DESCRIPCIÓN: ${item.descripcion || ''}

TEXTO DEL CRITERIO:
${excerpt}

Responde SOLO con JSON válido: {"palabras_clave": [...]}`;
}

function parseResponse(content) {
    if (!content) return null;
    let clean = String(content).trim();
    if (clean.startsWith('```')) {
        const firstNewline = clean.indexOf('\n');
        if (firstNewline !== -1) clean = clean.slice(firstNewline + 1);
        const lastFence = clean.lastIndexOf('```');
        if (lastFence !== -1) clean = clean.slice(0, lastFence);
        clean = clean.trim();
    }
    try {
        const parsed = JSON.parse(clean);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        const match = clean.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            const parsed = JSON.parse(match[0]);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }
}

function sanitizeList(values, maxItems, minLen = 2) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of values) {
        if (typeof raw !== 'string') continue;
        const text = raw.replace(/\s+/g, ' ').trim();
        if (text.length < minLen) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= maxItems) break;
    }
    return out;
}

async function enrichOne(item, index, endpoint, apiKey) {
    const url = `https://${endpoint}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': apiKey,
                },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: buildPrompt(item) },
                    ],
                    max_completion_tokens: 4096,
                }),
            });

            if (response.status === 429) {
                const wait = 15000 * (attempt + 1);
                console.log(`  [${index}] 429, esperando ${Math.round(wait / 1000)}s`);
                await sleep(wait);
                continue;
            }

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`API ${response.status}: ${text.slice(0, 200)}`);
            }

            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content;
            const parsed = parseResponse(content);

            if (!parsed) {
                await sleep(1500);
                continue;
            }

            const keywords = sanitizeList(parsed.palabras_clave, 12, 2)
                .filter(kw => !NOISE_KEYWORDS.has(kw.toLowerCase()));
            return { palabras_clave: keywords };
        } catch (error) {
            const message = String(error.message || error);
            console.log(`  [${index}] intento ${attempt + 1} falló: ${message.slice(0, 120)}`);
            await sleep(message.includes('429') ? 30000 : 3000);
        }
    }

    return { palabras_clave: [] };
}

async function runWithConcurrency(tasks, concurrency) {
    const results = new Array(tasks.length);
    let cursor = 0;

    async function worker() {
        while (true) {
            const current = cursor;
            cursor++;
            if (current >= tasks.length) return;
            results[current] = await tasks[current]();
        }
    }

    const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
    await Promise.all(workers);
    return results;
}

async function main() {
    loadEnv();

    const endpoint = process.env.AZURE_OPENAI_READER_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_READER_KEY;

    if (!endpoint || !apiKey) {
        console.error('ERROR: faltan AZURE_OPENAI_READER_ENDPOINT / AZURE_OPENAI_READER_KEY');
        process.exit(1);
    }

    if (!fs.existsSync(IN_PATH)) {
        console.error(`Input no encontrado: ${IN_PATH}`);
        process.exit(1);
    }

    let items = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8'));
    if (limitArg > 0) items = items.slice(0, limitArg);

    const progress = fs.existsSync(PROGRESS_PATH)
        ? JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'))
        : {};

    const pending = [];
    for (let i = 0; i < items.length; i++) {
        if (!progress[String(i)]) pending.push(i);
    }

    console.log('=== Enrich Criterios INSS ===\n');
    console.log(`Items: ${items.length}`);
    console.log(`Pendientes: ${pending.length}`);
    console.log(`Concurrencia: ${concurrencyArg}`);
    console.log(`Dry-run: ${dryRun}\n`);

    if (dryRun) {
        console.log('Primeros pendientes:', pending.slice(0, 10));
        return;
    }

    const started = Date.now();
    let processedInRun = 0;

    for (let batchStart = 0; batchStart < pending.length; batchStart += SAVE_EVERY) {
        const batch = pending.slice(batchStart, batchStart + SAVE_EVERY);

        const tasks = batch.map(index => async () => {
            const result = await enrichOne(items[index], index, endpoint, apiKey);
            return { index, result };
        });

        const results = await runWithConcurrency(tasks, concurrencyArg);

        for (const item of results) {
            progress[String(item.index)] = item.result;
            processedInRun++;
        }

        fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');

        const done = Object.keys(progress).length;
        const elapsedMin = (Date.now() - started) / 60000;
        const rate = elapsedMin > 0 ? done / elapsedMin : 0;
        const remain = items.length - done;
        const eta = rate > 0 ? Math.round(remain / rate) : 0;

        console.log(`[${done}/${items.length}] guardado progreso | ${rate.toFixed(1)}/min | ETA ${eta} min`);
    }

    // Merge: only add Nano keywords. normativa_refs already in criterios_raw.json (postprocess v3)
    for (let i = 0; i < items.length; i++) {
        const enriched = progress[String(i)] || { palabras_clave: [] };
        items[i].palabras_clave = enriched.palabras_clave || [];
        // normativa_refs: keep existing from postprocess_criterios.js (8 patterns, 4130 refs)
    }

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(items, null, 2), 'utf-8');

    const elapsed = ((Date.now() - started) / 60000).toFixed(1);
    const sizeMb = (fs.statSync(OUT_PATH).size / (1024 * 1024)).toFixed(1);

    console.log('\n=== Enriquecimiento completado ===');
    console.log(`Salida: ${OUT_PATH}`);
    console.log(`Procesados en esta ejecución: ${processedInRun}`);
    console.log(`Tiempo: ${elapsed} min`);
    console.log(`Tamaño: ${sizeMb} MB`);
}

main().catch(error => {
    console.error('Error fatal:', error);
    process.exit(1);
});
