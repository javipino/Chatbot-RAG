using System.Text.Json;
using System.Text.Json.Serialization;
using ChatbotRag.Api.Models;

namespace ChatbotRag.Api.Services;

/// <summary>
/// Spanish TF-IDF tokenizer and BM25-style sparse vector builder.
/// Ported from server/services/tfidf.js — must match build_tfidf.js exactly.
/// </summary>
public class TfidfService
{
    private readonly Dictionary<string, TfidfVocabulary> _vocabs = new(StringComparer.OrdinalIgnoreCase);

    // Map from collection name → vocabulary filename
    private static readonly (string Collection, string Filename)[] VocabFiles =
    [
        ("normativa",     "tfidf_vocabulary.json"),
        ("sentencias",    "tfidf_vocabulary_sentencias.json"),
        ("criterios_inss","tfidf_vocabulary_criterios.json"),
    ];

    public TfidfService(ILogger<TfidfService> logger)
    {
        foreach (var (collection, filename) in VocabFiles)
        {
            var candidates = new[]
            {
                Path.Combine(AppContext.BaseDirectory, "Data", filename),
                Path.Combine(AppContext.BaseDirectory, filename),
            };

            foreach (var path in candidates)
            {
                if (!File.Exists(path)) continue;
                try
                {
                    var json = File.ReadAllText(path);
                    var vocab = JsonSerializer.Deserialize<TfidfVocabulary>(json, JsonOptions);
                    if (vocab?.Terms != null)
                    {
                        _vocabs[collection] = vocab;
                        logger.LogInformation("TF-IDF [{Collection}] loaded: {Terms} terms, {Docs} docs",
                            collection, vocab.Terms.Count, vocab.NumDocs);
                    }
                    break;
                }
                catch (Exception ex)
                {
                    logger.LogWarning("Failed to load vocabulary {File}: {Message}", filename, ex.Message);
                }
            }
        }

        if (_vocabs.Count == 0)
            logger.LogWarning("No TF-IDF vocabularies found. Sparse vectors will be null.");
        else
            logger.LogInformation("TF-IDF loaded {Count} vocabularies: {Collections}",
                _vocabs.Count, string.Join(", ", _vocabs.Keys));
    }

    // ── Spanish stopwords ──
    private static readonly HashSet<string> StopwordsEs = new(StringComparer.Ordinal)
    {
        "a","al","algo","algunas","algunos","ante","antes","como","con",
        "contra","cual","cuando","de","del","desde","donde","durante",
        "e","el","ella","ellas","ellos","en","entre","era","esa","esas",
        "ese","eso","esos","esta","estaba","estado","estar","estas","este",
        "esto","estos","fue","ha","hace","hacia","hasta","hay","la","las",
        "le","les","lo","los","mas","me","mi","muy","nada",
        "ni","no","nos","nosotros","nuestro","nuestra","o","otra","otras",
        "otro","otros","para","pero","por","porque","que","quien",
        "se","sea","ser","si","sin","sino","sobre",
        "somos","son","su","sus","te","ti","tiene","todo",
        "toda","todos","todas","tu","tus","un","una","uno","unos","unas",
        "usted","ustedes","ya","yo",
        "dicho","dicha","dichos","dichas","mismo","misma","mismos","mismas",
        "cada","caso","cuyo","cuya","cuyos","cuyas",
        "han","haber","haya","he","hemos",
        "manera","mediante","parte","pues","respecto",
        "sera","seran","sido","siendo","tan","tanto","tres","vez","dos",
    };

    // ── Suffix list for Spanish stemming (longest first) ──
    private static readonly string[] Suffixes =
    [
        "imientos","amiento","imiento","aciones","uciones","idades",
        "amente","adores","ancias","encias","mente","acion","ucion",
        "adora","antes","ibles","istas","idad","ivas","ivos",
        "ador","ante","anza","able","ible","ista","osa","oso",
        "iva","ivo","dad","ion",
        "ando","endo","iendo","ados","idos","adas","idas",
        "ado","ido","ada","ida",
        "ara","era","ira","aran","eran","iran",
        "aba","ian",
        "es","as","os",
        "ar","er","ir",
    ];

