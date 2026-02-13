/**
 * Descarga sentencias del TS Sala Social desde vLex.
 *
 * Usa la API JSON de vLex (/search.json) con las cookies del navegador.
 * Descarga metadatos + PDFs (vía api.vlex.com/pdf/{id}).
 *
 * Uso:
 *   node download_vlex.js                    # Descarga todo (676 sentencias)
 *   node download_vlex.js --skip-pdf         # Solo metadatos
 *   node download_vlex.js --max-pages 3      # Solo 3 páginas (30 sentencias)
 *   node download_vlex.js --dry-run          # Simular sin descargar
 *   node download_vlex.js --retry-failed     # Reintentar PDFs fallidos
 *
 * IMPORTANTE: Requiere cookies de sesión vLex válidas.
 * Para actualizar cookies: F12 → Network → copiar Cookie header.
 *
 * No requiere dependencias externas (fetch nativo Node 18+).
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// Configuración
// =============================================================================

const SEARCH_URL = 'https://app.vlex.com/search.json';
const DOC_URL = (id) => `https://app.vlex.com/vid/${id}/download`;

// Filtros de búsqueda (ya configurados en vLex)
const SEARCH_PARAMS = {
    q: 'Tribunal Supremo, sala cuarta, (Social) STS',
    jurisdiction: 'ES',
    content_type: '2',
    categorias: '04',
    source: '102',
    'date': '2016-04-01..',
    tipo_recurso2: '05',
    sentido_fallo: '06,07',
    aplica_ley: 'CITA_LEY_655797601',
    sort: 'by_date',
};

const PER_PAGE = 10; // vLex devuelve 10 resultados por página

// Delays conservadores (ms) - imitar comportamiento humano
const DELAY_PAGE = { min: 4000, max: 8000 };     // entre páginas de búsqueda
const DELAY_PDF  = { min: 3000, max: 6000 };      // entre descargas de PDF
const DELAY_BATCH = { min: 15000, max: 30000 };    // cada 20 PDFs, pausa larga
const PDF_BATCH_SIZE = 20;

const MAX_RETRIES = 2;

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'data', 'sentencias_vlex');
const PDF_DIR = path.join(OUT_DIR, 'pdf');
const META_FILE = path.join(OUT_DIR, 'sentencias_vlex_metadata.json');
const PROGRESS_FILE = path.join(OUT_DIR, 'vlex_progress.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// Cookies de sesión — ACTUALIZAR cuando caduquen
const COOKIES = 'keymachine=F9FFJ6F06QCT; LT=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3NzA5NzA2MDMsImxvZ2luX21ldGhvZCI6InB3ZF9hZG1pbiIsInZsZXhfdXNlcl9pZCI6MTE2MzAxNzYwMCwiaXNfYWNjb3VudF9tYW5hZ2VyIjp0cnVlLCJhY3RpdmVfcHJvZHVjdHMiOlsiQkFTSUNfRVMiXSwic2l0ZV9kb21haW4iOiJhcHAudmxleC5jb20iLCJ1c2VyX3JvbGVzIjpbXSwiZW1haWwiOiJnYWdvZG95NzA0QGhvbXVuby5jb20iLCJpbmhlcml0ZWRfYWNjb3VudHMiOlsxMTYzMDE3NjAwXX0.LZJDh7UgaPHaN5WrRdNTWecwGb2DB9EThSlIOqyt4DU; vlex-session=BAh7GEkiD3Nlc3Npb25faWQGOgZFVEkiJTczMzMzMTlhYjdhYTMyY2QxZTcxMGQ5MTFjMjFiNTU0BjsAVEkiE3NraXBfYXV0b2xvZ2luBjsAVEZJIhRtb2JpbGVfdmVyc2lvbj8GOwBURkkiDHBhaXNfaWQGOwBUSSIHRVMGOwBUSSIOaWRpb21hX2lkBjsAVEkiB0VTBjsAVEkiD3V0bV9tZWRpdW0GOwBUSSISc2VsZi1yZWZlcnJhbAY7AFRJIg91dG1fc291cmNlBjsAVEkiDHZsZXguZXMGOwBUSSIRbGFuZGluZ19wYWdlBjsAVEkiK2h0dHBzOi8vbG9naW4udmxleC5jb20vP2ZvcmNlX2xvZ291dD0xBjsAVEkiFW9yaWdpbmFsX3JlZmVyZXIGOwBUSSIVaHR0cHM6Ly92bGV4LmVzLwY7AFRJIhB1cmxfcmVmZXJlcgY7AFRJIhVodHRwczovL3ZsZXguZXMvBjsAVEkiE3dlYmFwcF9yZWZlcmVyBjsAVEkiAAY7AFRJIgx1c3VhcmlvBjsAVGwrB4A9UkVJIgxkb21pbmlvBjsAVEkiDXZsZXguY29tBjsAVEkiCmxvZ2luBjsAVEkiDnB3ZF9hZG1pbgY7AFRJIiFkYXlzX3NpbmNlX3ByZXZpb3VzX2FjdGl2aXR5BjsAVGkASSIHaWQGOwBUaQR1l4gaSSIRc2Vzc2lvbl90eXBlBjsAVEkiDnB3ZF9hZG1pbgY7AFRJIhJ3ZWJhcHBfbG9jYWxlBjsAVEkiB2VzBjsAVEkiEF9jc3JmX3Rva2VuBjsAVEkiMTFYWmxVNGZjSU9ObHJ2ZlJOdmV0YWhadUJGMUtRVmRWeHloRzNOcEgzWEU9BjsAVA%3D%3D--70257c74a625cb7b83e249950efe1c0dd91af4e5; idioma_id=EN';

// =============================================================================
// CLI
// =============================================================================

function parseArgs() {
    const a = {
        skipPdf: false,
        maxPages: null,    // null = todas
        dryRun: false,
        retryFailed: false,
        speed: 1,          // factor velocidad (>1 = más rápido, <1 = más lento)
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--skip-pdf': a.skipPdf = true; break;
            case '--max-pages': a.maxPages = +argv[++i]; break;
            case '--dry-run': a.dryRun = true; break;
            case '--retry-failed': a.retryFailed = true; break;
            case '--speed': a.speed = +argv[++i]; break;
            case '--help': case '-h':
                console.log(`
  Descarga sentencias TS Sala Social desde vLex (API JSON)

  --skip-pdf           Solo metadatos, no descargar PDFs
  --max-pages <N>      Limitar páginas de búsqueda (10 resultados/pag)
  --dry-run            Simular sin contactar vLex
  --retry-failed       Reintentar PDFs que fallaron antes
  --speed <N>          Factor velocidad (default: 1)
  --help, -h           Ayuda
`);
                process.exit(0);
        }
    }
    return a;
}

// =============================================================================
// Utilidades
// =============================================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));
function randDelay(range, factor = 1) {
    return Math.max(500, Math.round((range.min + Math.random() * (range.max - range.min)) / factor));
}
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function loadJson(f, def) {
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
    catch { return typeof def === 'function' ? def() : def; }
}
function saveJson(f, data) { fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8'); }
function ts() { return new Date().toLocaleTimeString('es-ES', { hour12: false }); }

function sanitizeFilename(title) {
    return title
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 80);
}

// =============================================================================
// vLex API
// =============================================================================

async function searchPage(page, factor) {
    const params = new URLSearchParams({ ...SEARCH_PARAMS, page: String(page) });
    const url = `${SEARCH_URL}?${params}`;

    for (let att = 1; att <= MAX_RETRIES; att++) {
        try {
            const r = await fetch(url, {
                headers: {
                    'User-Agent': UA,
                    'Cookie': COOKIES,
                    'Accept': 'application/json',
                    'Referer': 'https://app.vlex.com/search/',
                },
                signal: AbortSignal.timeout(30000),
            });

            if (r.status === 401 || r.status === 403) {
                console.log(`\n  [!!!] ${r.status} - Sesión expirada o bloqueada.`);
                console.log('  Actualiza las cookies en el script.');
                return { status: 'auth_error' };
            }
            if (r.status === 429) {
                console.log('\n  [!] 429 Rate limited. Esperando 60s...');
                await sleep(60000);
                continue;
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);

            const data = await r.json();
            return { status: 'ok', data };

        } catch (e) {
            console.log(`  [!] Intento ${att}: ${e.message}`);
            if (att < MAX_RETRIES) await sleep(5000 * att);
        }
    }
    return { status: 'error' };
}

async function downloadPdf(docId, filename, factor) {
    const pdfPath = path.join(PDF_DIR, filename);

    // Ya existe?
    try { if (fs.statSync(pdfPath).size > 1024) return 'exists'; } catch {}

    for (let att = 1; att <= MAX_RETRIES; att++) {
        try {
            // Step 1: Get redirect URL
            const r1 = await fetch(DOC_URL(docId), {
                headers: { 'User-Agent': UA, 'Cookie': COOKIES },
                redirect: 'manual',
                signal: AbortSignal.timeout(15000),
            });

            const pdfUrl = r1.headers.get('location');
            if (!pdfUrl) {
                // Puede que devuelva el PDF directamente o un error
                if (r1.status === 401 || r1.status === 403) return 'auth_error';
                if (r1.status === 429) {
                    await sleep(60000);
                    continue;
                }
                throw new Error(`No redirect, status ${r1.status}`);
            }

            // Step 2: Download from API
            const r2 = await fetch(pdfUrl, {
                headers: {
                    'User-Agent': UA,
                    'Cookie': COOKIES,
                    'Accept': '*/*',
                    'Referer': 'https://app.vlex.com/',
                },
                signal: AbortSignal.timeout(60000),
            });

            if (r2.status === 401 || r2.status === 403) return 'auth_error';
            if (r2.status === 429) {
                await sleep(60000);
                continue;
            }
            if (!r2.ok) throw new Error(`PDF HTTP ${r2.status}`);

            const ct = r2.headers.get('content-type') || '';
            if (ct.includes('html')) return 'not_pdf';

            const buf = Buffer.from(await r2.arrayBuffer());
            if (buf.length < 512) return 'too_small';

            fs.writeFileSync(pdfPath, buf);
            return 'ok';

        } catch (e) {
            if (att < MAX_RETRIES) await sleep(3000 * att);
        }
    }
    return 'fail';
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    const args = parseArgs();
    const factor = args.speed;

    ensureDir(OUT_DIR);
    ensureDir(PDF_DIR);

    // Progreso
    let progress = loadJson(PROGRESS_FILE, () => ({
        pages_scraped: [],
        pdfs_downloaded: [],
        pdfs_failed: [],
    }));

    if (args.retryFailed) {
        console.log(`Reintentando ${progress.pdfs_failed.length} PDFs fallidos...`);
        progress.pdfs_failed = [];
        saveJson(PROGRESS_FILE, progress);
    }

    let allSentencias = loadJson(META_FILE, []);
    const knownIds = new Set(allSentencias.map(s => s.id));

    // Banner
    console.log('='.repeat(70));
    console.log('  DESCARGA SENTENCIAS TS SALA SOCIAL - vLex');
    console.log('='.repeat(70));
    console.log(`  Filtros:     RCUD + Unifica doctrina + Cita LGSS`);
    console.log(`  Delays:      ${DELAY_PAGE.min/1000}-${DELAY_PAGE.max/1000}s busq, ${DELAY_PDF.min/1000}-${DELAY_PDF.max/1000}s PDF`);
    console.log(`  Speed:       x${factor}`);
    console.log(`  Previas:     ${allSentencias.length} sentencias`);
    if (args.skipPdf) console.log('  PDFs:        SKIP');
    if (args.maxPages) console.log(`  Max pages:   ${args.maxPages}`);
    if (args.dryRun) console.log('  *** DRY RUN ***');
    console.log('='.repeat(70));
    console.log();

    if (args.dryRun) {
        // Fetch page 1 to show count
        const probe = await searchPage(1, factor);
        if (probe.status === 'ok') {
            const total = probe.data.count;
            const pages = Math.ceil(total / PER_PAGE);
            console.log(`  Total: ${total} sentencias en ${pages} páginas`);
            console.log(`  Tiempo estimado metadatos: ~${Math.round(pages * 6 / 60)} min`);
            console.log(`  Tiempo estimado PDFs: ~${Math.round(total * 5 / 60)} min`);
        }
        return;
    }

    // =========================================================================
    // FASE 1: Metadatos (búsqueda paginada)
    // =========================================================================
    console.log(`[${ts()}] FASE 1: Extracción de metadatos`);
    console.log('-'.repeat(50));

    // Obtener total
    const firstPage = await searchPage(1, factor);
    if (firstPage.status !== 'ok') {
        console.log('[FATAL] No se pudo conectar a vLex. Verifica cookies.');
        return;
    }

    const totalResults = firstPage.data.count;
    const totalPages = args.maxPages
        ? Math.min(args.maxPages, Math.ceil(totalResults / PER_PAGE))
        : Math.ceil(totalResults / PER_PAGE);

    console.log(`  Total: ${totalResults} sentencias, ${totalPages} páginas`);

    // Procesar primera página
    let totalNew = 0;
    function processResults(results) {
        let added = 0;
        for (const r of results) {
            if (knownIds.has(r.id)) continue;
            knownIds.add(r.id);

            const sentencia = {
                id: r.id,
                title: r.title,
                date: r.document_date,
                abstract: r.abstract || '',
                snippet: (r.snippet || '').replace(/<[^>]+>/g, ''),
                country: r.country?.id || 'ES',
                has_case_history: r.has_case_history || false,
                case_history_status: r.case_history?.status || null,
                case_history_text: r.case_history?.active?.[0]?.text || null,
                url_vlex: `https://app.vlex.com/vid/${r.id}`,
                pdf_filename: sanitizeFilename(r.title) + '.pdf',
            };
            allSentencias.push(sentencia);
            added++;
        }
        return added;
    }

    const added1 = processResults(firstPage.data.results);
    totalNew += added1;
    progress.pages_scraped.push(1);
    console.log(`  Pag 1/${totalPages}: ${firstPage.data.results.length} resultados, ${added1} nuevas`);

    // Resto de páginas
    for (let page = 2; page <= totalPages; page++) {
        // Skip already scraped
        if (progress.pages_scraped.includes(page)) {
            process.stdout.write(`  Pag ${page}/${totalPages}: ya procesada\r`);
            continue;
        }

        await sleep(randDelay(DELAY_PAGE, factor));

        const result = await searchPage(page, factor);
        if (result.status === 'auth_error') {
            console.log('\n  [!!!] Sesión expirada. Guardando progreso...');
            break;
        }
        if (result.status !== 'ok') {
            console.log(`\n  [!] Error en página ${page}, continuando...`);
            continue;
        }

        const added = processResults(result.data.results);
        totalNew += added;
        progress.pages_scraped.push(page);

        console.log(`  Pag ${page}/${totalPages}: ${result.data.results.length} resultados, ${added} nuevas`);

        // Guardar cada 5 páginas
        if (page % 5 === 0) {
            saveJson(META_FILE, allSentencias);
            saveJson(PROGRESS_FILE, progress);
        }
    }

    // Guardar final
    saveJson(META_FILE, allSentencias);
    saveJson(PROGRESS_FILE, progress);

    console.log(`\n  Metadatos: ${allSentencias.length} total (${totalNew} nuevas)`);

    // Distribución por año
    const dist = {};
    for (const s of allSentencias) {
        const y = s.date ? s.date.split('/')[0] : '?';
        dist[y] = (dist[y] || 0) + 1;
    }
    console.log('\n  Distribución por año:');
    for (const y of Object.keys(dist).sort()) console.log(`    ${y}: ${dist[y]}`);

    if (args.skipPdf) {
        console.log(`\n[OK] Metadatos en: ${META_FILE}`);
        return;
    }

    // =========================================================================
    // FASE 2: Descarga de PDFs
    // =========================================================================
    console.log(`\n[${ts()}] FASE 2: Descarga de PDFs`);
    console.log('-'.repeat(50));

    const dlSet = new Set(progress.pdfs_downloaded);
    const failSet = new Set(progress.pdfs_failed);

    // Pre-check disco
    let preExisting = 0;
    for (const s of allSentencias) {
        if (dlSet.has(s.id) || failSet.has(s.id)) continue;
        try {
            if (fs.statSync(path.join(PDF_DIR, s.pdf_filename)).size > 1024) {
                dlSet.add(s.id);
                progress.pdfs_downloaded.push(s.id);
                preExisting++;
            }
        } catch {}
    }
    if (preExisting > 0) {
        console.log(`  Pre-check: ${preExisting} PDFs ya en disco`);
        saveJson(PROGRESS_FILE, progress);
    }

    const toDl = allSentencias.filter(s => !dlSet.has(s.id) && !failSet.has(s.id));
    console.log(`  Ya descargados: ${dlSet.size}, Pendientes: ${toDl.length}`);
    console.log();

    let ok = dlSet.size, fail = 0;
    let authError = false;

    for (let i = 0; i < toDl.length; i++) {
        const s = toDl[i];
        process.stdout.write(`  [${i+1}/${toDl.length}] ${s.title} ... `);

        const result = await downloadPdf(s.id, s.pdf_filename, factor);

        switch (result) {
            case 'ok': {
                const sz = Math.round(fs.statSync(path.join(PDF_DIR, s.pdf_filename)).size / 1024);
                console.log(`OK (${sz} KB)`);
                progress.pdfs_downloaded.push(s.id);
                ok++;
                break;
            }
            case 'exists':
                console.log('ya existe');
                progress.pdfs_downloaded.push(s.id);
                ok++;
                break;
            case 'auth_error':
                console.log('SESION EXPIRADA');
                authError = true;
                break;
            case 'not_pdf':
                console.log('no es PDF (paywall?)');
                progress.pdfs_failed.push(s.id);
                fail++;
                break;
            default:
                console.log('FALLO');
                progress.pdfs_failed.push(s.id);
                fail++;
        }

        saveJson(PROGRESS_FILE, progress);

        if (authError) {
            console.log('\n  [!!!] Sesión expirada. Actualiza cookies y re-ejecuta.');
            break;
        }

        // Pausa entre PDFs
        await sleep(randDelay(DELAY_PDF, factor));

        // Pausa larga cada N PDFs
        if ((i + 1) % PDF_BATCH_SIZE === 0 && i + 1 < toDl.length) {
            const batchDelay = randDelay(DELAY_BATCH, factor);
            console.log(`  --- Pausa ${Math.round(batchDelay/1000)}s (descargados ${i+1}) ---`);
            await sleep(batchDelay);
        }
    }

    // =========================================================================
    // Resumen
    // =========================================================================
    console.log('\n' + '='.repeat(70));
    console.log(`  RESUMEN (${ts()})`);
    console.log('='.repeat(70));
    console.log(`  Sentencias:        ${allSentencias.length}`);
    console.log(`  Nuevas:            ${totalNew}`);
    console.log(`  PDFs OK:           ${ok}`);
    console.log(`  PDFs fallidos:     ${fail}`);
    console.log(`  Metadatos:         ${META_FILE}`);
    console.log(`  PDFs:              ${PDF_DIR}`);

    if (authError) {
        console.log('\n  Sesión expirada. Actualiza COOKIES en el script y vuelve a ejecutar.');
    } else if (fail > 0) {
        console.log('\n  Para reintentar fallidos: node download_vlex.js --retry-failed');
    }
    console.log();
}

main().catch(e => {
    console.error('[FATAL]', e);
    process.exit(1);
});
