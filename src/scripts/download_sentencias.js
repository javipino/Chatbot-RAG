/**
 * Descarga de sentencias de la Sala 4 del Tribunal Supremo desde CENDOJ.
 *
 * Recorre las páginas de resultados de búsqueda, extrae metadatos de cada sentencia
 * y descarga los PDFs correspondientes.
 *
 * Uso:
 *   node download_sentencias.js                         # Descarga todas (hasta 200)
 *   node download_sentencias.js --max-pages 1           # Solo primera página
 *   node download_sentencias.js --skip-pdf              # Solo metadatos
 *   node download_sentencias.js --sala-social           # Filtrar solo Sala de lo Social
 *   node download_sentencias.js --resume                # Reanudar descarga
 *
 * No requiere dependencias externas (usa fetch nativo de Node 18+).
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// --- Configuración -----------------------------------------------------------

const BASE_URL = 'https://www.poderjudicial.es';
const DEFAULT_QUERY = 'sistema de la seguridad social';
const MAX_PAGES_DEFAULT = 20;
const RESULTS_PER_PAGE = 10;
const DELAY_MS = 1500;
const MAX_RETRIES = 3;

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'sentencias');
const PDF_DIR = path.join(OUTPUT_DIR, 'pdf');
const METADATA_FILE = path.join(OUTPUT_DIR, 'sentencias_metadata.json');
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'download_progress.json');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

// --- Argumentos CLI ----------------------------------------------------------

function parseArgs() {
    const args = {
        query: DEFAULT_QUERY,
        maxPages: MAX_PAGES_DEFAULT,
        delay: DELAY_MS,
        skipPdf: false,
        salaSocial: false,
        resume: false,
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--query': case '-q': args.query = argv[++i]; break;
            case '--max-pages': case '-p': args.maxPages = parseInt(argv[++i]); break;
            case '--delay': case '-d': args.delay = parseFloat(argv[++i]) * 1000; break;
            case '--skip-pdf': args.skipPdf = true; break;
            case '--sala-social': args.salaSocial = true; break;
            case '--resume': args.resume = true; break;
            case '--help': case '-h':
                console.log(`
Descarga sentencias del TS (Sala Social) desde CENDOJ

Opciones:
  --query, -q <texto>     Termino de busqueda (default: "${DEFAULT_QUERY}")
  --max-pages, -p <n>     Maximo de paginas (default: ${MAX_PAGES_DEFAULT})
  --delay, -d <seg>       Segundos entre peticiones (default: ${DELAY_MS/1000})
  --skip-pdf              Solo extraer metadatos, no descargar PDFs
  --sala-social           Filtrar solo Sala de lo Social
  --resume                Reanudar descarga anterior
  --help, -h              Mostrar esta ayuda
`);
                process.exit(0);
        }
    }
    return args;
}

// --- Utilidades --------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getOffset(pageNum) {
    // Página 1 → /1/, página 2 → /11/, página 3 → /21/
    return pageNum === 1 ? 1 : (pageNum - 1) * 10 + 1;
}

function sanitizeFilename(roj) {
    return roj.replace(/[^\w]/g, '_').replace(/^_+|_+$/g, '');
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(filepath, defaultVal) {
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    } catch { return typeof defaultVal === 'function' ? defaultVal() : defaultVal; }
}

function saveJson(filepath, data) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Fetch con reintentos ----------------------------------------------------

async function fetchPage(url) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
            return await resp.text();
        } catch (e) {
            console.log(`  [!] Intento ${attempt}/${MAX_RETRIES} fallido: ${e.message}`);
            if (attempt < MAX_RETRIES) {
                const wait = Math.pow(2, attempt) * 1000;
                console.log(`  Esperando ${wait/1000}s...`);
                await sleep(wait);
            }
        }
    }
    return null;
}

// --- Parser HTML simple (sin dependencias) -----------------------------------

/**
 * Parsea el HTML de resultados CENDOJ sin BeautifulSoup.
 * Busca los links a /search/documento/ y extrae los metadatos del bloque circundante.
 */
