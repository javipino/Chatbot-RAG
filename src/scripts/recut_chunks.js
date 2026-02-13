/**
 * recut_chunks.js — Recorta los chunks de normativa corrigiendo los cortes erróneos.
 *
 * Problema: el extractor original usaba re.IGNORECASE en el regex de artículos,
 * lo que provocaba que referencias mid-sentence como "artículo 45.1" (minúscula)
 * se interpretaran como inicio de artículo nuevo, cortando el texto del art. anterior.
 *
 * Solución:
 * 1. Carga los chunks v2 (raw, sin enrichment)
 * 2. Detecta chunks de "continuación" (section empieza con "artículo" minúscula)
 * 3. Fusiona su texto con el chunk padre (el artículo anterior correcto)
 * 4. Guarda como v3 (sin re-dividir — artículos quedan enteros)
 * 5. Compara con los enriched para copiar enriquecimiento donde el texto sea idéntico
 * 6. Marca los chunks que necesitan nuevo enriquecimiento
 *
 * Uso:
 *   node src/scripts/recut_chunks.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

// --- Rutas ---
const V2_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_v2.json');
const ENRICHED_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_enriched.json');
const V3_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_v3.json');
const V3_ENRICHED_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_v3_enriched.json');

// No splitting — articles stay whole (embedding truncates gracefully,
// sparse TF-IDF covers full text, and GPT-5.2 has 128K context)

const dryRun = process.argv.includes('--dry-run');

// --- Detectar si un chunk es "continuación" (corte erróneo) ---
function isContinuation(section) {
    if (!section) return false;
    const trimmed = section.trim();
    // Empieza con "artículo" minúscula (NO "Artículo" mayúscula)
    return /^artículo\s+\d/i.test(trimmed) && trimmed[0] === 'a'; // primera letra minúscula
}

// --- Re-dividir texto largo en sub-chunks ---
function splitLongText(text, section, maxSize, targetSize) {
    if (text.length <= maxSize) {
        return [{ section, text: text.trim() }];
    }

    // Detectar si ya tiene sufijo "(parte N)" → continuar numeración desde N
    const parteMatch = section.match(/^(.*?)\s*\(parte (\d+)\)$/);
    let baseSection, startPartNum;
    if (parteMatch) {
        baseSection = parteMatch[1].trim();
        startPartNum = parseInt(parteMatch[2]);
    } else {
        baseSection = section;
        startPartNum = 1;
    }

    // Intentar dividir: primero por \n\n, si no por apartados numerados, si no por frases
    let segments;

    // Opción 1: Párrafos doble-salto
    const paraSplits = text.split('\n\n');
    if (paraSplits.length > 1 && paraSplits.every(s => s.length < targetSize)) {
        segments = paraSplits;
    } else {
        // Opción 2: Apartados numerados (". 2. ", ". 3. ", etc.)
        segments = text.split(/(?<=\.\s)(?=\d+\.\s)/);
        if (segments.length <= 1) {
            // Opción 3: Dividir por frases (punto seguido de espacio y mayúscula)
            segments = text.split(/(?<=\.\s)(?=[A-ZÁÉÍÓÚÑ])/);
        }
    }

    const parts = [];
    let current = '';
    let partNum = startPartNum;

    for (const seg of segments) {
        if (current.length + seg.length > targetSize && current.trim()) {
            parts.push({
                section: `${baseSection} (parte ${partNum})`,
                text: current.trim()
            });
            partNum++;
            current = seg;
        } else {
            current += seg;
        }
    }

    if (current.trim()) {
        // Si solo 1 parte y partNum == startPartNum == 1, no poner sufijo
        const needsSuffix = parts.length > 0 || startPartNum > 1;
        const suffix = needsSuffix ? ` (parte ${partNum})` : '';
        parts.push({
            section: baseSection + suffix,
            text: current.trim()
        });
    }

    return parts;
}

// --- Normalizar texto para comparación ---
function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function main() {
    console.log('=== RECUT CHUNKS — Corregir cortes erróneos ===\n');

    // 1. Cargar chunks
    console.log('Cargando chunks...');
    const v2 = JSON.parse(fs.readFileSync(V2_PATH, 'utf-8'));
    const enriched = JSON.parse(fs.readFileSync(ENRICHED_PATH, 'utf-8'));
    console.log(`  v2: ${v2.length} chunks`);
    console.log(`  enriched: ${enriched.length} chunks`);

    // 2. Identificar continuaciones
    let continuationCount = 0;
    const continuationIndices = new Set();
    for (let i = 0; i < v2.length; i++) {
        if (isContinuation(v2[i].section)) {
            continuationCount++;
            continuationIndices.add(i);
        }
    }
    console.log(`\n  Continuaciones detectadas: ${continuationCount}`);

    // 3. Fusionar continuaciones con su padre
    const merged = []; // Array de { law, chapter, section, text, mergedFrom: [indices] }
    let parentIdx = null;
    let parentData = null;

    for (let i = 0; i < v2.length; i++) {
        const chunk = v2[i];

        if (isContinuation(chunk.section)) {
            if (parentData && chunk.law === parentData.law) {
                // Fusionar: concatenar texto con separador
                parentData.text += '\n' + chunk.text;
                parentData.mergedFrom.push(i);
                continue;
            }
            // Sin padre válido (¿primer chunk de una ley?) — tratar como chunk normal
            console.warn(`  ⚠ Continuación huérfana en idx ${i}: "${chunk.section.slice(0, 50)}..."`);
        }

        // Flush el padre anterior si existe
        if (parentData) {
            merged.push(parentData);
        }

        // Nuevo padre
        parentIdx = i;
        parentData = {
            law: chunk.law,
            chapter: chunk.chapter || '',
            section: chunk.section,
            text: chunk.text,
            mergedFrom: [i],
        };
    }

    // Flush último
    if (parentData) {
        merged.push(parentData);
    }

    console.log(`  Chunks tras fusión: ${merged.length} (de ${v2.length})`);
    console.log(`  Eliminados: ${v2.length - merged.length}`);

    // 4. Artículos quedan enteros (sin re-dividir)
    const v3 = merged.map(m => ({
        law: m.law,
        chapter: m.chapter,
        section: m.section,
        text: m.text.trim(),
        _mergedFrom: m.mergedFrom,
    }));

    // Stats de tamaños
    const over10k = v3.filter(c => c.text.length > 10000).length;
    const over20k = v3.filter(c => c.text.length > 20000).length;
    const over32k = v3.filter(c => c.text.length > 32000).length;
    console.log(`  Chunks v3 final: ${v3.length} (artículos enteros, sin split)`);
    console.log(`  >10K chars: ${over10k}, >20K: ${over20k}, >32K(embedding trunca): ${over32k}`);

    // 5. Comparar con enriched — buscar chunks idénticos por texto normalizado
    console.log('\n--- Comparación v3 vs enriched ---');

    // Construir mapa: texto normalizado → enrichment
    const enrichmentMap = new Map();
    for (const ec of enriched) {
        const key = normalizeText(ec.text);
        if (!enrichmentMap.has(key)) {
            enrichmentMap.set(key, {
                resumen: ec.resumen,
                palabras_clave: ec.palabras_clave,
                preguntas: ec.preguntas,
            });
        }
    }

    let matchCount = 0;
    let newCount = 0;
    const newChunkIndices = [];

    const v3enriched = v3.map((chunk, idx) => {
        const key = normalizeText(chunk.text);
        const existing = enrichmentMap.get(key);

        const result = {
            law: chunk.law,
            chapter: chunk.chapter,
            section: chunk.section,
            text: chunk.text,
        };

        if (existing) {
            matchCount++;
            result.resumen = existing.resumen;
            result.palabras_clave = existing.palabras_clave;
            result.preguntas = existing.preguntas;
        } else {
            newCount++;
            newChunkIndices.push(idx);
            result.resumen = null; // Pendiente de enriquecer
            result.palabras_clave = null;
            result.preguntas = null;
        }

        return result;
    });

    console.log(`  Chunks con enrichment reutilizado: ${matchCount}`);
    console.log(`  Chunks que necesitan nuevo enrichment: ${newCount}`);

    // 6. Mostrar los chunks afectados (merged)
    console.log('\n--- Chunks fusionados (ejemplos) ---');
    const mergedChunks = merged.filter(m => m.mergedFrom.length > 1);
    console.log(`  Total artículos fusionados: ${mergedChunks.length}`);

    for (const m of mergedChunks.slice(0, 5)) {
        console.log(`\n  LAW: ${m.law.slice(0, 60)}`);
        console.log(`  SECTION: ${m.section.slice(0, 70)}`);
        console.log(`  Merged from: ${m.mergedFrom.length} chunks (idx: ${m.mergedFrom.join(', ')})`);
        console.log(`  Text length: ${m.text.length} chars`);
    }
    if (mergedChunks.length > 5) {
        console.log(`  ... y ${mergedChunks.length - 5} más`);
    }

    // 7. Mostrar Art. 48 específicamente
    console.log('\n--- Verificación: Art. 48 ET ---');
    const art48 = v3.filter(c =>
        c.law.includes('Estatuto de los Trabajadores') &&
        c.section.includes('Artículo 48.') &&
        !c.section.includes('48 bis')
    );
    for (const c of art48) {
        console.log(`  Section: ${c.section.slice(0, 70)}`);
        console.log(`  Text (primeros 200): ${c.text.slice(0, 200)}`);
        console.log(`  Text length: ${c.text.length}`);
        const has19weeks = c.text.includes('diecinueve semanas');
        console.log(`  Contiene "diecinueve semanas": ${has19weeks ? '✅ SÍ' : '❌ NO'}`);
        console.log();
    }

    // 8. Guardar
    if (dryRun) {
        console.log('\n[DRY-RUN] No se guardan archivos.');
        console.log(`  Se generarían ${v3.length} chunks en v3`);
        console.log(`  ${newCount} necesitan enrichment nuevo`);
    } else {
        // Guardar v3 raw (sin enrichment)
        const v3raw = v3.map(c => ({
            law: c.law, chapter: c.chapter, section: c.section, text: c.text
        }));
        fs.writeFileSync(V3_PATH, JSON.stringify(v3raw, null, 2), 'utf-8');
        console.log(`\n  ✅ v3 raw guardado: ${V3_PATH}`);
        console.log(`     ${v3raw.length} chunks, ${(fs.statSync(V3_PATH).size / 1024 / 1024).toFixed(1)} MB`);

        // Guardar v3 enriched (con nulls para los que faltan)
        fs.writeFileSync(V3_ENRICHED_PATH, JSON.stringify(v3enriched, null, 2), 'utf-8');
        console.log(`  ✅ v3 enriched guardado: ${V3_ENRICHED_PATH}`);
        console.log(`     ${matchCount} con enrichment, ${newCount} pendientes`);

        // Guardar lista de índices que necesitan enrichment
        const pendingPath = path.join(__dirname, '..', '..', 'data', 'chunks', 'enrichment_pending.json');
        fs.writeFileSync(pendingPath, JSON.stringify({
            pending_indices: newChunkIndices,
            total_v3: v3.length,
            matched: matchCount,
            needs_enrichment: newCount,
            timestamp: new Date().toISOString(),
        }, null, 2), 'utf-8');
        console.log(`  ✅ Pendientes guardados: ${pendingPath}`);
    }

    console.log('\n=== DONE ===');
}

main();
