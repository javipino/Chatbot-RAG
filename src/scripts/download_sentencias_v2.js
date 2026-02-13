/**
 * Descarga COMPLETA de sentencias del TS (Sala Social) desde CENDOJ.
 *
 * Estrategia: filtra MES A MES para no superar el límite de 200 resultados
 * por consulta (el año con más sentencias tiene ~800 → ~67/mes).
 *
 * Modo "stealth" para evitar bloqueo de IP:
 *   - Delays aleatorios (3-7s entre peticiones, 15-30s entre meses)
 *   - Renueva sesión periódicamente
 *   - Abort inmediato si recibe 403 (no insiste)
 *   - Ritmo: ~10-12 peticiones/minuto (un humano rápido)
 *
 * Uso:
 *   node download_sentencias_v2.js                      # Descarga todo
 *   node download_sentencias_v2.js --years 2024,2025    # Solo esos años
 *   node download_sentencias_v2.js --skip-pdf           # Solo metadatos
 *   node download_sentencias_v2.js --year-from 2020     # Desde 2020
 *   node download_sentencias_v2.js --year-to 2023       # Hasta 2023
 *   node download_sentencias_v2.js --no-resume          # Borrar progreso previo
 *   node download_sentencias_v2.js --dry-run            # Simular sin pedir a CENDOJ
 *
 * No requiere dependencias externas (fetch nativo Node 18+).
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// Configuración
// =============================================================================

const BASE_URL = 'https://www.poderjudicial.es';
const SEARCH_URL = BASE_URL + '/search/search.action';
const SESSION_URL = BASE_URL + '/search/indexAN.jsp';
const PDF_URL_TPL = BASE_URL + '/search/contenidos.action?action=accessToPDF&publicinterface=true&tab=AN&reference={ref}&optimize={opt}&links={q}&databasematch=TS';

const QUERY_DEFAULT = 'sistema de la seguridad social';
const PER_PAGE = 50;          // máx soportado por API
const MAX_RETRIEVABLE = 200;  // límite duro CENDOJ
const MAX_PAGES = Math.ceil(MAX_RETRIEVABLE / PER_PAGE); // 4
const MAX_RETRIES = 2;        // pocos reintentos para no insistir

// Delays "stealth" (ms)
const DELAY_PAGE  = { min: 3000, max: 7000 };   // entre páginas
const DELAY_MONTH = { min: 12000, max: 25000 };  // entre meses
const DELAY_YEAR  = { min: 20000, max: 40000 };  // entre años
const DELAY_PDF   = { min: 1500, max: 3500 };    // entre PDFs
const DELAY_SESSION = { min: 2000, max: 4000 };  // antes de renovar sesión
const REQUESTS_PER_SESSION = 40; // renovar sesión cada N peticiones

const YEAR_FROM_DEFAULT = 2000;
const YEAR_TO_DEFAULT = new Date().getFullYear();

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'data', 'sentencias');
const PDF_DIR = path.join(OUT_DIR, 'pdf');
const META_FILE = path.join(OUT_DIR, 'sentencias_metadata.json');
const PROGRESS_FILE = path.join(OUT_DIR, 'download_progress_v2.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// =============================================================================
// CLI args
// =============================================================================

function parseArgs() {
    const a = {
        query: QUERY_DEFAULT,
        yearFrom: YEAR_FROM_DEFAULT,
        yearTo: YEAR_TO_DEFAULT,
        years: null,
        skipPdf: false,
        noResume: false,
        dryRun: false,
        speedFactor: 1,  // >1 = más rápido (menos delay), <1 = más lento
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--query': case '-q': a.query = argv[++i]; break;
            case '--year-from': a.yearFrom = +argv[++i]; break;
            case '--year-to': a.yearTo = +argv[++i]; break;
            case '--years': a.years = argv[++i].split(',').map(Number); break;
            case '--skip-pdf': a.skipPdf = true; break;
            case '--no-resume': a.noResume = true; break;
            case '--dry-run': a.dryRun = true; break;
            case '--speed': a.speedFactor = +argv[++i]; break;
            case '--help': case '-h':
                console.log(`
  Descarga COMPLETA de sentencias TS Sala Social - CENDOJ
  Filtra mes a mes. Modo stealth con delays aleatorios.

  --query, -q <text>     Búsqueda (default: "${QUERY_DEFAULT}")
  --year-from <N>        Año inicio (default: ${YEAR_FROM_DEFAULT})
  --year-to <N>          Año fin (default: ${YEAR_TO_DEFAULT})
  --years <N,N,...>      Años concretos (ej: 2024,2025)
  --skip-pdf             Solo metadatos
  --no-resume            Empezar de cero
  --speed <N>            Factor velocidad (0.5=lento, 2=rápido)
  --dry-run              No contactar CENDOJ, simular
  --help, -h             Ayuda
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
    const d = range.min + Math.random() * (range.max - range.min);
    return Math.max(500, Math.round(d / factor));
}

function sanitize(roj) {
    return roj.replace(/[^\w]/g, '_').replace(/^_+|_+$/g, '');
}

function ensureDir(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadJson(f, def) {
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
    catch { return typeof def === 'function' ? def() : def; }
}

function saveJson(f, data) {
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf-8');
}

// Último día de un mes
function lastDay(year, month) {
    return new Date(year, month, 0).getDate(); // month es 1-based aquí
}

// Generar periodos mensuales para un año
function monthlyPeriods(year) {
    const periods = [];
    const now = new Date();
    for (let m = 1; m <= 12; m++) {
        // No generar meses futuros
        if (year === now.getFullYear() && m > now.getMonth() + 1) break;
        const mm = String(m).padStart(2, '0');
        const dd = String(lastDay(year, m)).padStart(2, '0');
        periods.push({
            key: `${year}-${mm}`,
            year,
            month: m,
            from: `01/${mm}/${year}`,
            to: `${dd}/${mm}/${year}`,
            label: `${mm}/${year}`,
        });
    }
    return periods;
}

// Timestamp legible
function ts() {
    return new Date().toLocaleTimeString('es-ES', { hour12: false });
}

// =============================================================================
// Sesión
// =============================================================================

let sessionCookie = null;
let requestCount = 0;

async function renewSession() {
    try {
        const resp = await fetch(SESSION_URL, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
            redirect: 'manual',
        });
        const cookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
        const jid = cookies.find(c => c.startsWith('JSESSIONID='));
        if (jid) {
            sessionCookie = jid.split(';')[0];
            requestCount = 0;
            return true;
        }
    } catch (e) {
        console.log(`  [!] Error renovando sesión: ${e.message}`);
    }
    return false;
}

async function ensureSession(factor) {
    if (!sessionCookie || requestCount >= REQUESTS_PER_SESSION) {
        await sleep(randDelay(DELAY_SESSION, factor));
        await renewSession();
    }
}

// =============================================================================
// Búsqueda POST
// =============================================================================

async function searchPost(query, year, dateFrom, dateTo, start, factor) {
    await ensureSession(factor);

    const body = new URLSearchParams({
        action: 'query',
        sort: 'IN_FECHARESOLUCION:decreasing',
        recordsPerPage: String(PER_PAGE),
        databasematch: 'TS',
        start: String(start),
        ANYO: String(year),
        landing: query,
        FECHARESOLUCIONDESDE: dateFrom,
        FECHARESOLUCIONHASTA: dateTo,
    }).toString();

    const headers = {
        'User-Agent': UA,
        'Accept': 'text/html, */*; q=0.01',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${BASE_URL}/search/sentencias/${encodeURIComponent(query)}/1/PUB`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
    };
    if (sessionCookie) headers['Cookie'] = sessionCookie;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            requestCount++;
            const resp = await fetch(SEARCH_URL, {
                method: 'POST', headers, body,
                signal: AbortSignal.timeout(30000),
            });

            // Actualizar cookie
            const nc = (resp.headers.getSetCookie ? resp.headers.getSetCookie() : [])
                .find(c => c.startsWith('JSESSIONID='));
            if (nc) sessionCookie = nc.split(';')[0];

            if (resp.status === 403) {
                console.log(`\n  [!!!] 403 FORBIDDEN - IP bloqueada. Abortando.`);
                return { status: 'blocked' };
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            return { status: 'ok', html: await resp.text() };

        } catch (e) {
            if (e.message?.includes('403') || e.message?.includes('blocked'))
                return { status: 'blocked' };
            console.log(`  [!] Intento ${attempt}: ${e.message}`);
            if (attempt < MAX_RETRIES)
                await sleep(Math.pow(2, attempt) * 2000);
        }
    }
    return { status: 'error' };
}

