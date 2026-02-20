/**
 * extract_criterios.js — Extrae texto de PDFs de criterios INSS y lo combina con metadatos CSV.
 *
 * Merge: si un criterio tiene múltiples PDFs (criterio + Informe DGOSS), se concatenan.
 * Fallback: si no se encuentra el PDF, se usa la Descripción del CSV como texto.
 *
 * Output: data/chunks/criterios_raw.json (1 registro por criterio)
 *
 * Uso:
 *   node src/scripts/extract_criterios.js
 *   node src/scripts/extract_criterios.js --limit 50
 *   node src/scripts/extract_criterios.js --id 15401
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const ROOT = path.join(__dirname, '..', '..');
const CSV_PATH = path.join(ROOT, 'data', 'normas', 'normass_metadatos.csv');
const PDF_DIR = path.join(ROOT, 'data', 'normas', 'pdfs');
const OUT_PATH = path.join(ROOT, 'data', 'chunks', 'criterios_raw.json');

const args = process.argv.slice(2);
const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 0;
const idArg = args.includes('--id') ? Number(args[args.indexOf('--id') + 1]) : 0;

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Parses a CSV line respecting quoted fields (handles commas inside quotes).
 */
function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            fields.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current);
    return fields;
}

function loadCsv(csvPath) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const headerFields = parseCsvLine(lines[0]);
    const headers = headerFields.map(h => h.replace(/^"|"$/g, '').trim());

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = (fields[j] || '').replace(/^"|"$/g, '').trim();
        }
        rows.push(row);
    }
    return rows;
}

// ─── PDF text extraction ──────────────────────────────────────────────────────

function normalizeWhitespace(text) {
    return text
        .replace(/\r/g, '')
        .replace(/(\w)-\n(\w)/g, '$1$2')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n\n/g, '<<PARA>>')
        .replace(/\n/g, ' ')
        .replace(/<<PARA>>/g, '\n\n')
        .replace(/  +/g, ' ')
        .trim();
}

function cleanPdfArtifacts(text) {
    const lines = text.split('\n');
    const kept = [];

    const noisyPatterns = [
        /^Página\s+\d+\s+de\s+\d+$/i,
        /^[\-–—]\s*\d+\s*[\-–—]$/,
        /^\d+\s*\/\s*\d+$/,                // page number "1/3"
        /^www\.seg-social\.es/i,
        /^MINISTERIO\s+DE\s+INCLUSI[OÓ]N,?\s+SEGURIDAD\s+SOCIAL/i,
        /^SECRETAR[IÍ]A\s+DE\s+ESTADO/i,
        /^INSTITUTO\s+NACIONAL\s+DE\s+LA\s+SEGURIDAD\s+SOCIAL$/i,
        /^SUBDIRECCI[OÓ]N\s+GENERAL\s+DE/i,
        /^S\.G\.\s+ORDENACI[OÓ]N/i,
    ];

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) {
            kept.push('');
            continue;
        }

        const isNoisy = line.length < 180 && noisyPatterns.some(p => p.test(line));
        if (isNoisy) continue;

        kept.push(rawLine);
    }

    return normalizeWhitespace(kept.join('\n'));
}

async function extractPdfText(pdfPath) {
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(buffer);
    return cleanPdfArtifacts(data?.text || '');
}

// ─── URL → local filename mapping ─────────────────────────────────────────────

/**
 * Extracts the PDF filename from a normass portal URL.
 * URL pattern: https://normass.pro.portal.ss:8443/documents/portlet_file_entry/1122530/{FILENAME}/{UUID}
 * The filename has + for spaces in the URL — keep them as + since that's how local files are named.
 */
function extractFilenameFromUrl(url) {
    const parts = url.split('/');
    // Find the part after "1122530"
    const idx = parts.indexOf('1122530');
    if (idx >= 0 && idx + 1 < parts.length) {
        // Keep + as-is: local files use "1-2026+Informe+DGOSS.pdf" not spaces
        return decodeURIComponent(parts[idx + 1]);
    }
    // Fallback: take second-to-last segment
    if (parts.length >= 2) {
        return decodeURIComponent(parts[parts.length - 2]);
    }
    return null;
}

/**
 * Checks if a filename is an "Informe DGOSS" or similar supporting document.
 */
function isInformeFile(filename) {
    const lower = filename.toLowerCase();
    return lower.includes('informe') || lower.includes('criterio+dgoss') ||
           lower.includes('criterio dgoss') || lower.includes('escrito') ||
           lower.includes('nota informativa') || lower.includes('aclaracion') ||
           lower.includes('anexo');
}

// ─── Parse criterio number from title ─────────────────────────────────────────

