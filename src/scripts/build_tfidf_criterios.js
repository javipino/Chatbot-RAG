/**
 * build_tfidf_criterios.js — Build TF-IDF vocabulary + sparse vectors for criterios_inss collection.
 *
 * Input:  data/chunks/criterios_enriched.json
 * Output:
 *   - data/tfidf_vocabulary_criterios.json
 *   - data/chunks/criterios_sparse_vectors.json
 *
 * Usage:
 *   node src/scripts/build_tfidf_criterios.js
 */

const fs = require('fs');
const path = require('path');

const INPUT_PATH = path.join(__dirname, '..', '..', 'data', 'chunks', 'criterios_enriched.json');
const VOCAB_OUTPUT = path.join(__dirname, '..', '..', 'data', 'tfidf_vocabulary_criterios.json');
const SPARSE_OUTPUT = path.join(__dirname, '..', '..', 'data', 'chunks', 'criterios_sparse_vectors.json');

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
    'dicho', 'dicha', 'dichos', 'dichas', 'mismo', 'misma', 'mismos', 'mismas',
    'cada', 'caso', 'cuyo', 'cuya', 'cuyos', 'cuyas',
    'han', 'haber', 'haya', 'he', 'hemos',
    'manera', 'mediante', 'parte', 'pues', 'respecto',
    'sera', 'seran', 'sido', 'siendo', 'tan', 'tanto', 'tres', 'vez', 'dos',
]);

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
    text = text.replace(/[áà]/g, 'a');
    text = text.replace(/[éè]/g, 'e');
    text = text.replace(/[íì]/g, 'i');
    text = text.replace(/[óò]/g, 'o');
    text = text.replace(/[úùü]/g, 'u');
    text = text.replace(/ñ/g, 'ny');

    const tokens = text.match(/[a-z0-9]+/g) || [];
    return tokens
        .filter(t => !STOPWORDS_ES.has(t) && t.length >= 2)
        .map(t => stemEs(t));
}

function buildDocumentText(item) {
    const parts = [];
    if (item.titulo) parts.push(item.titulo);
    if (item.descripcion) parts.push(item.descripcion);
    if (item.text) parts.push(item.text);
    if (Array.isArray(item.palabras_clave)) parts.push(item.palabras_clave.join(' '));
    if (Array.isArray(item.normativa_refs)) parts.push(item.normativa_refs.join(' '));
    return parts.join(' ');
}

function main() {
    console.log('=== Build Criterios TF-IDF Vocabulary & Sparse Vectors ===\n');

    if (!fs.existsSync(INPUT_PATH)) {
        console.error(`Input not found: ${INPUT_PATH}`);
        process.exit(1);
    }

    const items = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
    const N = items.length;
    console.log(`Loaded ${N} criterios`);

    const docTokens = [];
    const docTokenCounts = [];
    const allDf = new Map();

    for (let i = 0; i < N; i++) {
        const text = buildDocumentText(items[i]);
        const tokens = tokenize(text);
        docTokens.push(tokens);

        const tf = new Map();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }
        docTokenCounts.push(tf);

        for (const term of tf.keys()) {
            allDf.set(term, (allDf.get(term) || 0) + 1);
        }

        if ((i + 1) % 200 === 0) {
            console.log(`  Tokenized ${i + 1}/${N}`);
        }
    }

    console.log(`Raw terms: ${allDf.size}`);

    const minDf = 2;
    const maxDfRatio = 0.8;
    const maxDf = Math.floor(N * maxDfRatio);

    const vocab = {};
    let idx = 0;
    const sortedTerms = [...allDf.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [term, df] of sortedTerms) {
        if (df >= minDf && df <= maxDf) {
            const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);
            vocab[term] = {
                idx,
                idf: Math.round(idf * 10000) / 10000,
            };
            idx++;
        }
    }

    console.log(`Filtered vocabulary: ${Object.keys(vocab).length}`);

    const avgDl = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / N;
    const k1 = 1.2;
    const b = 0.75;

    const sparseVectors = [];

    for (let i = 0; i < N; i++) {
        const tf = docTokenCounts[i];
        const docLen = docTokens[i].length;
        const indices = [];
        const values = [];

        for (const [term, count] of tf.entries()) {
            const entry = vocab[term];
            if (!entry) continue;

            const tfScore = count / (count + k1 * (1 - b + b * docLen / avgDl));
            const score = tfScore * entry.idf;
            if (score > 0.01) {
                indices.push(entry.idx);
                values.push(Math.round(score * 10000) / 10000);
            }
        }

        sparseVectors.push({ indices, values });

        if ((i + 1) % 200 === 0) {
            console.log(`  Sparse ${i + 1}/${N}`);
        }
    }

    const vocabData = {
        version: 1,
        collection: 'criterios_inss',
        num_docs: N,
        num_terms: Object.keys(vocab).length,
        avg_doc_length: Math.round(avgDl * 100) / 100,
        bm25_k1: k1,
        bm25_b: b,
        terms: vocab,
    };

    fs.mkdirSync(path.dirname(VOCAB_OUTPUT), { recursive: true });
    fs.writeFileSync(VOCAB_OUTPUT, JSON.stringify(vocabData), 'utf-8');

    fs.mkdirSync(path.dirname(SPARSE_OUTPUT), { recursive: true });
    fs.writeFileSync(SPARSE_OUTPUT, JSON.stringify(sparseVectors), 'utf-8');

    const vocabKb = (fs.statSync(VOCAB_OUTPUT).size / 1024).toFixed(1);
    const sparseMb = (fs.statSync(SPARSE_OUTPUT).size / (1024 * 1024)).toFixed(1);

    console.log('\n=== Completed ===');
    console.log(`Vocab: ${VOCAB_OUTPUT} (${vocabKb} KB)`);
    console.log(`Sparse: ${SPARSE_OUTPUT} (${sparseMb} MB)`);
}

main();