// =============================================================================
// Parse HTML
// =============================================================================

function parseResults(html, query) {
    const results = [];
    const re = /<a[^>]*href="([^"]*\/search\/documento\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;

    while ((m = re.exec(html)) !== null) {
        const href = m[1];
        const text = m[2].replace(/<[^>]+>/g, '').trim();

        const roj = text.match(/ROJ:\s*(.+?)\s*-\s*(ECLI:\S+)/);
        if (!roj) continue;

        const hm = href.match(/\/search\/documento\/\w+\/(\d+)\/.*?\/(\d+)/);
        if (!hm) continue;

        const pos = m.index;
        const next = html.indexOf('/search/documento/', pos + m[0].length);
        const block = html.substring(pos, Math.min(next > 0 ? next : pos + 3000, pos + 3000))
            .replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ');

        const f = (pat, def = '') => {
            const x = block.match(pat);
            return x ? x[1].trim().replace(/-\s*$/, '').trim() : def;
        };

        results.push({
            roj: roj[1].trim(),
            ecli: roj[2].trim(),
            reference_id: hm[1],
            optimize_date: hm[2],
            tipo_organo: f(/Tipo\s+.rgano:\s*(.+?)(?:\n|Municipio:)/i),
            municipio: f(/Municipio:\s*(.+?)(?:\n|Ponente:)/i),
            ponente: f(/Ponente:\s*(.+?)(?:\n|N.\s*Recurso:)/i),
            recurso: f(/N.\s*Recurso:\s*(.+?)(?:\n|Fecha:)/i),
            fecha: f(/Fecha:\s*(.+?)(?:\n|Tipo\s+Resoluci)/i),
            tipo_resolucion: f(/Tipo\s+Resoluci.n:\s*(.+?)(?:\n|Resumen:)/i),
            resumen: f(/Resumen:\s*([\s\S]+?)(?:\n\s*\n|Icono compartir|compartir en)/i)
                .replace(/\s+/g, ' ').trim(),
            url_documento: href.startsWith('/') ? BASE_URL + href : href,
            url_pdf: PDF_URL_TPL
                .replace('{ref}', hm[1])
                .replace('{opt}', hm[2])
                .replace('{q}', encodeURIComponent(query)),
            pdf_filename: sanitize(roj[1].trim()) + '.pdf',
        });
    }
    return results;
}