function parseSearchResults(html, query) {
    const sentencias = [];

    // Regex para encontrar links a documentos con ROJ/ECLI
    const linkRegex = /<a[^>]*href="([^"]*\/search\/documento\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;

    while ((linkMatch = linkRegex.exec(html)) !== null) {
        const href = linkMatch[1];
        const linkText = linkMatch[2].replace(/<[^>]+>/g, '').trim();

        // Extraer ROJ y ECLI del texto del link
        const rojMatch = linkText.match(/ROJ:\s*(.+?)\s*-\s*(ECLI:\S+)/);
        if (!rojMatch) continue;

        const roj = rojMatch[1].trim();
        const ecli = rojMatch[2].trim();

        // Extraer reference_id y optimize_date de la URL
        const hrefMatch = href.match(/\/search\/documento\/\w+\/(\d+)\/.*?\/(\d+)/);
        if (!hrefMatch) continue;

        const referenceId = hrefMatch[1];
        const optimizeDate = hrefMatch[2];

        // Extraer bloque de texto alrededor del link para obtener metadatos
        // Buscamos desde el link hasta el siguiente link o fin de contenido
        const linkPos = linkMatch.index;
        const nextLinkPos = html.indexOf('/search/documento/', linkPos + linkMatch[0].length);
        const blockEnd = nextLinkPos > 0 ? nextLinkPos : linkPos + 3000;
        const block = html.substring(linkPos, Math.min(blockEnd, linkPos + 3000));

        // Limpiar HTML tags del bloque
        const blockText = block.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ');

        function extractField(pattern, defaultVal = '') {
            const m = blockText.match(pattern);
            return m ? m[1].trim().replace(/-\s*$/, '').trim() : defaultVal;
        }

        const sentencia = {
            roj,
            ecli,
            reference_id: referenceId,
            optimize_date: optimizeDate,
            tipo_organo: extractField(/Tipo\s+.rgano:\s*(.+?)(?:\n|Municipio:)/i),
            municipio: extractField(/Municipio:\s*(.+?)(?:\n|Ponente:)/i),
            ponente: extractField(/Ponente:\s*(.+?)(?:\n|N.\s*Recurso:)/i),
            recurso: extractField(/N.\s*Recurso:\s*(.+?)(?:\n|Fecha:)/i),
            fecha: extractField(/Fecha:\s*(.+?)(?:\n|Tipo\s+Resoluci)/i),
            tipo_resolucion: extractField(/Tipo\s+Resoluci.n:\s*(.+?)(?:\n|Resumen:)/i),
            resumen: extractField(/Resumen:\s*([\s\S]+?)(?:\n\s*\n|Icono compartir|compartir en)/i),
            url_documento: href.startsWith('/') ? BASE_URL + href : href,
            url_pdf: `${BASE_URL}/search/contenidos.action?action=accessToPDF&publicinterface=true&tab=AN&reference=${referenceId}&optimize=${optimizeDate}&links=${encodeURIComponent(query)}&databasematch=TS`,
            pdf_filename: sanitizeFilename(roj) + '.pdf',
        };

        // Limpiar resumen
        sentencia.resumen = sentencia.resumen.replace(/\s+/g, ' ').trim();

        sentencias.push(sentencia);
    }

    return sentencias;
}

// --- Descarga de PDFs --------------------------------------------------------

async function downloadPdf(sentencia) {
    const pdfPath = path.join(PDF_DIR, sentencia.pdf_filename);

    // Saltar si ya existe
    try {
        const stat = fs.statSync(pdfPath);
        if (stat.size > 0) return true;
    } catch {}

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(sentencia.url_pdf, {
                headers: HEADERS,
                signal: AbortSignal.timeout(60000),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('html')) {
                console.log('\n  [!] Respuesta HTML en vez de PDF');
                return false;
            }

            const buffer = Buffer.from(await resp.arrayBuffer());
            if (buffer.length < 1024) {
                console.log(`\n  [!] PDF sospechosamente pequeno (${buffer.length} bytes)`);
                return false;
            }

            fs.writeFileSync(pdfPath, buffer);
            return true;

        } catch (e) {
            console.log(`\n  [!] Intento ${attempt}/${MAX_RETRIES} fallido: ${e.message}`);
            if (attempt < MAX_RETRIES) await sleep(Math.pow(2, attempt) * 1000);
        }
    }
    return false;
}

// --- Main --------------------------------------------------------------------