    /// <summary>Simple Spanish stemmer — must match build_tfidf.js exactly.</summary>
    public static string StemEs(string word)
    {
        if (word.Length <= 4) return word;
        foreach (var suffix in Suffixes)
        {
            if (word.EndsWith(suffix, StringComparison.Ordinal) && word.Length - suffix.Length >= 3)
                return word[..^suffix.Length];
        }
        if (word.EndsWith('s') && word.Length > 4) return word[..^1];
        return word;
    }

    /// <summary>Tokenize: normalize → split → filter stopwords → stem.</summary>
    public static List<string> Tokenize(string text)
    {
        text = text.ToLowerInvariant()
            .Replace('á', 'a').Replace('à', 'a')
            .Replace('é', 'e').Replace('è', 'e')
            .Replace('í', 'i').Replace('ì', 'i')
            .Replace('ó', 'o').Replace('ò', 'o')
            .Replace('ú', 'u').Replace('ù', 'u').Replace('ü', 'u')
            .Replace("ñ", "ny");

        var tokens = new List<string>();
        var start = -1;
        for (var i = 0; i <= text.Length; i++)
        {
            bool isAlNum = i < text.Length && (char.IsAsciiLetterOrDigit(text[i]));
            if (isAlNum && start < 0) start = i;
            else if (!isAlNum && start >= 0)
            {
                var token = text[start..i];
                start = -1;
                if (token.Length >= 2 && !StopwordsEs.Contains(token))
                    tokens.Add(StemEs(token));
            }
        }
        return tokens;
    }

    /// <summary>Build BM25-style sparse vector from query text using the specified collection vocabulary.</summary>
    public QdrantSparseQuery? BuildSparseVector(string text, string collection)
    {
        if (!_vocabs.TryGetValue(collection, out var vocab)) return null;
        return BuildSparseVectorInternal(text, vocab);
    }

    /// <summary>Build BM25-style sparse vector from query text (defaults to normativa vocabulary).</summary>
    public QdrantSparseQuery? BuildSparseVector(string text)
    {
        var vocab = _vocabs.GetValueOrDefault("normativa");
        if (vocab == null) return null;
        return BuildSparseVectorInternal(text, vocab);
    }

    private static QdrantSparseQuery? BuildSparseVectorInternal(string text, TfidfVocabulary _vocab)
    {

        var tokens = Tokenize(text);
        if (tokens.Count == 0) return null;

        var tf = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var t in tokens)
            tf[t] = tf.TryGetValue(t, out var v) ? v + 1 : 1;

        double k1 = _vocab.Bm25K1;
        double b = _vocab.Bm25B;
        double avgDocLen = _vocab.AvgDocLength;
        int docLen = tokens.Count;

        var indices = new List<int>();
        var values = new List<float>();

        foreach (var (term, count) in tf)
        {
            if (_vocab.Terms.TryGetValue(term, out var entry))
            {
                double tfScore = count / (count + k1 * (1 - b + b * docLen / avgDocLen));
                double score = tfScore * entry.Idf;
                if (score > 0.01)
                {
                    indices.Add(entry.Idx);
                    values.Add((float)Math.Round(score, 4));
                }
            }
        }

        return indices.Count > 0 ? new QdrantSparseQuery { Indices = [.. indices], Values = [.. values] } : null;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };
}

// ── Vocabulary DTOs ──

public class TfidfVocabulary
{
    [JsonPropertyName("num_docs")] public int NumDocs { get; set; }
    [JsonPropertyName("num_terms")] public int NumTerms { get; set; }
    [JsonPropertyName("avg_doc_length")] public double AvgDocLength { get; set; }
    [JsonPropertyName("bm25_k1")] public double Bm25K1 { get; set; }
    [JsonPropertyName("bm25_b")] public double Bm25B { get; set; }
    [JsonPropertyName("terms")] public Dictionary<string, TfidfTermEntry> Terms { get; set; } = [];
}

public class TfidfTermEntry
{
    [JsonPropertyName("idx")] public int Idx { get; set; }
    [JsonPropertyName("idf")] public double Idf { get; set; }
}
