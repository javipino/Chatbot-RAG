// ── TF-IDF Tokenizer & Sparse Vector Builder ──

const fs = require('fs');
const path = require('path');

// ── Spanish stopwords ──
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

// ── Suffix list for Spanish stemming ──
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

/**
 * Simple Spanish stemmer — must match build_tfidf.js exactly
 */
function stemEs(word) {
    if (word.length <= 4) return word;
    for (const suffix of SUFFIXES) {
        if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
            return word.slice(0, -suffix.length);
        }
    }
    if (word.endsWith('s') && word.length > 4) return word.slice(0, -1);
    return word;
}

/**
 * Tokenize text: normalize → split → filter stopwords → stem
 */
function tokenize(text) {
    text = text.toLowerCase()
        .replace(/[áà]/g, 'a').replace(/[éè]/g, 'e')
        .replace(/[íì]/g, 'i').replace(/[óò]/g, 'o')
        .replace(/[úùü]/g, 'u').replace(/ñ/g, 'ny');
    return (text.match(/[a-z0-9]+/g) || [])
        .filter(t => !STOPWORDS_ES.has(t) && t.length >= 2)
        .map(t => stemEs(t));
}

// ── Vocabulary (lazy loaded) ──
let _vocab = null;

function loadVocabulary() {
    if (_vocab) return _vocab;
    try {
        const vocabPath = path.join(__dirname, '..', 'data', 'tfidf_vocabulary.json');
        _vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'));
        return _vocab;
    } catch (e) {
        console.warn('Warning: Could not load TF-IDF vocabulary:', e.message);
        return null;
    }
}

/**
 * Build BM25-style sparse vector from query text
 * @param {string} text
 * @returns {{ indices: number[], values: number[] } | null}
 */
function buildSparseVector(text) {
    const vocab = loadVocabulary();
    if (!vocab) return null;

    const tokens = tokenize(text);
    if (!tokens.length) return null;

    const tf = {};
    for (const t of tokens) {
        tf[t] = (tf[t] || 0) + 1;
    }

    const indices = [];
    const values = [];
    const { terms, avg_doc_length, bm25_k1: k1, bm25_b: b } = vocab;

    for (const [term, count] of Object.entries(tf)) {
        if (terms[term]) {
            const { idx, idf } = terms[term];
            const tfScore = count / (count + k1 * (1 - b + b * tokens.length / avg_doc_length));
            const score = tfScore * idf;
            if (score > 0.01) {
                indices.push(idx);
                values.push(Math.round(score * 10000) / 10000);
            }
        }
    }

    return indices.length > 0 ? { indices, values } : null;
}

module.exports = { tokenize, stemEs, buildSparseVector, loadVocabulary };