function extractTotal(html) {
    const m = html.match(/(\d[\d.]*)\s*resultados/i);
    return m ? parseInt(m[1].replace(/\./g, '')) : null;
}

// =============================================================================
// Scrape un periodo (mes)
// =============================================================================

async function scrapePeriod(period, query, knownRoj, factor) {
    const newSentencias = [];
    let blocked = false;

    // Página 1
    const r = await searchPost(query, period.year, period.from, period.to, 1, factor);

    if (r.status === 'blocked') return { sentencias: [], blocked: true };
    if (r.status === 'error') return { sentencias: [], blocked: false };

    const total = extractTotal(r.html);
    const batch = parseResults(r.html, query)
        .filter(s => (s.tipo_organo || '').toLowerCase().includes('social'));

    let added = 0;
    for (const s of batch) {
        if (!knownRoj.has(s.roj)) { newSentencias.push(s); knownRoj.add(s.roj); added++; }
    }

    const pages = total ? Math.min(MAX_PAGES, Math.ceil(total / PER_PAGE)) : 1;

    process.stdout.write(
        `  ${period.label}: ${total ?? '?'} total, ${added} Social nueva(s)`
    );

    if (total && total > MAX_RETRIEVABLE) {
        process.stdout.write(` [AVISO: >${MAX_RETRIEVABLE}!]`);
    }

    // Páginas 2-4
    for (let p = 2; p <= pages; p++) {
        await sleep(randDelay(DELAY_PAGE, factor));
        const pr = await searchPost(query, period.year, period.from, period.to, (p-1)*PER_PAGE+1, factor);
        if (pr.status === 'blocked') { blocked = true; break; }
        if (pr.status === 'error') break;

        const pb = parseResults(pr.html, query)
            .filter(s => (s.tipo_organo || '').toLowerCase().includes('social'));

        for (const s of pb) {
            if (!knownRoj.has(s.roj)) { newSentencias.push(s); knownRoj.add(s.roj); added++; }
        }
        process.stdout.write(` +${pb.length}`);
        if (pb.length < PER_PAGE) break;
    }

    console.log(` → ${added} nuevas`);
    return { sentencias: newSentencias, blocked };
}