async function main() {
    const args = parseArgs();
    const queryEncoded = encodeURIComponent(args.query);

    ensureDir(OUTPUT_DIR);
    ensureDir(PDF_DIR);

    let progress = loadJson(PROGRESS_FILE, () => ({ pages_scraped: [], pdfs_downloaded: [], pdfs_failed: [] }));
    let existingMetadata = loadJson(METADATA_FILE, []);
    const existingRoj = new Set(existingMetadata.map(s => s.roj));

    console.log('='.repeat(70));
    console.log('DESCARGA DE SENTENCIAS - CENDOJ (Poder Judicial)');
    console.log('='.repeat(70));
    console.log(`  Busqueda: "${args.query}"`);
    console.log(`  Paginas:  hasta ${args.maxPages} (max. ${args.maxPages * RESULTS_PER_PAGE} sentencias)`);
    console.log(`  Delay:    ${args.delay/1000}s entre peticiones`);
    console.log(`  Salida:   ${OUTPUT_DIR}`);
    if (args.salaSocial) console.log(`  Filtro:   Solo Sala de lo Social`);
    if (args.skipPdf) console.log(`  PDFs:     NO (solo metadatos)`);
    if (args.resume && existingMetadata.length) console.log(`  Reanudando: ${existingMetadata.length} sentencias previas`);
    console.log('='.repeat(70));
    console.log();

    let allSentencias = args.resume ? [...existingMetadata] : [];
    let allRoj = args.resume ? new Set(existingRoj) : new Set();
    let newCount = 0;
    let skippedCount = 0;

    // == Fase 1: Scraping de metadatos ========================================

    console.log('FASE 1: Extraccion de metadatos de resultados de busqueda');
    console.log('-'.repeat(50));

    for (let page = 1; page <= args.maxPages; page++) {
        if (args.resume && progress.pages_scraped.includes(page)) {
            console.log(`  Pagina ${String(page).padStart(2)}/${args.maxPages}: ya procesada, saltando`);
            continue;
        }

        const offset = getOffset(page);
        const url = `${BASE_URL}/search/sentencias/${queryEncoded}/${offset}/PUB`;
        console.log(`  Pagina ${String(page).padStart(2)}/${args.maxPages}: descargando...`);

        const html = await fetchPage(url);
        if (!html) {
            console.log(`  [X] No se pudo obtener la pagina ${page}`);
            continue;
        }

        let sentencias = parseSearchResults(html, args.query);

        if (sentencias.length === 0) {
            console.log(`  [X] Sin resultados en pagina ${page} -- fin de resultados`);
            break;
        }

        if (args.salaSocial) {
            const before = sentencias.length;
            sentencias = sentencias.filter(s =>
                (s.tipo_organo || '').toLowerCase().includes('social')
            );
            if (before !== sentencias.length) {
                console.log(`    (filtradas ${before - sentencias.length} no-Social)`);
            }
        }

        let pageNew = 0;
        for (const s of sentencias) {
            if (!allRoj.has(s.roj)) {
                allSentencias.push(s);
                allRoj.add(s.roj);
                pageNew++;
            } else {
                skippedCount++;
            }
        }

        newCount += pageNew;
        console.log(`    -> ${sentencias.length} sentencias, ${pageNew} nuevas`);

        progress.pages_scraped.push(page);
        saveJson(METADATA_FILE, allSentencias);
        saveJson(PROGRESS_FILE, progress);

        if (page < args.maxPages) await sleep(args.delay);
    }

    console.log();
    console.log(`Total sentencias recopiladas: ${allSentencias.length} (${newCount} nuevas)`);
    if (skippedCount) console.log(`  (${skippedCount} duplicadas omitidas)`);
    saveJson(METADATA_FILE, allSentencias);

    if (args.skipPdf) {
        console.log();
        console.log(`[OK] Metadatos guardados en: ${METADATA_FILE}`);
        return;
    }

    // == Fase 2: Descarga de PDFs =============================================

    console.log();
    console.log('FASE 2: Descarga de PDFs');
    console.log('-'.repeat(50));

    const downloadedSet = new Set(progress.pdfs_downloaded || []);
    const failedSet = new Set(progress.pdfs_failed || []);

    const toDownload = allSentencias.filter(s =>
        !downloadedSet.has(s.roj) && !failedSet.has(s.roj)
    );

    let already = 0;
    for (const s of allSentencias) {
        try {
            const stat = fs.statSync(path.join(PDF_DIR, s.pdf_filename));
            if (stat.size > 0) already++;
        } catch {}
    }

    console.log(`  ${already} ya descargados, ${toDownload.length} pendientes`);
    console.log();

    let success = already;
    let failed = 0;

    for (let i = 0; i < toDownload.length; i++) {
        const sentencia = toDownload[i];
        const roj = sentencia.roj;
        const pdfPath = path.join(PDF_DIR, sentencia.pdf_filename);

        process.stdout.write(`  [${i+1}/${toDownload.length}] ${roj} (${sentencia.fecha || '?'})... `);

        // Comprobar si ya existe
        try {
            const stat = fs.statSync(pdfPath);
            if (stat.size > 0) {
                console.log('ya existe [OK]');
                progress.pdfs_downloaded.push(roj);
                success++;
                saveJson(PROGRESS_FILE, progress);
                continue;
            }
        } catch {}

        const ok = await downloadPdf(sentencia);
        if (ok) {
            const stat = fs.statSync(pdfPath);
            const sizeKb = Math.round(stat.size / 1024);
            console.log(`[OK] (${sizeKb} KB)`);
            progress.pdfs_downloaded.push(roj);
            success++;
        } else {
            console.log('[FALLO]');
            progress.pdfs_failed.push(roj);
            failed++;
        }

        saveJson(PROGRESS_FILE, progress);
        await sleep(args.delay);
    }

    // == Resumen ==============================================================

    console.log();
    console.log('='.repeat(70));
    console.log('RESUMEN');
    console.log('='.repeat(70));
    console.log(`  Sentencias totales:   ${allSentencias.length}`);
    console.log(`  PDFs descargados:     ${success}`);
    console.log(`  PDFs fallidos:        ${failed}`);
    console.log(`  Metadatos:            ${METADATA_FILE}`);
    console.log(`  PDFs:                 ${PDF_DIR}`);

    if (failed > 0) {
        console.log();
        console.log('  Para reintentar los fallidos, ejecuta de nuevo con --resume');
    }
    console.log();
}

main().catch(e => {
    console.error('Error fatal:', e);
    process.exit(1);
});