function parseCriterioNum(titulo) {
    const match = titulo.match(/CRITERIOS?\s+(\d+(?:\/\d{4}(?:-?\d{2,4})?))/i);
    return match ? match[1] : '';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!fs.existsSync(CSV_PATH)) {
        console.error(`CSV no encontrado: ${CSV_PATH}`);
        process.exit(1);
    }

    console.log('=== Extracción de Criterios INSS ===\n');

    const allRows = loadCsv(CSV_PATH);
    console.log(`Filas CSV leídas: ${allRows.length}`);

    // Deduplicate by ID (CSV has duplicates with different pagination params)
    const seenIds = new Set();
    const uniqueRows = [];
    for (const row of allRows) {
        const id = row.ID;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        uniqueRows.push(row);
    }
    console.log(`Filas únicas (por ID): ${uniqueRows.length}`);

    // Filter: exclude "Parcialmente Derogada"
    const vigentes = uniqueRows.filter(r => r.Estado !== 'Parcialmente Derogada');
    console.log(`Vigentes (excluidas ${uniqueRows.length - vigentes.length} parcialmente derogadas): ${vigentes.length}`);

    // Apply --id or --limit filters
    let rows = vigentes;
    if (idArg > 0) {
        rows = rows.filter(r => Number(r.ID) === idArg);
    }
    if (limitArg > 0) {
        rows = rows.slice(0, limitArg);
    }

    const total = rows.length;
    console.log(`Procesando: ${total}\n`);

    const records = [];
    let withPdf = 0;
    let fallback = 0;
    let errors = 0;
    let withInforme = 0;

    for (let i = 0; i < total; i++) {
        const row = rows[i];

        try {
            // Parse PDF URLs from CSV (semicolon-separated)
            const pdfUrls = (row.PDFs || '').split(';').map(u => u.trim()).filter(Boolean);
            const pdfFilenames = pdfUrls.map(extractFilenameFromUrl).filter(Boolean);

            // Separate main criterio PDF from informe PDFs
            const mainPdfs = pdfFilenames.filter(f => !isInformeFile(f));
            const informePdfs = pdfFilenames.filter(f => isInformeFile(f));

            // Try to extract text from available PDFs
            const textParts = [];
            let foundAnyPdf = false;

            // Process main PDFs first
            for (const filename of mainPdfs) {
                const pdfPath = path.join(PDF_DIR, filename);
                if (fs.existsSync(pdfPath)) {
                    const text = await extractPdfText(pdfPath);
                    if (text.length > 50) {
                        textParts.push(text);
                        foundAnyPdf = true;
                    }
                }
            }

            // Then informe PDFs (merged with separator)
            let hasInforme = false;
            for (const filename of informePdfs) {
                const pdfPath = path.join(PDF_DIR, filename);
                if (fs.existsSync(pdfPath)) {
                    const text = await extractPdfText(pdfPath);
                    if (text.length > 50) {
                        textParts.push('\n\n--- INFORME DGOSS ---\n\n' + text);
                        hasInforme = true;
                        foundAnyPdf = true;
                    }
                }
            }

            let finalText;
            let hasFullText;

            if (textParts.length > 0) {
                finalText = textParts.join('\n\n');
                hasFullText = true;
                withPdf++;
                if (hasInforme) withInforme++;
            } else {
                // Fallback: use CSV description
                finalText = row.Descripcion || row.Titulo || '';
                hasFullText = false;
                fallback++;
            }

            const record = {
                criterio_id: Number(row.ID) || 0,
                criterio_num: parseCriterioNum(row.Titulo || ''),
                titulo: row.Titulo || '',
                descripcion: row.Descripcion || '',
                fecha: row.Fecha || '',
                emisor: row.Emisor || '',
                estado: row.Estado || '',
                text: finalText,
                has_full_text: hasFullText,
                has_informe_dgoss: hasInforme || false,
                pdf_filenames: pdfFilenames,
                url: row.URL || '',
            };

            records.push(record);
        } catch (error) {
            errors++;
            console.error(`[${i + 1}/${total}] ERROR ID=${row.ID}: ${error.message}`);
        }

        if ((i + 1) % 50 === 0 || i + 1 === total) {
            console.log(`[${i + 1}/${total}] procesados | pdf=${withPdf} | fallback=${fallback} | errores=${errors}`);
        }
    }

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(records, null, 2), 'utf-8');

    const sizeMb = (fs.statSync(OUT_PATH).size / (1024 * 1024)).toFixed(1);
    const textLengths = records.filter(r => r.has_full_text).map(r => r.text.length);
    const avgLen = textLengths.length > 0 ? Math.round(textLengths.reduce((a, b) => a + b, 0) / textLengths.length) : 0;
    const medianLen = textLengths.length > 0
        ? textLengths.sort((a, b) => a - b)[Math.floor(textLengths.length / 2)]
        : 0;

    console.log('\n=== Extracción completada ===');
    console.log(`Guardado: ${OUT_PATH}`);
    console.log(`Registros: ${records.length}`);
    console.log(`  Con PDF: ${withPdf} (${withInforme} con Informe DGOSS)`);
    console.log(`  Fallback (solo descripción): ${fallback}`);
    console.log(`  Errores: ${errors}`);
    console.log(`Texto (con PDF): media=${avgLen} chars, mediana=${medianLen} chars`);
    console.log(`Tamaño: ${sizeMb} MB`);
}

main().catch(error => {
    console.error('Error fatal:', error);
    process.exit(1);
});