// =============================================================================
// Descarga PDF
// =============================================================================

async function downloadPdf(s, factor) {
    const fp = path.join(PDF_DIR, s.pdf_filename);
    try { if (fs.statSync(fp).size > 0) return 'exists'; } catch {}

    for (let att = 1; att <= MAX_RETRIES; att++) {
        try {
            requestCount++;
            const resp = await fetch(s.url_pdf, {
                headers: { 'User-Agent': UA, 'Accept': '*/*' },
                signal: AbortSignal.timeout(60000),
            });

            if (resp.status === 403) return 'blocked';
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('html')) return 'fail';

            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length < 1024) return 'fail';

            fs.writeFileSync(fp, buf);
            return 'ok';
        } catch (e) {
            if (att < MAX_RETRIES) await sleep(2000 * att);
        }
    }
    return 'fail';
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    const args = parseArgs();
    const factor = args.speedFactor;

    ensureDir(OUT_DIR);
    ensureDir(PDF_DIR);

    // Años a procesar
    let years;
    if (args.years) {
        years = args.years.sort((a, b) => b - a);
    } else {
        years = [];
        for (let y = args.yearTo; y >= args.yearFrom; y--) years.push(y);
    }

    // Progreso
    let progress = loadJson(PROGRESS_FILE, () => ({
        periods_completed: [],  // ["2024-01", "2024-02", ...]
        pdfs_downloaded: [],
        pdfs_failed: [],
    }));
    if (args.noResume) {
        progress = { periods_completed: [], pdfs_downloaded: [], pdfs_failed: [] };
    }

    let allSentencias = loadJson(META_FILE, []);
    const allRoj = new Set(allSentencias.map(s => s.roj));

    // Banner
    console.log('='.repeat(70));
    console.log('  DESCARGA SENTENCIAS TS SALA SOCIAL - CENDOJ (v2 stealth)');
    console.log('='.repeat(70));
    console.log(`  Busqueda:    "${args.query}"`);
    console.log(`  Años:        ${years[years.length-1]} - ${years[0]} (${years.length})`);
    console.log(`  Estrategia:  Filtro MENSUAL (evita limite 200/consulta)`);
    console.log(`  Delays:      ${DELAY_PAGE.min/1000}-${DELAY_PAGE.max/1000}s pag, ${DELAY_MONTH.min/1000}-${DELAY_MONTH.max/1000}s mes`);
    console.log(`  Speed:       x${factor}`);
    console.log(`  Previas:     ${allSentencias.length} sentencias, ${progress.periods_completed.length} meses completados`);
    if (args.skipPdf) console.log(`  PDFs:        SKIP`);
    if (args.dryRun) console.log(`  *** DRY RUN - no contactará CENDOJ ***`);
    console.log('='.repeat(70));
    console.log();

    if (args.dryRun) {
        // Mostrar plan
        let totalPeriods = 0;
        for (const y of years) {
            const periods = monthlyPeriods(y);
            const pending = periods.filter(p => !progress.periods_completed.includes(p.key));
            if (pending.length > 0) {
                console.log(`  ${y}: ${pending.length} meses pendientes (${pending.map(p => p.label).join(', ')})`);
                totalPeriods += pending.length;
            }
        }
        console.log(`\n  Total: ${totalPeriods} meses × ~5 peticiones = ~${totalPeriods * 5} peticiones`);
        const etaMins = Math.round(totalPeriods * 5 * 5 / 60); // ~5s por petición
        console.log(`  Tiempo estimado: ~${etaMins} minutos`);
        return;
    }

    // =========================================================================
    // FASE 1: Metadatos mes a mes
    // =========================================================================
    console.log(`[${ts()}] FASE 1: Extracción de metadatos`);
    console.log('-'.repeat(50));

    // Obtener sesión
    console.log('Obteniendo sesión...');
    const gotSession = await renewSession();
    if (!gotSession) {
        console.log('[!] No se pudo obtener sesión. ¿IP bloqueada?');
        console.log('    Comprueba: https://www.poderjudicial.es/search/indexAN.jsp');
        return;
    }
    console.log(`  OK: ${sessionCookie.substring(0, 35)}...`);
    console.log();

    let totalNew = 0;
    let wasBlocked = false;

    for (const year of years) {
        const periods = monthlyPeriods(year);
        const pending = periods.filter(p => !progress.periods_completed.includes(p.key));

        if (pending.length === 0) {
            const yCount = allSentencias.filter(s => (s.fecha || '').endsWith(String(year))).length;
            console.log(`\n  ${year}: completado (${yCount} sentencias)`);
            continue;
        }

        console.log(`\n  ── ${year} ── (${pending.length} meses pendientes)`);

        for (const period of pending) {
            const result = await scrapePeriod(period, args.query, allRoj, factor);

            if (result.blocked) {
                wasBlocked = true;
                console.log('\n  [!!!] IP BLOQUEADA. Guardando progreso y saliendo.');
                console.log('        Espera unas horas y vuelve a ejecutar (resume automático).');
                break;
            }

            totalNew += result.sentencias.length;
            allSentencias = allSentencias.concat(result.sentencias);

            // Guardar progreso cada mes
            progress.periods_completed.push(period.key);
            saveJson(META_FILE, allSentencias);
            saveJson(PROGRESS_FILE, progress);

            // Pausa entre meses
            await sleep(randDelay(DELAY_MONTH, factor));
        }

        if (wasBlocked) break;

        // Pausa larga entre años
        if (years.indexOf(year) < years.length - 1) {
            const yearDelay = randDelay(DELAY_YEAR, factor);
            console.log(`  (pausa entre años: ${(yearDelay/1000).toFixed(0)}s)`);
            await sleep(yearDelay);
        }
    }

    // Resumen fase 1
    console.log('\n' + '-'.repeat(50));
    console.log(`[${ts()}] Metadatos: ${allSentencias.length} total (${totalNew} nuevas)`);
    saveJson(META_FILE, allSentencias);

    // Distribución por año
    const dist = {};
    for (const s of allSentencias) {
        const y = s.fecha ? s.fecha.split('/').pop() : '?';
        dist[y] = (dist[y] || 0) + 1;
    }
    console.log('\nDistribución:');
    for (const y of Object.keys(dist).sort()) console.log(`  ${y}: ${dist[y]}`);

    if (wasBlocked || args.skipPdf) {
        if (args.skipPdf) console.log(`\n[OK] Metadatos en: ${META_FILE}`);
        return;
    }

    // =========================================================================
    // FASE 2: PDFs
    // =========================================================================
    console.log(`\n[${ts()}] FASE 2: Descarga de PDFs`);
    console.log('-'.repeat(50));

    const dlSet = new Set(progress.pdfs_downloaded);
    const failSet = new Set(progress.pdfs_failed);

    // Pre-check: marcar como descargados los que ya existen en disco
    let preExisting = 0;
    for (const s of allSentencias) {
        if (dlSet.has(s.roj) || failSet.has(s.roj)) continue;
        try {
            if (fs.statSync(path.join(PDF_DIR, s.pdf_filename)).size > 0) {
                dlSet.add(s.roj);
                progress.pdfs_downloaded.push(s.roj);
                preExisting++;
            }
        } catch {}
    }
    if (preExisting > 0) {
        console.log(`  Pre-check: ${preExisting} PDFs ya en disco, registrados en progreso`);
        saveJson(PROGRESS_FILE, progress);
    }

    const toDl = allSentencias.filter(s => !dlSet.has(s.roj) && !failSet.has(s.roj));

    // Contar en disco
    let onDisk = 0;
    for (const s of allSentencias) {
        try { if (fs.statSync(path.join(PDF_DIR, s.pdf_filename)).size > 0) onDisk++; } catch {}
    }

    console.log(`  En disco: ${onDisk}, Pendientes: ${toDl.length}`);
    console.log();

    let ok = onDisk, fail = 0;

    for (let i = 0; i < toDl.length; i++) {
        const s = toDl[i];
        process.stdout.write(`  [${i+1}/${toDl.length}] ${s.roj} (${s.fecha || '?'})... `);

        // Renovar sesión periódicamente
        if (requestCount >= REQUESTS_PER_SESSION) {
            await sleep(randDelay(DELAY_SESSION, factor));
            await renewSession();
        }

        const result = await downloadPdf(s, factor);

        switch (result) {
            case 'ok': {
                const sz = Math.round(fs.statSync(path.join(PDF_DIR, s.pdf_filename)).size / 1024);
                console.log(`OK (${sz} KB)`);
                progress.pdfs_downloaded.push(s.roj);
                ok++;
                break;
            }
            case 'exists':
                console.log('ya existe');
                progress.pdfs_downloaded.push(s.roj);
                ok++;
                break;
            case 'blocked':
                console.log('BLOQUEADO');
                wasBlocked = true;
                break;
            default:
                console.log('FALLO');
                progress.pdfs_failed.push(s.roj);
                fail++;
        }

        saveJson(PROGRESS_FILE, progress);

        if (wasBlocked) {
            console.log('\n  [!!!] IP bloqueada durante descarga PDF. Guardando y saliendo.');
            break;
        }

        await sleep(randDelay(DELAY_PDF, factor));
    }

    // =========================================================================
    // Resumen final
    // =========================================================================
    console.log('\n' + '='.repeat(70));
    console.log(`  RESUMEN FINAL (${ts()})`);
    console.log('='.repeat(70));
    console.log(`  Sentencias totales:  ${allSentencias.length}`);
    console.log(`  Nuevas esta sesión:  ${totalNew}`);
    console.log(`  Meses completados:   ${progress.periods_completed.length}`);
    console.log(`  PDFs OK:             ${ok}`);
    console.log(`  PDFs fallidos:       ${fail}`);
    console.log(`  Metadatos:           ${META_FILE}`);
    console.log(`  PDFs:                ${PDF_DIR}`);

    if (wasBlocked) {
        console.log();
        console.log('  ⚠ Ejecución interrumpida por bloqueo 403.');
        console.log('    Espera y vuelve a ejecutar (resume automático).');
    } else if (fail > 0) {
        console.log();
        console.log('  Para reintentar fallidos: edita download_progress_v2.json');
        console.log('  y elimina los ROJ de pdfs_failed, luego re-ejecuta.');
    }
    console.log();
}

main().catch(e => {
    console.error('[FATAL]', e);
    process.exit(1);
});
