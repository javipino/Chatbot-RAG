using System.Text.RegularExpressions;
using ChatbotRag.Api.Models;
using OpenAI.Chat;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace ChatbotRag.Api.Services;

/// <summary>
/// Orchestrates the enrichment pipeline for individual document updates:
/// Extract PDF → Clean → Enrich (Nano) → Embed → Sparse → Upsert to Qdrant.
/// </summary>
public class AdminService(
    OpenAiService openAi,
    TfidfService tfidf,
    QdrantService qdrant,
    ILogger<AdminService> logger)
{
    // ── Enrichment prompt (matches enrich_criterios.js pattern) ──
    private const string EnrichSystemPrompt =
        "Eres un experto en Seguridad Social española y gestión de prestaciones del INSS. Responde SIEMPRE con JSON válido, sin texto adicional ni markdown.";

    private static readonly HashSet<string> NoiseKeywords = new(StringComparer.OrdinalIgnoreCase)
    {
        "criterio de gestión", "criterios de gestión", "instituto nacional de la seguridad social",
        "inss", "seguridad social", "dirección general de ordenación", "dgoss", "informe dgoss",
        "criterio interpretativo", "texto refundido", "trlgss", "ley general de la seguridad social",
    };

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

    // ── Text cleanup (ported from postprocess_criterios.js) ──

    public static string CleanCriterioText(string text)
    {
        // Remove page numbers
        text = Regex.Replace(text, @"(?m)^\s*-?\s*\d+\s*-?\s*$", "");
        text = Regex.Replace(text, @"Página \d+ de \d+", "");

        // Remove repeated headers
        text = Regex.Replace(text, @"(?m)^.*INSTITUTO NACIONAL DE LA SEGURIDAD SOCIAL.*$", "");
        text = Regex.Replace(text, @"(?m)^.*Subdirección General de.*$", "");

        // Remove disclaimer/signature blocks
        text = Regex.Replace(text, @"(?m)^.*(?:Fdo|Firmado|VºBº)[\.:].+$", "");

        // Normalize whitespace
        text = Regex.Replace(text, @"\r\n", "\n");
        text = Regex.Replace(text, @"\n{3,}", "\n\n");
        text = Regex.Replace(text, @"[ \t]+", " ");

        // Merge lines that are continuation (lowercase start after hard break)
        text = Regex.Replace(text, @"\n(?=[a-záéíóúñ])", " ");

        return text.Trim();
    }

    // ── Normativa refs extraction (ported from postprocess_criterios.js) ──

    public static List<string> ExtractNormativaRefs(string text)
    {
        var refs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // art. X + abbreviation (ET, LGSS, etc.)
        foreach (Match m in Regex.Matches(text,
            @"art(?:ículo|\.?)\s*(\d+[\d.]*\s*(?:bis|ter)?)\s+(?:del?\s+)?(?:la\s+)?(?:Ley\s+)?(?:Orgánica\s+)?(ET|LGSS|LETA|LISOS|CE|LRJS|LOLS|LPRL|LET|TRLGSS|TRET|TREBEP|EBEP)",
            RegexOptions.IgnoreCase))
        {
            var num = m.Groups[1].Value.Trim();
            var law = m.Groups[2].Value.Trim().ToUpperInvariant();
            refs.Add($"art. {num} {law}");
        }

        // art. X + Ley/RD N/YYYY
        foreach (Match m in Regex.Matches(text,
            @"art(?:ículo|\.?)\s*(\d+[\d.]*)\s+(?:del?\s+)?(?:la\s+)?((?:Ley|Real Decreto|RD|RDL|RD-ley)\s+\d+/\d{4})",
            RegexOptions.IgnoreCase))
        {
            refs.Add($"art. {m.Groups[1].Value.Trim()} {m.Groups[2].Value.Trim()}");
        }

        // Standalone Ley/RD refs
        foreach (Match m in Regex.Matches(text,
            @"(?:Ley|Real Decreto|RD|RDL|RD-ley)\s+\d+/\d{4}",
            RegexOptions.IgnoreCase))
        {
            refs.Add(m.Value.Trim());
        }

        return refs.ToList();
    }

    // ── Enrich with GPT-5 Nano (generates palabras_clave) ──

    private async Task<List<string>> EnrichWithNanoAsync(string titulo, string descripcion, string text)
    {
        // Build excerpt — skip INFORME DGOSS section
        var informeIdx = text.IndexOf("--- INFORME DGOSS ---", StringComparison.Ordinal);
        var excerpt = informeIdx > 0 ? text[..informeIdx] : text;
        if (excerpt.Length > 6000) excerpt = excerpt[..6000];

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
            new SystemChatMessage(EnrichSystemPrompt),
            new UserChatMessage(prompt),
        };

        var response = await openAi.CallNanoAsync(messages);
        return ParseKeywords(response);
    }

    /// <summary>Enrich normativa chunk — generates resumen and palabras_clave.</summary>
    private async Task<(string Resumen, List<string> PalabrasClave)> EnrichNormativaWithNanoAsync(
        string law, string section, string text)
    {
        var excerpt = text.Length > 6000 ? text[..6000] : text;

        var prompt = $$"""
            Analiza este fragmento de normativa laboral española y devuelve un JSON con:
            "resumen": Resumen conciso del contenido (1-2 frases).
            "palabras_clave": Lista de 5-8 conceptos clave para búsqueda semántica.
            NO incluyas términos genéricos. Céntrate en: materia regulada, derechos/obligaciones, sujetos afectados.

            LEY: {{law}}
            SECCIÓN: {{section}}

            TEXTO:
            {{excerpt}}

            Responde SOLO con JSON válido: {"resumen": "...", "palabras_clave": [...]}
            """;

        var messages = new List<OpenAI.Chat.ChatMessage>
        {
            new SystemChatMessage("Eres un experto en derecho laboral y Seguridad Social española. Responde SIEMPRE con JSON válido, sin texto adicional ni markdown."),
            new UserChatMessage(prompt),
        };

        var response = await openAi.CallNanoAsync(messages);
        var (resumen, keywords) = ParseNormativaEnrichment(response);
        return (resumen, keywords);
    }

    // ── Full pipeline: Process a new criterio from PDF ──

    public async Task<long> ProcessCriterioAsync(
        Stream pdfStream, string titulo, string? descripcion, string? fecha, string? emisor,
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

        // 5. Generate dense embedding
        await onProgress("Generando embedding denso...");
        var embeddingText = BuildCriterioEmbeddingText(titulo, descripcion, palabrasClave);
        var denseVector = await openAi.EmbedAsync(embeddingText);

        // 6. Generate sparse vector
        await onProgress("Generando vector sparse...");
        var sparseText = $"{titulo} {descripcion} {cleanText} {string.Join(" ", palabrasClave)} {string.Join(" ", normativaRefs)}";
        var sparseVector = tfidf.BuildSparseVector(sparseText, "criterios_inss");

        // 7. Get next ID and upsert
        await onProgress("Subiendo a Qdrant...");
        var nextId = await qdrant.GetPointCountAsync("criterios_inss") + 1;

        var payload = new Dictionary<string, object?>
        {
            ["titulo"] = titulo,
            ["descripcion"] = descripcion ?? "",
            ["text"] = cleanText,
            ["fecha"] = fecha ?? "",
            ["emisor"] = emisor ?? "",
            ["estado"] = "Vigente",
            ["normativa_refs"] = normativaRefs,
            ["palabras_clave"] = palabrasClave,
            ["has_full_text"] = true,
            ["collection"] = "criterios_inss",
        };

        await qdrant.UpsertPointAsync("criterios_inss", nextId, denseVector, sparseVector, payload);

        await onProgress($"Criterio subido con ID {nextId}.");
        logger.LogInformation("Admin: Criterio '{Titulo}' uploaded as point {Id}", titulo, nextId);
        return nextId;
    }

    // ── Full pipeline: Add new normativa chunk ──

    public async Task<long> AddNormativaChunkAsync(
        NormativaChunkInput input, Func<string, Task> onProgress)
    {
        // 1. Enrich with Nano
        await onProgress("Enriqueciendo con IA...");
        var (resumen, palabrasClave) = await EnrichNormativaWithNanoAsync(input.Law, input.Section, input.Text);

        // 2. Dense embedding
        await onProgress("Generando embedding denso...");
        var embeddingText = $"{input.Section} {input.Text} {resumen} {string.Join(" ", palabrasClave)}";
        var denseVector = await openAi.EmbedAsync(embeddingText);

        // 3. Sparse vector
        await onProgress("Generando vector sparse...");
        var sparseVector = tfidf.BuildSparseVector(embeddingText, "normativa");

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
            ["collection"] = "normativa",
        };

        await qdrant.UpsertPointAsync("normativa", nextId, denseVector, sparseVector, payload);

        await onProgress($"Chunk normativa subido con ID {nextId}.");
        logger.LogInformation("Admin: Normativa chunk '{Section}' in '{Law}' uploaded as point {Id}",
            input.Section, input.Law, nextId);
        return nextId;
    }

    // ── Update existing normativa chunk ──

    public async Task UpdateNormativaChunkAsync(
        long id, NormativaChunkInput input, Func<string, Task> onProgress)
    {
        // 1. Enrich with Nano
        await onProgress("Enriqueciendo con IA...");
        var (resumen, palabrasClave) = await EnrichNormativaWithNanoAsync(input.Law, input.Section, input.Text);

        // 2. Dense embedding
        await onProgress("Generando embedding denso...");
        var embeddingText = $"{input.Section} {input.Text} {resumen} {string.Join(" ", palabrasClave)}";
        var denseVector = await openAi.EmbedAsync(embeddingText);

        // 3. Sparse vector
        await onProgress("Generando vector sparse...");
        var sparseVector = tfidf.BuildSparseVector(embeddingText, "normativa");

        // 4. Upsert (same ID)
        await onProgress("Actualizando en Qdrant...");
        var payload = new Dictionary<string, object?>
        {
            ["law"] = input.Law,
            ["chapter"] = input.Chapter ?? "",
            ["section"] = input.Section,
            ["text"] = input.Text,
            ["resumen"] = resumen,
            ["palabras_clave"] = palabrasClave,
            ["collection"] = "normativa",
        };

        await qdrant.UpsertPointAsync("normativa", id, denseVector, sparseVector, payload);

        await onProgress($"Chunk {id} actualizado.");
        logger.LogInformation("Admin: Normativa chunk {Id} updated", id);
    }

    // ── Helpers ──

    private static string BuildCriterioEmbeddingText(string titulo, string? descripcion, List<string> palabrasClave)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(descripcion)) parts.Add(descripcion);
        if (!string.IsNullOrWhiteSpace(titulo)) parts.Add(titulo);
        if (palabrasClave.Count > 0) parts.Add(string.Join(", ", palabrasClave));
        return string.Join(". ", parts);
    }

    private static List<string> ParseKeywords(string response)
    {
        try
        {
            var clean = response.Trim();
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

            var doc = System.Text.Json.JsonDocument.Parse(match.Value);
            if (!doc.RootElement.TryGetProperty("palabras_clave", out var arr)) return [];

            var keywords = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in arr.EnumerateArray())
            {
                var kw = item.GetString()?.Trim();
                if (string.IsNullOrEmpty(kw) || kw.Length < 3) continue;
                if (NoiseKeywords.Contains(kw)) continue;
                if (!seen.Add(kw.ToLowerInvariant())) continue;
                keywords.Add(kw);
                if (keywords.Count >= 8) break;
            }
            return keywords;
        }
        catch
        {
            return [];
        }
    }

    private static (string Resumen, List<string> PalabrasClave) ParseNormativaEnrichment(string response)
    {
        try
        {
            var clean = response.Trim();
            if (clean.StartsWith("```"))
            {
                var firstNl = clean.IndexOf('\n');
                if (firstNl > 0) clean = clean[(firstNl + 1)..];
                var lastFence = clean.LastIndexOf("```");
                if (lastFence > 0) clean = clean[..lastFence];
                clean = clean.Trim();
            }

            var match = Regex.Match(clean, @"\{[\s\S]*\}");
            if (!match.Success) return ("", []);

            var doc = System.Text.Json.JsonDocument.Parse(match.Value);
            var resumen = "";
            if (doc.RootElement.TryGetProperty("resumen", out var resProp))
                resumen = resProp.GetString() ?? "";

            var keywords = new List<string>();
            if (doc.RootElement.TryGetProperty("palabras_clave", out var arr))
            {
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var item in arr.EnumerateArray())
                {
                    var kw = item.GetString()?.Trim();
                    if (string.IsNullOrEmpty(kw) || kw.Length < 3) continue;
                    if (!seen.Add(kw.ToLowerInvariant())) continue;
                    keywords.Add(kw);
                    if (keywords.Count >= 8) break;
                }
            }

            return (resumen, keywords);
        }
        catch
        {
            return ("", []);
        }
    }
}
