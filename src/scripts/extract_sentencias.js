/**
 * extract_sentencias.js — Extrae texto completo de PDFs de sentencias TS y lo combina con metadatos vLex.
 *
 * Output: data/chunks/sentencias_raw.json (1 registro por sentencia)
 *
 * Uso:
 *   node src/scripts/extract_sentencias.js --limit 200
 *   node src/scripts/extract_sentencias.js --id 741204385
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const ROOT = path.join(__dirname, '..', '..');
const META_PATH = path.join(ROOT, 'data', 'sentencias_vlex', 'sentencias_vlex_metadata.json');
const PDF_DIR = path.join(ROOT, 'data', 'sentencias_vlex', 'pdf');
const OUT_PATH = path.join(ROOT, 'data', 'chunks', 'sentencias_raw.json');

const args = process.argv.slice(2);
const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 0;
const idArg = args.includes('--id') ? Number(args[args.indexOf('--id') + 1]) : 0;

function normalizeWhitespace(text) {
    return text
        .replace(/\r/g, '')
        // Join hyphenated line breaks
        .replace(/(\w)-\n(\w)/g, '$1$2')
        // Collapse horizontal whitespace
        .replace(/[ \t]+/g, ' ')
        // Preserve double newlines (paragraph separators), join single newlines into spaces
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n\n/g, '<<PARA>>')
        .replace(/\n/g, ' ')
        .replace(/<<PARA>>/g, '\n\n')
        // Clean up any double spaces introduced by joining
        .replace(/  +/g, ' ')
        .trim();
}

function cleanPdfArtifacts(text) {
    const lines = text.split('\n');
    const kept = [];

    const noisyPatterns = [
        /^Página\s+\d+\s+de\s+\d+$/i,
        /^[\-–—]\s*\d+\s*[\-–—]$/,
        /^Roj:\s*/i,
        /^ECLI:\s*/i,
        /^Cendoj:\s*/i,
        /^Ponente:\s*/i,
        /^Id\. Cendoj:\s*/i,
        /^©\s*Copyright.*vLex/i,
        /^Copia exclusivamente para uso personal/i,
        /^Descargado desde vLex/i,
        /^Sentencia citada en:\s*\d+/i,
        /^Id\.\s*vLex:/i,
        /^Link:\s*https:\/\/app\.vlex\.com/i,
        /^\d+\s+de\s+\w+\s+de\s+\d{4}\s+\d+:\d+.*\d+\/\d+$/i,
    ];

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) {
            kept.push('');
            continue;
        }

        const isNoisy = line.length < 180 && noisyPatterns.some(pattern => pattern.test(line));
        if (isNoisy) continue;

        if (line.length < 180 && line.toLowerCase().includes('www.poderjudicial.es')) continue;

        kept.push(rawLine);
    }

    return normalizeWhitespace(kept.join('\n'));
}

async function extractPdfText(pdfPath) {
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(buffer);
    const text = data?.text || '';
    return cleanPdfArtifacts(text);
}

function extractFalloFromText(text) {
    // Try to find FALLAMOS section in the original sentencia text
    const match = text.match(/FALLAMOS[:\s]+([\s\S]{10,1500}?)(?:\n(?:Notifíquese|Así se acuerda|Así,? por esta|Contra (?:la presente|esta)|Publíquese|Líbrese|Firme |PUBLICACIÓN)|$)/i);
    if (match) {
        return match[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return '';
}

function buildRecord(meta, text) {
    const fallo = meta.case_history_text || extractFalloFromText(text);
    return {
        sentencia_id: meta.id ?? null,
        title: meta.title || '',
        date: meta.date || '',
        pdf_filename: meta.pdf_filename || '',
        abstract: meta.abstract || '',
        fallo,
        text: text || '',
    };
}

async function main() {
    if (!fs.existsSync(META_PATH)) {
        console.error(`Metadata no encontrado: ${META_PATH}`);
        process.exit(1);
    }

    const metadataAll = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
    let metadata = metadataAll;

    if (idArg > 0) {
        metadata = metadata.filter(item => Number(item.id) === idArg);
    }

    if (limitArg > 0) {
        metadata = metadata.slice(0, limitArg);
    }

    const total = metadata.length;
    console.log(`Registros seleccionados: ${total}`);

    const records = [];
    let missing = 0;
    let shortText = 0;
    let errors = 0;

    for (let i = 0; i < total; i++) {
        const meta = metadata[i];
        const fileName = (meta.pdf_filename || '').trim();

        if (!fileName) {
            missing++;
            continue;
        }

        const pdfPath = path.join(PDF_DIR, fileName);
        if (!fs.existsSync(pdfPath)) {
            missing++;
            continue;
        }

        try {
            const text = await extractPdfText(pdfPath);
            if (text.length < 300) shortText++;
            records.push(buildRecord(meta, text));
        } catch (error) {
            errors++;
            console.error(`[${i + 1}/${total}] ERROR ${fileName}: ${error.message}`);
        }

        if ((i + 1) % 25 === 0 || i + 1 === total) {
            console.log(`[${i + 1}/${total}] procesados | salida=${records.length}`);
        }
    }

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(records, null, 2), 'utf-8');

    const sizeMb = (fs.statSync(OUT_PATH).size / (1024 * 1024)).toFixed(1);
    console.log('\n=== Extracción completada ===');
    console.log(`Guardado: ${OUT_PATH}`);
    console.log(`Registros: ${records.length}`);
    console.log(`PDFs faltantes: ${missing}`);
    console.log(`Textos muy cortos (<300): ${shortText}`);
    console.log(`Errores: ${errors}`);
    console.log(`Tamaño: ${sizeMb} MB`);
}

main().catch(error => {
    console.error('Error fatal:', error);
    process.exit(1);
});
