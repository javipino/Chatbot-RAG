/**
 * build_tfidf.js — Genera vocabulario TF-IDF y sparse vectors para búsqueda híbrida en Qdrant.
 *
 * Procesa normativa_chunks_enriched.json y produce:
 * 1. data/tfidf_vocabulary.json — Vocabulario con IDF scores (para runtime en la Azure Function)
 * 2. data/chunks/normativa_sparse_vectors.json — Sparse vectors precalculados por chunk
 *
 * Uso:
 *   node src/scripts/build_tfidf.js
 *
 * El vocabulario se copia automáticamente a api/data/tfidf_vocabulary.json para deploy.
 */

const fs = require('fs');
const path = require('path');

// --- Rutas ---
const CHUNKS_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_chunks_enriched.json');
const VOCAB_OUTPUT = path.join(__dirname, '..', '..', 'data', 'tfidf_vocabulary.json');
const SPARSE_OUTPUT = path.join(__dirname, '..', '..', 'data', 'chunks', 'normativa_sparse_vectors.json');
const API_VOCAB_OUTPUT = path.join(__dirname, '..', '..', 'api', 'data', 'tfidf_vocabulary.json');

// --- Stopwords español ---
const STOPWORDS_ES = new Set([
    'a', 'al', 'algo', 'algunas', 'algunos', 'ante', 'antes', 'como', 'con',
    'contra', 'cual', 'cuando', 'de', 'del', 'desde', 'donde', 'durante',
    'e', 'el', 'ella', 'ellas', 'ellos', 'en', 'entre', 'era', 'esa', 'esas',
    'ese', 'eso', 'esos', 'esta', 'estaba', 'estado', 'estar', 'estas', 'este',
    'esto', 'estos', 'fue', 'ha', 'hace', 'hacia', 'hasta', 'hay', 'la', 'las',
    'le', 'les', 'lo', 'los', 'mas', 'me', 'mi', 'muy', 'nada',
    'ni', 'no', 'nos', 'nosotros', 'nuestro', 'nuestra', 'o', 'otra', 'otras',
    'otro', 'otros', 'para', 'pero', 'por', 'porque', 'que', 'quien',
    'se', 'sea', 'ser', 'si', 'sin', 'sino', 'sobre',
    'somos', 'son', 'su', 'sus', 'te', 'ti', 'tiene', 'todo',
    'toda', 'todos', 'todas', 'tu', 'tus', 'un', 'una', 'uno', 'unos', 'unas',
    'usted', 'ustedes', 'ya', 'yo',
    // Frecuentes en texto legal
    'dicho', 'dicha', 'dichos', 'dichas', 'mismo', 'misma', 'mismos', 'mismas',
    'cada', 'caso', 'cuyo', 'cuya', 'cuyos', 'cuyas',
    'han', 'haber', 'haya', 'he', 'hemos',
    'manera', 'mediante', 'parte', 'pues', 'respecto',
    'sera', 'seran', 'sido', 'siendo', 'tan', 'tanto', 'tres', 'vez', 'dos',
]);

// --- Sufijos para stemming básico español ---
const SUFFIXES = [
    'imientos', 'amiento', 'imiento', 'aciones', 'uciones', 'idades',
    'amente', 'adores', 'ancias', 'encias', 'mente', 'acion', 'ucion',
    'adora', 'antes', 'ibles', 'istas', 'idad', 'ivas', 'ivos',
    'ador', 'ante', 'anza', 'able', 'ible', 'ista', 'osa', 'oso',
    'iva', 'ivo', 'dad', 'ion',
    'ando', 'endo', 'iendo', 'ados', 'idos', 'adas', 'idas',
    'ado', 'ido', 'ada', 'ida',
    'ara', 'era', 'ira', 'aran', 'eran', 'iran',
    'aba', 'ian',
    'es', 'as', 'os',
    'ar', 'er', 'ir',
];

function stemEs(word) {
    if (word.length <= 4) return word;
    for (const suffix of SUFFIXES) {
        if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
            return word.slice(0, -suffix.length);
        }
    }
    if (word.endsWith('s') && word.length > 4) {
        return word.slice(0, -1);
    }
    return word;
}

function tokenize(text) {
    text = text.toLowerCase();
    // Normalizar acentos
    text = text.replace(/[áà]/g, 'a');
    text = text.replace(/[éè]/g, 'e');
    text = text.replace(/[íì]/g, 'i');
    text = text.replace(/[óò]/g, 'o');
    text = text.replace(/[úùü]/g, 'u');
    text = text.replace(/ñ/g, 'ny');
    // Extraer tokens alfanuméricos
    const tokens = text.match(/[a-z0-9]+/g) || [];
    // Filtrar stopwords y tokens cortos, aplicar stemming
    return tokens
        .filter(t => !STOPWORDS_ES.has(t) && t.length >= 2)
        .map(t => stemEs(t));
}

function buildDocumentText(chunk) {
    const parts = [];
    if (chunk.section) parts.push(chunk.section);
    if (chunk.text) parts.push(chunk.text);
    if (chunk.resumen) parts.push(chunk.resumen);
    if (chunk.palabras_clave) {
        parts.push(Array.isArray(chunk.palabras_clave) ? chunk.palabras_clave.join(' ') : String(chunk.palabras_clave));
    }
    if (chunk.preguntas) {
        parts.push(Array.isArray(chunk.preguntas) ? chunk.preguntas.join(' ') : String(chunk.preguntas));
    }
    return parts.join(' ');
}

