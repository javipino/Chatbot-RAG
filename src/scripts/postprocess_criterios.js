/**
 * postprocess_criterios.js — Limpieza profunda de texto + extracción ampliada de normativa_refs.
 *
 * Cambios:
 *   1. Elimina ruido del PDF: cabeceras repetidas, números de página sueltos, disclaimers
 *   2. Colapsa newlines excesivos → espacios (salvo separadores de sección)
 *   3. Elimina campos innecesarios (pdf_filenames, url)
 *   4. Extrae normativa_refs ampliadas: abreviaturas + Ley N/YYYY + RD + disposiciones + Órdenes + UE
 *
 * Input:  data/chunks/criterios_raw.json (requiere haber corrido extract_criterios.js)
 * Output: data/chunks/criterios_raw.json (in-place)
 *
 * Uso:
 *   node src/scripts/postprocess_criterios.js --dry-run
 *   node src/scripts/postprocess_criterios.js
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'chunks', 'criterios_raw.json');
const dryRun = process.argv.includes('--dry-run');

// ─── Text cleanup ───────────────────────────────────────────────────

function cleanText(text) {
    if (!text) return text;

    // 1. Strip leading page-number line (modern: "1 \n\n", old: "74/2003-04-1 \n\n")
    text = text.replace(/^\d+(?:\/\d+(?:-\d+)?)?(?:-\d+)?\s*\n/, '');

    // 2. Remove header lines: "Criterio de gestión: 6/2026 Fecha: 18/02/2026 Materia: ..."
    text = text.replace(/^Criterio de gesti[oó]n:\s*\d+.*$/gm, '');

    // 3. Remove standalone page numbers on their own line (2, 3, 14, etc.)
    text = text.replace(/^\d{1,3}$/gm, '');

    // 4. Remove ending disclaimer paragraph
    text = text.replace(/Esta informaci[oó]n ha sido elaborada teniendo en cuenta la legislaci[oó]n vigente.*$/s, '');

    // 5. Remove "LA DIRECTORA GENERAL" / "EL DIRECTOR GENERAL" closing signatures
    text = text.replace(/\n(?:LA|EL) DIRECTOR[A]? GENERAL\s*$/i, '');

    // 6. Collapse multiple newlines → single newline
    text = text.replace(/\n{2,}/g, '\n');

    // 6b. Clean trailing hyphens after law/regulation numbers: "1408/71- no" → "1408/71, no"
    text = text.replace(/(\d\/\d{2,4})-\s/g, '$1 ');

    // 7. Merge lines aggressively: only keep \n before section headers.
    //    Everything else becomes continuous paragraphs (PDF wrapping artifact).
    const sectionHeaders = /^(?:ASUNTO|CRITERIO DE GESTI[OÓ]N|CRITERIO|(?:- )?Asunto consultado|(?:- )?Disposiciones? de aplicaci[oó]n|(?:- )?Criterio|(?:- )?Desarrollo|--- INFORME|[IVX]+\.-|LA DIRECTORA|EL DIRECTOR|[A-G]\)|\d+[ºªa.)]+\s)/i;
    const lines = text.split('\n');
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (merged.length === 0 || sectionHeaders.test(line)) {
            merged.push(line);
        } else {
            const prev = merged[merged.length - 1];
            // Handle hyphenated word breaks: join without space
            if (prev.endsWith('-')) {
                merged[merged.length - 1] = prev.slice(0, -1) + line;
            } else {
                merged[merged.length - 1] = prev + ' ' + line;
            }
        }
    }

    text = merged.join('\n');
    text = text.trim();

    return text;
}

// ─── Reference extraction ───────────────────────────────────────────

// Procedural article refs that are boilerplate
const PROCEDURAL_REFS = new Set([
    'art. 219 LRJS', 'art. 219.1 LRJS', 'art. 219.2 LRJS', 'art. 219.3 LRJS',
    'art. 220 LRJS', 'art. 221 LRJS', 'art. 222 LRJS', 'art. 223 LRJS',
    'art. 224 LRJS', 'art. 225 LRJS', 'art. 226 LRJS', 'art. 226.2 LRJS',
    'art. 227 LRJS', 'art. 228 LRJS', 'art. 235 LRJS',
]);

// Boilerplate law refs that appear in every document (procedural)
const NOISE_REFS = new Set([
    'Ley 39/2015',  // procedimiento administrativo (used in disclaimer)
]);

function extractRefsFromText(text) {
    const refs = new Set();

    // ── Pattern 1: art. X ABREVIATURA (ET, LGSS, TRLGSS, CE, etc.)
    const pat1 = /art(?:ículo|[.\s])\s*(\d+[\d.]*(?:\s*(?:bis|ter|quater))?)\s+(?:del?\s+)?(?:la\s+)?(?:Ley\s+)?(?:Org[aá]nica\s+)?(ET|LGSS|LETA|LISOS|CE|LRJS|LOLS|LPRL|LET|TRLGSS|TRET|TREBEP|TRLEBEP|EBEP|CC|LBRL|TRLET|Estatuto de los Trabajadores|Ley General de la Seguridad Social|Estatuto B[aá]sico del Empleado P[uú]blico)/gi;
    let m;
    while ((m = pat1.exec(text)) !== null) {
        let ley = m[2].trim();
        if (/Estatuto de los Trabajadores/i.test(ley)) ley = 'ET';
        if (/Ley General de la Seguridad Social/i.test(ley)) ley = 'LGSS';
        if (/Estatuto B.sico del Empleado/i.test(ley)) ley = 'TREBEP';
        const key = `art. ${m[1].trim()} ${ley.toUpperCase()}`;
        if (!PROCEDURAL_REFS.has(key)) refs.add(key);
    }

    // ── Pattern 1b: art. X del texto refundido de la Ley ... (TRLGSS, TRLET, TRLEBEP patterns)
    const pat1b = /art(?:ículo|[.\s])\s*(\d+[\d.]*(?:\s*(?:bis|ter|quater))?)\s+(?:del\s+)?(?:texto refundido de la\s+)?(?:Ley\s+(?:General\s+de la\s+Seguridad Social|del\s+Estatuto\s+de\s+los\s+Trabajadores|del\s+Estatuto\s+B[aá]sico\s+del\s+Empleado\s+P[uú]blico))/gi;
    while ((m = pat1b.exec(text)) !== null) {
        let ley = m[0];
        if (/Seguridad Social/i.test(ley)) ley = 'TRLGSS';
        else if (/Trabajadores/i.test(ley)) ley = 'ET';
        else if (/Empleado/i.test(ley)) ley = 'TREBEP';
        else ley = 'UNKNOWN';
        const key = `art. ${m[1].trim()} ${ley}`;
        if (!PROCEDURAL_REFS.has(key)) refs.add(key);
    }

    // ── Pattern 2: art. X de la Ley N/YYYY or art. X del Real Decreto[-Ley/Legislativo] N/YYYY
    const pat2 = /art(?:ículo|[.\s])\s*(\d+[\d.]*(?:\s*(?:bis|ter|quater))?)\s+(?:del?\s+)?(?:la\s+)?((?:Ley\s+Org[aá]nica|Ley|Real Decreto[- ]?[Ll]egislativo|Real Decreto[- ]?[Ll]ey|Real Decreto)\s+\d+\/\d{4})/gi;
    while ((m = pat2.exec(text)) !== null) {
        const key = `art. ${m[1].trim()} ${m[2].replace(/\s+/g, ' ').trim()}`;
        refs.add(key);
    }

    // ── Pattern 3: Standalone law references (no article): Ley N/YYYY, RD N/YYYY, RDL N/YYYY
    const pat3 = /(?:^|[^a-záéíóú])((?:Ley\s+Org[aá]nica|Ley|Real Decreto[- ]?[Ll]egislativo|Real Decreto[- ]?[Ll]ey|Real Decreto)\s+\d+\/\d{4})/gi;
    while ((m = pat3.exec(text)) !== null) {
        const ref = m[1].replace(/\s+/g, ' ').trim();
        if (!NOISE_REFS.has(ref)) refs.add(ref);
    }

    // ── Pattern 4: Disposición transitoria/adicional/final + ordinal (Spanish ordinals only)
    const ordinals = /(?:primera|segunda|tercera|cuarta|quinta|sexta|s[eé]ptima|octava|novena|d[eé]cima|und[eé]cima|duod[eé]cima|decimotercera|decimocuarta|decimoquinta|decimosexta|decimos[eé]ptima|decimoctava|decimonovena|vig[eé]sima|trig[eé]sima|cuadrag[eé]sima|quincuag[eé]sima|sexag[eé]sima|[uú]nica|\d+[ªa])/i;
    const pat4 = new RegExp(
        'disposici[oó]n\\s+(transitoria|adicional|final|derogatoria)\\s+(' + ordinals.source + ')',
        'gi'
    );
    while ((m = pat4.exec(text)) !== null) {
        refs.add(`disp. ${m[1].toLowerCase()} ${m[2].toLowerCase()}`);
    }

    // ── Pattern 5: Orden ministerial (Orden TAS/ESS/TMS/ISM/EHA/PRE/...)
    const pat5 = /Orden\s+((?:TAS|ESS|TMS|ISM|EHA|PRE|SPI|INT)[\s/]*\d+\/\d{4})/gi;
    while ((m = pat5.exec(text)) !== null) {
        refs.add(`Orden ${m[1].replace(/\s+/g, '').trim()}`);
    }

    // ── Pattern 6: EU regulations - Reglamento (CE|CEE|UE) N/YYYY
    const pat6 = /Reglamento\s+\(?(CE|CEE|UE)\)?\s*(?:N[uú]m\.?\s*)?(?:n[oº]?\.?\s*)?(\d+\/\d{2,4})/gi;
    while ((m = pat6.exec(text)) !== null) {
        refs.add(`Reglamento ${m[1].toUpperCase()} ${m[2]}`);
    }

    // ── Pattern 6b: art. X del Reglamento (CE|CEE|UE) N/YYYY
    const pat6b = /art(?:ículo|[.\s])\s*(\d+[\d.]*)\s+del\s+(?:citado\s+)?Reglamento\s+\(?(CE|CEE|UE)\)?\s*(?:N[uú]m\.?\s*)?(?:n[oº]?\.?\s*)?(\d+\/\d{2,4})/gi;
    while ((m = pat6b.exec(text)) !== null) {
        refs.add(`art. ${m[1]} Reglamento ${m[2].toUpperCase()} ${m[3]}`);
    }

    // ── Pattern 7: EU directives - Directiva N/YYYY
    const pat7 = /Directiva\s+(\d+\/\d+)/gi;
    while ((m = pat7.exec(text)) !== null) {
        refs.add(`Directiva ${m[1]}`);
    }

    return [...refs].sort();
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
    console.log('=== Post-procesado Criterios INSS (v2) ===\n');

    const items = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    console.log(`Registros: ${items.length}`);

    let textCleaned = 0;
    let totalCharsBefore = 0;
    let totalCharsAfter = 0;
    let totalRefs = 0;
    let withRefs = 0;
    const refTypes = { abbr: 0, artLey: 0, ley: 0, disp: 0, orden: 0, regUE: 0, dir: 0 };

    for (const item of items) {
        const origLen = (item.text || '').length;
        totalCharsBefore += origLen;

        // Clean text
        item.text = cleanText(item.text);
        totalCharsAfter += item.text.length;
        if (item.text.length < origLen) textCleaned++;

        // Remove unnecessary fields
        delete item.pdf_filenames;
        delete item.url;

        // Extract refs
        item.normativa_refs = extractRefsFromText(item.text);
        if (item.normativa_refs.length > 0) {
            withRefs++;
            totalRefs += item.normativa_refs.length;
            // Count ref types for stats
            for (const ref of item.normativa_refs) {
                if (/^art\.\s+\d.*\s+[A-Z]{2,}$/.test(ref)) refTypes.abbr++;
                else if (/^art\.\s+\d.*(?:Ley|Real)/.test(ref)) refTypes.artLey++;
                else if (/^(?:Ley|Real)/.test(ref)) refTypes.ley++;
                else if (/^disp\./.test(ref)) refTypes.disp++;
                else if (/^Orden/.test(ref)) refTypes.orden++;
                else if (/^Reglamento/.test(ref)) refTypes.regUE++;
                else if (/^Directiva/.test(ref)) refTypes.dir++;
            }
        }
    }

    const reduction = ((1 - totalCharsAfter / totalCharsBefore) * 100).toFixed(1);
    console.log(`Texto limpiado: ${textCleaned} records`);
    console.log(`Chars: ${totalCharsBefore.toLocaleString()} → ${totalCharsAfter.toLocaleString()} (-${reduction}%)`);
    console.log(`\nCon normativa_refs: ${withRefs}/${items.length} (${Math.round(withRefs / items.length * 100)}%)`);
    console.log(`Total refs: ${totalRefs} | media: ${(totalRefs / items.length).toFixed(1)}/doc`);
    console.log(`  Abreviatura (art. X ET/TRLGSS): ${refTypes.abbr}`);
    console.log(`  Art. + Ley/RD (art. X Ley N/YYYY): ${refTypes.artLey}`);
    console.log(`  Ley/RD standalone: ${refTypes.ley}`);
    console.log(`  Disposiciones: ${refTypes.disp}`);
    console.log(`  Órdenes ministeriales: ${refTypes.orden}`);
    console.log(`  Reglamentos UE: ${refTypes.regUE}`);
    console.log(`  Directivas UE: ${refTypes.dir}`);

    // Show samples
    console.log('\n--- Muestras ---');
    [0, 10, 50, 400].forEach(i => {
        if (!items[i]) return;
        console.log(`\n[${i}] ${items[i].criterio_num} (${items[i].text.length} chars):`);
        console.log(items[i].text.substring(0, 250) + '...');
        console.log('Refs:', items[i].normativa_refs.slice(0, 8).join(', '));
    });

    if (dryRun) {
        console.log('\n[DRY-RUN] No se guardó nada.');
        return;
    }

    fs.writeFileSync(FILE, JSON.stringify(items, null, 2), 'utf-8');
    const sizeMb = (fs.statSync(FILE).size / (1024 * 1024)).toFixed(1);
    console.log(`\nGuardado: ${FILE}`);
    console.log(`Tamaño: ${sizeMb} MB`);
}

main();
