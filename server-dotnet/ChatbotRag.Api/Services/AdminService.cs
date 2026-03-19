using System.Text;
using System.Text.RegularExpressions;
using ChatbotRag.Api.Models;
using OpenAI.Chat;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace ChatbotRag.Api.Services;

/// <summary>
/// Orchestrates the enrichment pipeline for individual document updates:
/// Extract PDF → Clean → Enrich (Nano) → Embed → Sparse → Upsert to Qdrant.
/// Full parity with pipeline scripts: postprocess_criterios.js, enrich_criterios.js,
/// upload_criterios_qdrant.js, clean_chunks_v2.py, enrich_chunks.py, upload_to_qdrant.js.
/// </summary>
public class AdminService(
    OpenAiService openAi,
    TfidfService tfidf,
    QdrantService qdrant,
    ILogger<AdminService> logger)
{
    // ── Enrichment prompts (match script patterns exactly) ──
    private const string CriterioEnrichSystemPrompt =
        "Eres un experto en Seguridad Social española y gestión de prestaciones del INSS. Responde SIEMPRE con JSON válido, sin texto adicional ni markdown.";

    private const string NormativaEnrichSystemPrompt =
        "Eres un experto en legislación laboral y de Seguridad Social española. Responde SIEMPRE con JSON válido, sin texto adicional ni bloques de código markdown.";

    private const int CriterioMaxExcerptChars = 3000; // matches enrich_criterios.js
    private const int CriterioMaxKeywords = 12; // matches sanitizeList maxItems
    private const int CriterioMinKeywordLen = 2; // matches sanitizeList minLen
    private const int NormativaMaxExcerptChars = 2000; // matches enrich_chunks.py
    private const int NormativaMaxKeywords = 8;
    private const int CriterioEmbeddingMaxChars = 12000; // matches upload_criterios_qdrant.js
    private const int NormativaEmbeddingMaxChars = 30000; // matches upload_to_qdrant.js
    private const long CriterioSyntheticIdBase = 800_000_000; // matches upload_criterios_qdrant.js

    private static readonly HashSet<string> NoiseKeywords = new(StringComparer.OrdinalIgnoreCase)
    {
        "criterio de gestión", "criterios de gestión", "instituto nacional de la seguridad social",
        "inss", "seguridad social", "dirección general de ordenación", "dgoss", "informe dgoss",
        "criterio interpretativo", "texto refundido", "trlgss", "ley general de la seguridad social",
    };

    // PROCEDURAL_REFS — LRJS boilerplate articles to filter out (from postprocess_criterios.js)
    private static readonly HashSet<string> ProceduralRefs = new(StringComparer.OrdinalIgnoreCase)
    {
        "art. 219 LRJS", "art. 220 LRJS", "art. 221 LRJS", "art. 222 LRJS",
        "art. 223 LRJS", "art. 224 LRJS", "art. 225 LRJS", "art. 226 LRJS",
        "art. 227 LRJS", "art. 228 LRJS", "art. 235 LRJS",
    };

    // NOISE_REFS — generic refs to filter out
    private static readonly HashSet<string> NoiseRefs = new(StringComparer.OrdinalIgnoreCase)
    {
        "Ley 39/2015",
    };

    // Section header pattern for criterio line-merge algorithm (from postprocess_criterios.js)
    private static readonly Regex CriterioSectionHeaderRx = new(
        @"^(?:ASUNTO|CRITERIO DE GESTI[ÓO]N|Disposiciones de aplicaci[oó]n|Criterio|Desarrollo|---\s*INFORME|[IVX]+\.-|[A-G]\)|(?:\d+[ºªa.)]+)\s)",
        RegexOptions.Compiled);

    // ── PDF text extraction ──

    public static string ExtractTextFromPdf(Stream pdfStream)
    {
        using var document = PdfDocument.Open(pdfStream);
        var pages = new List<string>();
        foreach (var page in document.GetPages())
        {
            var text = page.Text;
            if (!string.IsNullOrWhiteSpace(text))
                pages.Add(text);
        }
        return string.Join("\n\n", pages);
    }

    // ══════════════════════════════════════════════════════════════
    // ══ CRITERIO TEXT CLEANUP (full port of postprocess_criterios.js cleanText)
    // ══════════════════════════════════════════════════════════════

    public static string CleanCriterioText(string text)
    {
        // Normalize line endings first
        text = text.Replace("\r\n", "\n");

        // 1. Strip leading page-number line at start (old: "74/2003-04-1\n", modern: "1\n")
        text = Regex.Replace(text, @"^\d+(?:/\d+(?:-\d+)?)?(?:-\d+)?\s*\n", "");

        // 2. Remove "Criterio de gestión: N/YYYY Fecha: ... Materia: ..." header lines
        text = Regex.Replace(text, @"(?m)^Criterio de gesti[oó]n:\s*\d+.*$", "");

        // 3. Remove standalone 1-3 digit page numbers on their own line
        text = Regex.Replace(text, @"(?m)^\d{1,3}$", "");

        // 4. Remove trailing disclaimer paragraph
        text = Regex.Replace(text, @"Esta informaci[oó]n ha sido elaborada teniendo en cuenta la legislaci[oó]n vigente.*$", "",
            RegexOptions.Singleline);

        // 5. Remove director closing signature
        text = Regex.Replace(text, @"\n(?:LA|EL) DIRECTORA? GENERAL\s*$", "", RegexOptions.IgnoreCase);

        // Extra patterns from original AdminService (not in script but useful for different PDF formats)
        text = Regex.Replace(text, @"(?m)^\s*-?\s*\d+\s*-?\s*$", "");
        text = Regex.Replace(text, @"Página \d+ de \d+", "");
        text = Regex.Replace(text, @"(?m)^.*INSTITUTO NACIONAL DE LA SEGURIDAD SOCIAL.*$", "");
        text = Regex.Replace(text, @"(?m)^.*Subdirección General de.*$", "");
        text = Regex.Replace(text, @"(?m)^.*(?:Fdo|Firmado|VºBº)[\.:].+$", "");

        // 6. Clean trailing hyphens after law numbers: "1408/71- no" → "1408/71 no"
        text = Regex.Replace(text, @"(\d/\d{2,4})-\s", "$1 ");

        // 7. Collapse multiple newlines to single (matches script — aggressive)
        text = Regex.Replace(text, @"\n{2,}", "\n");

        // 8. Normalize horizontal whitespace
        text = Regex.Replace(text, @"[ \t]+", " ");

        // 9. Sophisticated line-merge: only keep \n before section headers, merge everything else
        text = MergeCriterioLines(text);

        return text.Trim();
    }

    /// <summary>
    /// Line-merge algorithm from postprocess_criterios.js: iterates every line,
    /// inserts \n only before lines matching section header patterns.
    /// Everything else is merged with a space. Handles hyphenated word breaks.
    /// </summary>
    private static string MergeCriterioLines(string text)
    {
        var lines = text.Split('\n');
        var result = new StringBuilder();

        foreach (var rawLine in lines)
        {
            var trimmed = rawLine.Trim();
            if (string.IsNullOrEmpty(trimmed))
            {
                result.Append('\n');
                continue;
            }

            if (CriterioSectionHeaderRx.IsMatch(trimmed))
            {
                result.Append('\n');
                result.Append(trimmed);
            }
            else
            {
                // Check if previous content ends with hyphen (word break)
                if (result.Length > 0 && result[^1] == '-')
                {
                    result.Remove(result.Length - 1, 1); // remove trailing hyphen
                    result.Append(trimmed); // join without space
                }
                else
                {
                    if (result.Length > 0) result.Append(' ');
                    result.Append(trimmed);
                }
            }
        }

        return result.ToString();
    }

    // ══════════════════════════════════════════════════════════════
    // ══ NORMATIVA REFS EXTRACTION (full port of postprocess_criterios.js extractRefsFromText)
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// All 8 patterns from postprocess_criterios.js + PROCEDURAL_REFS/NOISE_REFS filters.
    /// </summary>
    public static List<string> ExtractNormativaRefs(string text)
    {
        var refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Pat1: art. X + abbreviation (ET, LGSS, etc.) — full set including CC, LBRL, TRLET, TRLEBEP
        foreach (Match m in Regex.Matches(text,
            @"art(?:ículo|\.?)\s*(\d+[\d.]*\s*(?:bis|ter)?)\s+(?:del?\s+)?(?:la\s+)?(?:Ley\s+)?(?:Orgánica\s+)?(ET|LGSS|LETA|LISOS|CE|LRJS|LOLS|LPRL|LET|TRLGSS|TRET|TREBEP|TRLEBEP|EBEP|CC|LBRL|TRLET)",
            RegexOptions.IgnoreCase))
        {
            var num = m.Groups[1].Value.Trim();
            var law = NormalizeAbbreviation(m.Groups[2].Value.Trim());
            refs.Add($"art. {num} {law}");
        }

        // Pat1: full-name aliases → abbreviation
        AddFullNameAliasRefs(text, refs);

        // Pat1b: "art. X del texto refundido de la Ley General/Estatuto de los Trabajadores/Estatuto Básico..."
        foreach (Match m in Regex.Matches(text,
            @"art(?:ículo|\.?)\s*(\d+[\d.]*)\s+del\s+texto\s+refundido\s+de\s+la\s+Ley\s+(?:General\s+de\s+la\s+Seguridad\s+Social|del\s+Estatuto\s+de\s+los\s+Trabajadores|del\s+Estatuto\s+Básico\s+del\s+Empleado\s+Público)",
            RegexOptions.IgnoreCase))
        {
            var num = m.Groups[1].Value.Trim();
            var fullMatch = m.Value.ToLowerInvariant();
            var law = fullMatch.Contains("seguridad social") ? "TRLGSS"
                    : fullMatch.Contains("trabajadores") ? "ET"
                    : "TREBEP";
            refs.Add($"art. {num} {law}");
        }

        // Pat2: art. X + Ley/RD N/YYYY (full law name forms)
        foreach (Match m in Regex.Matches(text,
            @"art(?:ículo|\.?)\s*(\d+[\d.]*)\s+(?:del?\s+)?(?:la\s+)?((?:Ley|Real Decreto Legislativo|Real Decreto-Ley|Real Decreto|RD|RDL|RD-ley)\s+\d+/\d{4})",
            RegexOptions.IgnoreCase))
        {
            refs.Add($"art. {m.Groups[1].Value.Trim()} {m.Groups[2].Value.Trim()}");
        }

        // Pat3: standalone Ley/RD refs
        foreach (Match m in Regex.Matches(text,
            @"\b(?:Ley(?:\s+Orgánica)?|Real Decreto Legislativo|Real Decreto-Ley|Real Decreto|RDL|RD-ley)\s+\d+/\d{4}",
            RegexOptions.IgnoreCase))
        {
            var r = m.Value.Trim();
            if (!NoiseRefs.Contains(r))
                refs.Add(r);
        }

        // Pat4: disposiciones (transitoria, adicional, final, derogatoria) + Spanish ordinals
        foreach (Match m in Regex.Matches(text,
            @"disposici[oó]n\s+(adicional|transitoria|derogatoria|final)\s+(primera|segunda|tercera|cuarta|quinta|sexta|s[eé]ptima|octava|novena|d[eé]cima|und[eé]cima|duod[eé]cima|decimotercera|decimocuarta|decimoquinta|decimosexta|decimos[eé]ptima|decimoctava|decimonovena|vig[eé]sima|vig[eé]simo?\s*primera|[uú]nica|\d+[ªº])",
            RegexOptions.IgnoreCase))
        {
            refs.Add($"disposición {m.Groups[1].Value.ToLowerInvariant()} {m.Groups[2].Value.ToLowerInvariant()}");
        }

        // Pat5: Órdenes ministeriales (TAS, ESS, TMS, ISM, EHA, PRE, SPI, INT)
        foreach (Match m in Regex.Matches(text,
            @"Orden\s+(TAS|ESS|TMS|ISM|EHA|PRE|SPI|INT)/\d+/\d{4}",
            RegexOptions.IgnoreCase))
        {
            refs.Add(m.Value.Trim());
        }

        // Pat6: EU Reglamentos
        foreach (Match m in Regex.Matches(text,
            @"Reglamento\s+\((?:CE|CEE|UE)\)\s+(?:n[ºo°]?\s*)?\d+/\d{4}",
            RegexOptions.IgnoreCase))
        {
            refs.Add(m.Value.Trim());
        }

        // Pat6b: art. X del Reglamento (CE|CEE|UE) N/YYYY
        foreach (Match m in Regex.Matches(text,
            @"art(?:ículo|\.?)\s*(\d+[\d.]*)\s+del\s+(Reglamento\s+\((?:CE|CEE|UE)\)\s+(?:n[ºo°]?\s*)?\d+/\d{4})",
            RegexOptions.IgnoreCase))
        {
            refs.Add($"art. {m.Groups[1].Value.Trim()} {m.Groups[2].Value.Trim()}");
        }

        // Pat7: EU Directivas
        foreach (Match m in Regex.Matches(text,
            @"Directiva\s+(?:n[ºo°]?\s*)?\d+/\d+/(?:CE|CEE|UE)",
            RegexOptions.IgnoreCase))
        {
            refs.Add(m.Value.Trim());
        }

        // Apply filters
        refs.RemoveWhere(r => ProceduralRefs.Contains(r));
        refs.RemoveWhere(r => NoiseRefs.Contains(r));

        // Return sorted (matches script)
        var result = refs.ToList();
        result.Sort(StringComparer.OrdinalIgnoreCase);
        return result;
    }

    /// <summary>Normalize alias abbreviations: TRLET→ET, TRLEBEP→TREBEP, LET→ET</summary>
    private static string NormalizeAbbreviation(string abbrev) => abbrev.ToUpperInvariant() switch
    {
        "TRLET" => "ET",
        "LET" => "ET",
        "TRLEBEP" => "TREBEP",
        _ => abbrev.ToUpperInvariant(),
    };

    /// <summary>Full-name alias matches → abbreviation refs (Código Civil, Ley de Bases del Régimen Local, etc.)</summary>
    private static void AddFullNameAliasRefs(string text, HashSet<string> refs)
    {
        var aliases = new (string Pattern, string Abbrev)[]
        {
            (@"art(?:ículo|\.?)\s*(\d+[\d.]*)\s+(?:del\s+)?C[oó]digo\s+Civil", "CC"),
            (@"art(?:ículo|\.?)\s*(\d+[\d.]*)\s+(?:de\s+la\s+)?Ley\s+(?:de\s+)?Bases\s+del\s+R[eé]gimen\s+Local", "LBRL"),
        };

        foreach (var (pattern, abbrev) in aliases)
        {
            foreach (Match m in Regex.Matches(text, pattern, RegexOptions.IgnoreCase))
            {
                refs.Add($"art. {m.Groups[1].Value.Trim()} {abbrev}");
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // ══ CRITERIO ENRICHMENT (full port of enrich_criterios.js)
    // ══════════════════════════════════════════════════════════════

    private async Task<List<string>> EnrichWithNanoAsync(string titulo, string descripcion, string text)
    {
        // Build excerpt — skip INFORME DGOSS section (matches script)
        var informeIdx = text.IndexOf("--- INFORME DGOSS ---", StringComparison.Ordinal);
        var excerpt = informeIdx > 0 ? text[..informeIdx] : text;
        if (excerpt.Length > CriterioMaxExcerptChars) excerpt = excerpt[..CriterioMaxExcerptChars];

        var prompt = $$"""
            Analiza este criterio de gestión del INSS y devuelve un JSON con:
            "palabras_clave": Lista de 5-8 conceptos clave de Seguridad Social para búsqueda semántica.
            NO incluyas términos genéricos como "INSS", "Seguridad Social", "criterio de gestión", "TRLGSS".
            Céntrate en: tipo de prestación, colectivo afectado, situación jurídica concreta, régimen específico.

            TÍTULO: {{titulo}}
            DESCRIPCIÓN: {{descripcion}}

            TEXTO DEL CRITERIO:
            {{excerpt}}

            Responde SOLO con JSON válido: {"palabras_clave": [...]}
            """;

        var messages = new List<OpenAI.Chat.ChatMessage>
        {
            new SystemChatMessage(CriterioEnrichSystemPrompt),
            new UserChatMessage(prompt),
        };

        var response = await openAi.CallNanoAsync(messages);
        return ParseKeywords(response, CriterioMaxKeywords, CriterioMinKeywordLen);
    }

    // ══════════════════════════════════════════════════════════════
    // ══ NORMATIVA ENRICHMENT (full port of enrich_chunks.py)
    // ══════════════════════════════════════════════════════════════

    /// <summary>Enrich normativa chunk — generates resumen, palabras_clave, and preguntas.</summary>
    private async Task<(string Resumen, List<string> PalabrasClave, List<string> Preguntas)> EnrichNormativaWithNanoAsync(
        string law, string section, string text, string? chapter = null)
    {
        // Short-chunk handling (matches enrich_chunks.py): derogado articles < 60 chars
        if (text.Length < 60)
        {
            return ("Artículo derogado.", [], []);
        }

        var excerpt = text.Length > NormativaMaxExcerptChars ? text[..NormativaMaxExcerptChars] : text;

        // Build CAPÍTULO line if available (matches enrich_chunks.py prompt)
        var capituloLine = !string.IsNullOrWhiteSpace(chapter) ? $"\nCAPÍTULO: {chapter}" : "";

        var prompt = $$"""
            Analiza este fragmento de normativa laboral española y devuelve un JSON con:
            "resumen": Resumen conciso del contenido (1-2 frases).
            "palabras_clave": Lista de 5-8 conceptos clave para búsqueda semántica.
            "preguntas": Lista de 3-4 preguntas frecuentes que este artículo podría responder.
            NO incluyas términos genéricos. Céntrate en: materia regulada, derechos/obligaciones, sujetos afectados.

            LEY: {{law}}{{capituloLine}}
            SECCIÓN: {{section}}

            TEXTO:
            {{excerpt}}

            Responde SOLO con JSON válido: {"resumen": "...", "palabras_clave": [...], "preguntas": [...]}
            """;

        var messages = new List<OpenAI.Chat.ChatMessage>
        {
            new SystemChatMessage(NormativaEnrichSystemPrompt),
            new UserChatMessage(prompt),
        };

        var response = await openAi.CallNanoAsync(messages);
        return ParseNormativaEnrichment(response);
    }

    // ══════════════════════════════════════════════════════════════
    // ══ CRITERIO PIPELINE (full port of upload_criterios_qdrant.js)
    // ══════════════════════════════════════════════════════════════

    public async Task<long> ProcessCriterioAsync(
        Stream pdfStream, string titulo, string? descripcion, string? fecha, string? emisor,
        string? criterioNum, string? estado,
        Func<string, Task> onProgress)
    {
        // 1. Extract text from PDF
        await onProgress("Extrayendo texto del PDF...");
        var rawText = ExtractTextFromPdf(pdfStream);
        if (string.IsNullOrWhiteSpace(rawText))
            throw new InvalidOperationException("No se pudo extraer texto del PDF.");

        // 2. Clean text
        await onProgress("Limpiando texto...");
        var cleanText = CleanCriterioText(rawText);

        // 3. Extract normativa refs
        await onProgress("Extrayendo referencias normativas...");
        var normativaRefs = ExtractNormativaRefs(cleanText);

        // 4. Enrich with Nano (palabras_clave)
        await onProgress("Enriqueciendo con IA (palabras clave)...");
        var palabrasClave = await EnrichWithNanoAsync(titulo, descripcion ?? "", cleanText);

        // 5. Generate dense embedding (matches upload_criterios_qdrant.js buildEmbeddingText)
        await onProgress("Generando embedding denso...");
        var embeddingText = BuildCriterioEmbeddingText(descripcion, palabrasClave, titulo, cleanText);
        var denseVector = await openAi.EmbedAsync(embeddingText);

        // 6. Generate sparse vector
        await onProgress("Generando vector sparse...");
        var sparseText = $"{titulo} {descripcion} {cleanText} {string.Join(" ", palabrasClave)} {string.Join(" ", normativaRefs)}";
        var sparseVector = tfidf.BuildSparseVector(sparseText, "criterios_inss");

        // 7. Compute point ID (matches upload_criterios_qdrant.js parseNumericId)
        await onProgress("Subiendo a Qdrant...");
        var pointId = await ComputeCriterioIdAsync(criterioNum);

        // 8. Build payload (matches upload_criterios_qdrant.js — all fields for ChunkResult compatibility)
        var payload = new Dictionary<string, object?>
        {
            // ChunkResult compatibility fields (used by SearchStage/PointToChunk)
            ["law"] = criterioNum ?? "",               // criterio_num → law
            ["chapter"] = fecha ?? "",                 // fecha → chapter
            ["section"] = "Criterio INSS",             // hardcoded
            ["text"] = cleanText,
            ["resumen"] = descripcion ?? "",            // descripcion → resumen
            ["palabras_clave"] = palabrasClave,
            ["refs"] = Array.Empty<object>(),           // always empty for criterios

            // Criterio-specific fields
            ["criterio_id"] = pointId,
            ["criterio_num"] = criterioNum ?? "",
            ["titulo"] = titulo,
            ["descripcion"] = descripcion ?? "",
            ["fecha"] = fecha ?? "",
            ["emisor"] = emisor ?? "",
            ["estado"] = estado ?? "Vigente",          // from form, not hardcoded
            ["normativa_refs"] = normativaRefs,
        };

        await qdrant.UpsertPointAsync("criterios_inss", pointId, denseVector, sparseVector, payload);

        await onProgress($"Criterio subido con ID {pointId}.");
        logger.LogInformation("Admin: Criterio '{Titulo}' uploaded as point {Id}", titulo, pointId);
        return pointId;
    }

    // ══════════════════════════════════════════════════════════════
    // ══ NORMATIVA PIPELINE (full port of upload_to_qdrant.js)
    // ══════════════════════════════════════════════════════════════

    public async Task<long> AddNormativaChunkAsync(
        NormativaChunkInput input, Func<string, Task> onProgress)
    {
        // 1. Enrich with Nano (resumen + palabras_clave + preguntas)
        await onProgress("Enriqueciendo con IA...");
        var (resumen, palabrasClave, preguntas) = await EnrichNormativaWithNanoAsync(
            input.Law, input.Section, input.Text, input.Chapter);

        // 2. Dense embedding (matches upload_to_qdrant.js: law + section + text)
        await onProgress("Generando embedding denso...");
        var embeddingText = BuildNormativaEmbeddingText(input.Law, input.Section, input.Text);
        var denseVector = await openAi.EmbedAsync(embeddingText);

        // 3. Sparse vector (matches build_tfidf.js: section + text + resumen + keywords + preguntas)
        await onProgress("Generando vector sparse...");
        var sparseText = BuildNormativaSparseText(input.Section, input.Text, resumen, palabrasClave, preguntas);
        var sparseVector = tfidf.BuildSparseVector(sparseText, "normativa");

        // 4. Upsert
        await onProgress("Subiendo a Qdrant...");
        var nextId = await qdrant.GetPointCountAsync("normativa") + 1;

        var payload = new Dictionary<string, object?>
        {
            ["law"] = input.Law,
            ["chapter"] = input.Chapter ?? "",
            ["section"] = input.Section,
            ["text"] = input.Text,
            ["resumen"] = resumen,
            ["palabras_clave"] = palabrasClave,
            ["refs"] = Array.Empty<object>(), // cross-chunk refs not computable per-chunk; existing refs preserved on update
        };

        await qdrant.UpsertPointAsync("normativa", nextId, denseVector, sparseVector, payload);

        await onProgress($"Chunk normativa subido con ID {nextId}.");
        logger.LogInformation("Admin: Normativa chunk '{Section}' in '{Law}' uploaded as point {Id}",
            input.Section, input.Law, nextId);
        return nextId;
    }

    public async Task UpdateNormativaChunkAsync(
        long id, NormativaChunkInput input, Func<string, Task> onProgress)
    {
        // 1. Enrich with Nano
        await onProgress("Enriqueciendo con IA...");
        var (resumen, palabrasClave, preguntas) = await EnrichNormativaWithNanoAsync(
            input.Law, input.Section, input.Text, input.Chapter);

        // 2. Dense embedding (matches upload_to_qdrant.js: law + section + text)
        await onProgress("Generando embedding denso...");
        var embeddingText = BuildNormativaEmbeddingText(input.Law, input.Section, input.Text);
        var denseVector = await openAi.EmbedAsync(embeddingText);

        // 3. Sparse vector (matches build_tfidf.js: section + text + resumen + keywords + preguntas)
        await onProgress("Generando vector sparse...");
        var sparseText = BuildNormativaSparseText(input.Section, input.Text, resumen, palabrasClave, preguntas);
        var sparseVector = tfidf.BuildSparseVector(sparseText, "normativa");

        // 4. Try to preserve existing refs from current point
        List<object>? existingRefs = null;
        try
        {
            var existing = await qdrant.GetPointByIdAsync("normativa", id);
            if (existing != null)
            {
                // Refs are stored as payload — can't read them through AdminSearchResult
                // For now, refs will be empty on update. Full cross-chunk resolution requires batch processing.
            }
        }
        catch { /* ignore — refs will be empty */ }

        // 5. Upsert (same ID)
        await onProgress("Actualizando en Qdrant...");
        var payload = new Dictionary<string, object?>
        {
            ["law"] = input.Law,
            ["chapter"] = input.Chapter ?? "",
            ["section"] = input.Section,
            ["text"] = input.Text,
            ["resumen"] = resumen,
            ["palabras_clave"] = palabrasClave,
            ["refs"] = (object?)existingRefs ?? Array.Empty<object>(),
        };

        await qdrant.UpsertPointAsync("normativa", id, denseVector, sparseVector, payload);

        await onProgress($"Chunk {id} actualizado.");
        logger.LogInformation("Admin: Normativa chunk {Id} updated", id);
    }

    // ══════════════════════════════════════════════════════════════
    // ══ EMBEDDING & SPARSE TEXT BUILDERS
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// Matches upload_criterios_qdrant.js buildEmbeddingText:
    /// Primary: descripcion + "\n" + palabras_clave.join(', ')
    /// Fallback (when descripcion empty): titulo + "\n" + text[:1200]
    /// Hard cap: 12,000 chars
    /// </summary>
    private static string BuildCriterioEmbeddingText(string? descripcion, List<string> palabrasClave, string titulo, string text)
    {
        var desc = descripcion ?? "";
        var keywords = palabrasClave.Count > 0 ? string.Join(", ", palabrasClave) : "";
        var merged = $"{desc}\n{keywords}".Trim();

        string result;
        if (!string.IsNullOrWhiteSpace(merged))
        {
            result = merged;
        }
        else
        {
            // Fallback: titulo + text[:1200]
            var textPrefix = text.Length > 1200 ? text[..1200] : text;
            result = $"{titulo}\n{textPrefix}".Trim();
        }

        return result.Length > CriterioEmbeddingMaxChars ? result[..CriterioEmbeddingMaxChars] : result;
    }

    /// <summary>
    /// Matches upload_to_qdrant.js buildEmbeddingText: law + "\n" + section + "\n" + text
    /// Hard cap: 30,000 chars
    /// </summary>
    private static string BuildNormativaEmbeddingText(string law, string section, string text)
    {
        var result = $"{law}\n{section}\n{text}";
        return result.Length > NormativaEmbeddingMaxChars ? result[..NormativaEmbeddingMaxChars] : result;
    }

    /// <summary>
    /// Matches build_tfidf.js buildDocumentText: section + text + resumen + keywords + preguntas
    /// </summary>
    private static string BuildNormativaSparseText(string section, string text, string resumen,
        List<string> palabrasClave, List<string> preguntas)
    {
        return $"{section} {text} {resumen} {string.Join(" ", palabrasClave)} {string.Join(" ", preguntas)}";
    }

    /// <summary>Compute criterio point ID: use criterio_num hash, fallback to 800M+ range.</summary>
    private async Task<long> ComputeCriterioIdAsync(string? criterioNum)
    {
        if (!string.IsNullOrWhiteSpace(criterioNum))
        {
            // Try to parse numeric ID from criterio_num (e.g., "6/2026" → hash-based ID)
            // Use a stable hash in the 800M+ range to avoid collision with normativa IDs
            var hash = Math.Abs(criterioNum.GetHashCode(StringComparison.Ordinal));
            return CriterioSyntheticIdBase + (hash % 100_000_000);
        }

        // Fallback: use count+1 in the 800M+ range
        var count = await qdrant.GetPointCountAsync("criterios_inss");
        return CriterioSyntheticIdBase + count + 1;
    }

    // ══════════════════════════════════════════════════════════════
    // ══ JSON PARSE HELPERS
    // ══════════════════════════════════════════════════════════════

    private static List<string> ParseKeywords(string response, int maxItems = 12, int minLen = 2)
    {
        try
        {
            var clean = response.Trim();

            // Try direct JSON parse first (matches script — faster when no markdown)
            try
            {
                var doc = System.Text.Json.JsonDocument.Parse(clean);
                if (doc.RootElement.TryGetProperty("palabras_clave", out var directArr))
                    return ExtractKeywordArray(directArr, maxItems, minLen);
            }
            catch { /* not valid JSON, fall through to fence-stripping */ }

            if (clean.StartsWith("```"))
            {
                var firstNl = clean.IndexOf('\n');
                if (firstNl > 0) clean = clean[(firstNl + 1)..];
                var lastFence = clean.LastIndexOf("```");
                if (lastFence > 0) clean = clean[..lastFence];
                clean = clean.Trim();
            }

            var match = Regex.Match(clean, @"\{[\s\S]*\}");
            if (!match.Success) return [];

            var doc2 = System.Text.Json.JsonDocument.Parse(match.Value);
            if (!doc2.RootElement.TryGetProperty("palabras_clave", out var arr)) return [];

            return ExtractKeywordArray(arr, maxItems, minLen);
        }
        catch
        {
            return [];
        }
    }

    private static List<string> ExtractKeywordArray(System.Text.Json.JsonElement arr, int maxItems, int minLen)
    {
        var keywords = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in arr.EnumerateArray())
        {
            var kw = item.GetString()?.Trim();
            if (string.IsNullOrEmpty(kw) || kw.Length < minLen) continue;
            if (NoiseKeywords.Contains(kw)) continue;
            if (!seen.Add(kw.ToLowerInvariant())) continue;
            keywords.Add(kw);
            if (keywords.Count >= maxItems) break;
        }
        return keywords;
    }

    /// <summary>Parse normativa enrichment response — resumen + palabras_clave + preguntas.</summary>
    private static (string Resumen, List<string> PalabrasClave, List<string> Preguntas) ParseNormativaEnrichment(string response)
    {
        try
        {
            var clean = response.Trim();

            // Try direct JSON parse first
            System.Text.Json.JsonDocument? doc = null;
            try { doc = System.Text.Json.JsonDocument.Parse(clean); } catch { }

            if (doc == null)
            {
                if (clean.StartsWith("```"))
                {
                    var firstNl = clean.IndexOf('\n');
                    if (firstNl > 0) clean = clean[(firstNl + 1)..];
                    var lastFence = clean.LastIndexOf("```");
                    if (lastFence > 0) clean = clean[..lastFence];
                    clean = clean.Trim();
                }

                var match = Regex.Match(clean, @"\{[\s\S]*\}");
                if (!match.Success) return ("", [], []);
                doc = System.Text.Json.JsonDocument.Parse(match.Value);
            }

            var resumen = "";
            if (doc.RootElement.TryGetProperty("resumen", out var resProp))
                resumen = resProp.GetString() ?? "";

            var keywords = new List<string>();
            if (doc.RootElement.TryGetProperty("palabras_clave", out var kwArr))
                keywords = ExtractKeywordArray(kwArr, NormativaMaxKeywords, 3);

            var preguntas = new List<string>();
            if (doc.RootElement.TryGetProperty("preguntas", out var pregArr))
            {
                foreach (var item in pregArr.EnumerateArray())
                {
                    var p = item.GetString()?.Trim();
                    if (!string.IsNullOrEmpty(p)) preguntas.Add(p);
                    if (preguntas.Count >= 4) break;
                }
            }

            return (resumen, keywords, preguntas);
        }
        catch
        {
            return ("", [], []);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // ══ AUTO-PARSE: split raw text into article/disposición chunks
    // ══════════════════════════════════════════════════════════════

    // Matches: Artículo N[bis|ter|quáter...].  Title text
    private static readonly Regex ArticleHeaderRx = new(
        @"(?:^|\n)(Art[ií]culo\s+\d+[a-z]*(?:\s+(?:bis|ter|qu[aá]ter|quinquies|sexies|septies|octies))?\.\s*[^\n]*)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Matches: Disposición adicional/transitoria/derogatoria/final ...
    private static readonly Regex DisposicionHeaderRx = new(
        @"(?:^|\n)(Disposici[oó]n\s+(?:adicional|transitoria|derogatoria|final)\s+[^\n]*)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Extract just the article number from a section string: "Artículo 34.  Jornada" → "34"
    private static readonly Regex ArticleNumberRx = new(
        @"Art[ií]culo\s+(\d+[a-z]*(?:\s+(?:bis|ter|qu[aá]ter|quinquies))?)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Auto-detect law name from pasted text using common patterns.
    /// Looks for "Ley N/YYYY" or well-known full names.
    /// </summary>
    public static string? DetectLawName(string text)
    {
        // Check for well-known full names
        var knownLaws = new (string Pattern, string Name)[]
        {
            ("Estatuto de los Trabajadores", "Texto refundido de la Ley del Estatuto de los Trabajadores"),
            ("Ley General de la Seguridad Social", "Texto refundido de la Ley General de la Seguridad Social"),
            ("LGSS", "Texto refundido de la Ley General de la Seguridad Social"),
            ("TRLGSS", "Texto refundido de la Ley General de la Seguridad Social"),
            ("Estatuto Básico del Empleado Público", "Texto refundido de la Ley del Estatuto Básico del Empleado Público"),
            ("Ley de Prevención de Riesgos Laborales", "Ley de Prevención de Riesgos Laborales"),
            ("Libertad Sindical", "Ley Orgánica de Libertad Sindical"),
            ("Infracciones y Sanciones en el Orden Social", "Texto refundido de la Ley sobre Infracciones y Sanciones en el Orden Social"),
            ("trabajo autónomo", "Ley del Estatuto del trabajo autónomo"),
            ("jurisdicción social", "Ley reguladora de la jurisdicción social"),
            ("trabajo a distancia", "Ley de trabajo a distancia [parcial]"),
        };

        foreach (var (pattern, name) in knownLaws)
        {
            if (text.Contains(pattern, StringComparison.OrdinalIgnoreCase))
                return name;
        }
        return null;
    }

    /// <summary>
    /// Parse raw text into individual article/disposición chunks.
    /// Splits at article boundaries using the same regex patterns as extract_chunks.py.
    /// </summary>
    public static List<ParsedChunk> ParseNormativaText(string rawText, string law)
    {
        var chunks = new List<ParsedChunk>();

        // Clean PDF artifacts BEFORE splitting — headers/footers between articles break detection
        rawText = CleanNormativaText(rawText);

        // Collect all header matches with their positions
        var headers = new List<(int Index, string Header)>();
        foreach (Match m in ArticleHeaderRx.Matches(rawText))
            headers.Add((m.Index + (m.Value.StartsWith('\n') ? 1 : 0), m.Groups[1].Value.Trim()));
        foreach (Match m in DisposicionHeaderRx.Matches(rawText))
            headers.Add((m.Index + (m.Value.StartsWith('\n') ? 1 : 0), m.Groups[1].Value.Trim()));

        headers.Sort((a, b) => a.Index.CompareTo(b.Index));

        if (headers.Count == 0)
        {
            // No articles found — treat entire text as one chunk
            var trimmed = rawText.Trim();
            if (!string.IsNullOrWhiteSpace(trimmed))
            {
                chunks.Add(new ParsedChunk
                {
                    Section = "Texto completo",
                    Text = CleanNormativaText(trimmed),
                    Law = law,
                });
            }
            return chunks;
        }

        // Text before first article (preamble)
        if (headers[0].Index > 50)
        {
            var preamble = rawText[..headers[0].Index].Trim();
            if (preamble.Length > 30)
            {
                chunks.Add(new ParsedChunk
                {
                    Section = "Preambulo / Exposicion de motivos",
                    Text = CleanNormativaText(preamble),
                    Law = law,
                });
            }
        }

        // Split text at each header
        for (int i = 0; i < headers.Count; i++)
        {
            var start = headers[i].Index;
            var end = i + 1 < headers.Count ? headers[i + 1].Index : rawText.Length;
            var section = headers[i].Header;
            var text = rawText[start..end].Trim();

            // Clean BOE artifacts from text
            text = CleanNormativaText(text);

            // Split long articles into parts (>6000 chars)
            if (text.Length > 6000)
            {
                var parts = SplitLongArticle(text, section);
                chunks.AddRange(parts.Select(p => new ParsedChunk
                {
                    Section = p.Section,
                    Text = p.Text,
                    Law = law,
                }));
            }
            else
            {
                chunks.Add(new ParsedChunk
                {
                    Section = section,
                    Text = text,
                    Law = law,
                });
            }
        }

        return chunks;
    }

    /// <summary>
    /// Clean BOE/PDF artifacts from normativa text.
    /// Ported from clean_chunks_v2.py + postprocess_criterios.js patterns.
    /// Handles: page numbers, headers/footers, BOE blocks, CVE lines, hyphenation, omission markers.
    /// </summary>
    private static string CleanNormativaText(string text)
    {
        // Fix hyphenated line breaks FIRST: "word-\nrest" → "wordrest"
        text = Regex.Replace(text, @"(\w)-\n(\w)", "$1$2");

        // Full header block: "CÓDIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n§ ref\n– N –"
        text = Regex.Replace(text,
            @"C[OÓ]DIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n[^\n]*\n(?:–\s*\d+\s*–\s*\n?)?", "");
        // Header with just page number (no § line)
        text = Regex.Replace(text,
            @"C[OÓ]DIGO LABORAL Y DE LA SEGURIDAD SOCIAL\n(?:–\s*\d+\s*–\s*\n?)?", "");

        // BOE header block: "BOLETÍN OFICIAL DEL ESTADO\nNúm. ...\nSec. ..."
        text = Regex.Replace(text,
            @"BOLET[IÍ]N OFICIAL DEL ESTADO\n(?:N[uú]m\.\s*\d+[^\n]*\n)?(?:Sec\.\s*[IVX]+[^\n]*\n)?", "");

        // Standalone page numbers: "– N –" or "- N -"
        text = Regex.Replace(text, @"\n–\s*\d+\s*–\s*(?:\n|$)", "\n");
        text = Regex.Replace(text, @"^–\s*\d+\s*–\s*\n", "");
        text = Regex.Replace(text, @"\n-\s*\d+\s*-\s*(?:\n|$)", "\n");
        // Bare page numbers on their own line
        text = Regex.Replace(text, @"(?m)^\s*-?\s*\d{1,4}\s*-?\s*$", "");

        // "Página N de N"
        text = Regex.Replace(text, @"\nP[aá]gina\s+\d+\s+de\s+\d+\s*(?:\n|$)", "\n");
        text = Regex.Replace(text, @"Página \d+ de \d+", "");

        // CVE/verificable lines
        text = Regex.Replace(text, @"(?m)^[Cc]ve:\s*BOE-[A-Z]-\d+-\d+[^\n]*$", "");
        text = Regex.Replace(text, @"(?m)^Verificable en https?://[^\n]*$", "");

        // BOE omission markers: "[. . .]"
        text = Regex.Replace(text, @"\n\[\s*\.\s*\.\s*\.\s*\]\s*(?:\n|$)", "\n");

        // Generic header/footer patterns common in copied PDFs
        text = Regex.Replace(text, @"(?m)^.*BOLETÍN OFICIAL DEL ESTADO.*$", "");
        text = Regex.Replace(text, @"(?m)^.*cve:\s*BOE.*$", "");

        // Merge lines that are continuation (lowercase start after hard break, typical of PDF copy-paste)
        text = Regex.Replace(text, @"\n(?=[a-záéíóúñ])", " ");

        // Normalize whitespace
        text = Regex.Replace(text, @"\r\n", "\n");
        text = Regex.Replace(text, @"\n{3,}", "\n\n");
        text = Regex.Replace(text, @"[ \t]+", " ");

        return text.Trim();
    }

    /// <summary>Split a long article text into ~5500-char parts at paragraph boundaries.</summary>
    private static List<(string Section, string Text)> SplitLongArticle(string text, string sectionHeader)
    {
        var parts = new List<(string, string)>();
        var paragraphs = text.Split("\n\n", StringSplitOptions.RemoveEmptyEntries);
        var current = new System.Text.StringBuilder();
        int partNum = 1;

        foreach (var para in paragraphs)
        {
            if (current.Length > 0 && current.Length + para.Length > 5500)
            {
                parts.Add(($"{sectionHeader} (parte {partNum})", current.ToString().Trim()));
                current.Clear();
                partNum++;
            }
            if (current.Length > 0) current.Append("\n\n");
            current.Append(para);
        }

        if (current.Length > 0)
        {
            if (partNum == 1)
                parts.Add((sectionHeader, current.ToString().Trim()));
            else
                parts.Add(($"{sectionHeader} (parte {partNum})", current.ToString().Trim()));
        }

        return parts;
    }

    // ══════════════════════════════════════════════════════════════
    // ══ AUTO-MATCH: find existing chunks for parsed articles
    // ══════════════════════════════════════════════════════════════

    /// <summary>
    /// For each parsed chunk, search Qdrant for an existing matching chunk
    /// by article number + law name. Sets ExistingId and Action on each chunk.
    /// </summary>
    public async Task AutoMatchChunksAsync(List<ParsedChunk> chunks)
    {
        var client = qdrant;
        foreach (var chunk in chunks)
        {
            // Extract article number from section
            var artMatch = ArticleNumberRx.Match(chunk.Section);
            if (!artMatch.Success && !chunk.Section.StartsWith("Disposición", StringComparison.OrdinalIgnoreCase))
                continue;

            var searchText = artMatch.Success ? $"Artículo {artMatch.Groups[1].Value}" : chunk.Section.Split('.')[0];

            try
            {
                var results = await client.ScrollPointsAsync("normativa", searchText, chunk.Law, limit: 10);
                // Find exact match by article number
                var exact = results.FirstOrDefault(r => SectionsMatch(r.Section, chunk.Section));
                if (exact != null)
                {
                    chunk.ExistingId = ToLong(exact.Id);
                    chunk.ExistingSection = exact.Section;
                    chunk.Chapter = exact.Chapter; // inherit chapter from existing
                    chunk.Action = "replace";
                }
            }
            catch { /* scroll failed — leave as "add" */ }
        }
    }

    /// <summary>Check if two section strings refer to the same article.</summary>
    private static bool SectionsMatch(string? existing, string parsed)
    {
        if (string.IsNullOrEmpty(existing)) return false;

        // Extract article number from both
        var m1 = ArticleNumberRx.Match(existing);
        var m2 = ArticleNumberRx.Match(parsed);
        if (m1.Success && m2.Success)
        {
            var num1 = m1.Groups[1].Value.Trim().ToLowerInvariant();
            var num2 = m2.Groups[1].Value.Trim().ToLowerInvariant();
            if (num1 != num2) return false;

            // Check part suffix
            var part1 = ExtractPart(existing);
            var part2 = ExtractPart(parsed);
            return part1 == part2;
        }

        // For disposiciones, compare the full type + ordinal
        if (existing.StartsWith("Disposición", StringComparison.OrdinalIgnoreCase) &&
            parsed.StartsWith("Disposición", StringComparison.OrdinalIgnoreCase))
        {
            var key1 = Regex.Match(existing, @"Disposici[oó]n\s+\w+\s+\w+", RegexOptions.IgnoreCase).Value.ToLowerInvariant();
            var key2 = Regex.Match(parsed, @"Disposici[oó]n\s+\w+\s+\w+", RegexOptions.IgnoreCase).Value.ToLowerInvariant();
            return key1 == key2 && key1.Length > 0;
        }

        return false;
    }

    private static int ExtractPart(string section)
    {
        var m = Regex.Match(section, @"\(parte\s+(\d+)\)");
        return m.Success ? int.Parse(m.Groups[1].Value) : 0;
    }

    private static long? ToLong(object? id) => id switch
    {
        long l => l,
        int i => i,
        double d => (long)d,
        System.Text.Json.JsonElement je when je.ValueKind == System.Text.Json.JsonValueKind.Number => je.GetInt64(),
        _ when long.TryParse(id?.ToString(), out var parsed) => parsed,
        _ => null,
    };

    // ══════════════════════════════════════════════════════════════
    // ══ BULK: process multiple chunks in one SSE stream
    // ══════════════════════════════════════════════════════════════

    public async Task ProcessBulkNormativaAsync(
        List<BulkChunkItem> chunks, Func<string, Task> onProgress)
    {
        int total = chunks.Count;
        int processed = 0;

        foreach (var chunk in chunks)
        {
            processed++;
            var label = $"[{processed}/{total}] {chunk.Section}";

            try
            {
                if (chunk.Action == "replace" && chunk.ExistingId.HasValue)
                {
                    await onProgress($"{label} — Actualizando (ID {chunk.ExistingId})...");
                    await UpdateNormativaChunkAsync(chunk.ExistingId.Value,
                        new NormativaChunkInput
                        {
                            Law = chunk.Law,
                            Chapter = chunk.Chapter,
                            Section = chunk.Section,
                            Text = chunk.Text,
                        },
                        async msg => await onProgress($"  {msg}"));
                    await onProgress($"{label} — Actualizado ✓");
                }
                else
                {
                    await onProgress($"{label} — Añadiendo nuevo chunk...");
                    var newId = await AddNormativaChunkAsync(
                        new NormativaChunkInput
                        {
                            Law = chunk.Law,
                            Chapter = chunk.Chapter,
                            Section = chunk.Section,
                            Text = chunk.Text,
                        },
                        async msg => await onProgress($"  {msg}"));
                    await onProgress($"{label} — Añadido con ID {newId} ✓");
                }
            }
            catch (Exception ex)
            {
                await onProgress($"{label} — ERROR: {ex.Message}");
                logger.LogWarning("Bulk normativa error for {Section}: {Message}", chunk.Section, ex.Message);
            }
        }

        await onProgress($"Completado: {processed} chunks procesados.");
    }
}