function main() {
    console.log('=== Build TF-IDF Vocabulary & Sparse Vectors ===\n');

    // 1. Cargar chunks
    console.log(`Cargando chunks desde ${CHUNKS_PATH}...`);
    const chunks = JSON.parse(fs.readFileSync(CHUNKS_PATH, 'utf-8'));
    const N = chunks.length;
    console.log(`  ${N} chunks cargados.\n`);

    // 2. Tokenizar todos los documentos
    console.log('Tokenizando documentos...');
    const docTokens = [];      // lista de arrays de tokens
    const docTokenCounts = [];  // Map de term→count por documento
    const allDf = new Map();    // document frequency global

    for (let i = 0; i < N; i++) {
        const text = buildDocumentText(chunks[i]);
        const tokens = tokenize(text);
        docTokens.push(tokens);

        // Contar frecuencias en este documento
        const tf = new Map();
        for (const t of tokens) {
            tf.set(t, (tf.get(t) || 0) + 1);
        }
        docTokenCounts.push(tf);

        // Document frequency: cada término cuenta 1 vez por doc
        for (const term of tf.keys()) {
            allDf.set(term, (allDf.get(term) || 0) + 1);
        }

        if ((i + 1) % 1000 === 0) console.log(`  Tokenizados ${i + 1}/${N}...`);
    }
    console.log(`  Vocabulario bruto: ${allDf.size} términos únicos.\n`);

    // 3. Filtrar vocabulario
    const minDf = 2;
    const maxDfRatio = 0.8;
    const maxDf = Math.floor(N * maxDfRatio);

    const vocab = {};
    let idx = 0;
    const sortedTerms = [...allDf.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [term, df] of sortedTerms) {
        if (df >= minDf && df <= maxDf) {
            // IDF con fórmula Qdrant IDF modifier
            const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);
            vocab[term] = { idx, idf: Math.round(idf * 10000) / 10000 };
            idx++;
        }
    }
    console.log(`Vocabulario filtrado: ${Object.keys(vocab).length} términos (min_df=${minDf}, max_df_ratio=${maxDfRatio}).\n`);

    // 4. Generar sparse vectors
    console.log('Generando sparse vectors...');
    const avgDl = docTokens.reduce((sum, dt) => sum + dt.length, 0) / N;
    const k1 = 1.2;
    const b = 0.75;
    const sparseVectors = [];

    for (let i = 0; i < N; i++) {
        const tf = docTokenCounts[i];
        const docLen = docTokens[i].length;
        const indices = [];
        const values = [];

        for (const [term, count] of tf) {
            if (vocab[term]) {
                const v = vocab[term];
                // TF con saturación BM25-style
                const tfScore = count / (count + k1 * (1 - b + b * docLen / avgDl));
                const score = tfScore * v.idf;
                if (score > 0.01) {
                    indices.push(v.idx);
                    values.push(Math.round(score * 10000) / 10000);
                }
            }
        }

        sparseVectors.push({ indices, values });
        if ((i + 1) % 1000 === 0) console.log(`  Procesados ${i + 1}/${N}...`);
    }
    console.log(`  Sparse vectors generados para ${N} chunks.\n`);

    // 5. Estadísticas
    const nnzCounts = sparseVectors.map(sv => sv.indices.length);
    const avgNnz = nnzCounts.reduce((a, b) => a + b, 0) / N;
    const maxNnz = Math.max(...nnzCounts);
    const minNnz = Math.min(...nnzCounts);
    console.log('Estadísticas sparse vectors:');
    console.log(`  Non-zero values promedio: ${avgNnz.toFixed(1)}`);
    console.log(`  Non-zero values min/max: ${minNnz}/${maxNnz}`);
    console.log(`  Tamaño estimado por punto: ~${(avgNnz * 8).toFixed(0)} bytes\n`);

    // 6. Guardar vocabulario
    const vocabData = {
        version: 1,
        num_docs: N,
        num_terms: Object.keys(vocab).length,
        avg_doc_length: Math.round(avgDl * 100) / 100,
        bm25_k1: k1,
        bm25_b: b,
        terms: vocab, // {term: {idx, idf}}
    };

    fs.mkdirSync(path.dirname(VOCAB_OUTPUT), { recursive: true });
    fs.writeFileSync(VOCAB_OUTPUT, JSON.stringify(vocabData), 'utf-8');
    const sizeKb = (fs.statSync(VOCAB_OUTPUT).size / 1024).toFixed(0);
    console.log(`Vocabulario guardado: ${VOCAB_OUTPUT} (${sizeKb} KB)`);

    // Copiar a api/data/ para deploy
    fs.mkdirSync(path.dirname(API_VOCAB_OUTPUT), { recursive: true });
    fs.writeFileSync(API_VOCAB_OUTPUT, JSON.stringify(vocabData), 'utf-8');
    console.log(`Vocabulario copiado: ${API_VOCAB_OUTPUT}`);

    // 7. Guardar sparse vectors
    fs.mkdirSync(path.dirname(SPARSE_OUTPUT), { recursive: true });
    fs.writeFileSync(SPARSE_OUTPUT, JSON.stringify(sparseVectors), 'utf-8');
    const sizeMb = (fs.statSync(SPARSE_OUTPUT).size / (1024 * 1024)).toFixed(1);
    console.log(`Sparse vectors guardados: ${SPARSE_OUTPUT} (${sizeMb} MB)\n`);

    console.log('=== Completado ===');
    console.log('Siguiente paso: node src/scripts/upload_to_qdrant.js');
}

main();
