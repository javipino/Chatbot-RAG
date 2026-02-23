using Azure.AI.Agents.Persistent;
using ChatbotRag.Api.Models;
using ChatbotRag.Api.Services;

namespace ChatbotRag.Api.Agent;

/// <summary>
/// Resolves agent function tool calls to actual service operations.
/// </summary>
public class ToolExecutor(
    OpenAiService openAi,
    TfidfService tfidf,
    QdrantService qdrant,
    ILogger<ToolExecutor> logger)
{
    /// <summary>Execute a tool call from a streaming action update and return JSON result string.</summary>
    public async Task<string> ExecuteAsync(RequiredActionUpdate actionUpdate)
    {
        var toolName = actionUpdate.FunctionName;
        var toolArgs = actionUpdate.FunctionArguments;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(toolArgs ?? "{}");
            var args = doc.RootElement;

            return toolName switch
            {
                "browse" => await BrowseAsync(args),
                "fetch_details" => await FetchDetailsAsync(args),
                "search_sentencias" => await SearchSentenciasAsync(args),
                "get_related_chunks" => await GetRelatedChunksAsync(args),
                _ => $"{{\"error\": \"Unknown tool: {toolName}\"}}"
            };
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Tool execution failed for {Tool}", toolName);
            return $"{{\"error\": \"{ex.Message}\"}}";
        }
    }

    /// <summary>
    /// Combined browse: searches normativa + criterios_inss in parallel with a single embedding.
    /// Returns lightweight summaries from both collections.
    /// </summary>
    private async Task<string> BrowseAsync(System.Text.Json.JsonElement args)
    {
        var query = args.GetProperty("query").GetString() ?? "";

        // One embedding call, two sparse vectors (collection-specific vocabularies)
        var embedding = await openAi.EmbedAsync(query);
        var sparseNormativa = tfidf.BuildSparseVector(query, "normativa");
        var sparseCriterios = tfidf.BuildSparseVector(query, "criterios_inss");

        // Parallel search across both collections
        var normativaTask = qdrant.SearchCollectionAsync("normativa", embedding, sparseNormativa, 10);
        var criteriosTask = qdrant.SearchCollectionAsync("criterios_inss", embedding, sparseCriterios, 15);

        await Task.WhenAll(normativaTask, criteriosTask);

        var normativaResults = normativaTask.Result;
        var criteriosResults = criteriosTask.Result;

        logger.LogInformation("[AGENT] browse({Query}) → normativa:{NCount}, criterios:{CCount}",
            query, normativaResults.Count, criteriosResults.Count);

        return System.Text.Json.JsonSerializer.Serialize(new
        {
            normativa = normativaResults.Select(NormativaToSummary),
            criterios = criteriosResults.Select(CriterioToSummary),
        });
    }

    /// <summary>
    /// Combined fetch: retrieves full text from normativa + criterios_inss in parallel.
    /// </summary>
    private async Task<string> FetchDetailsAsync(System.Text.Json.JsonElement args)
    {
        var normativaIds = ParseIds(args, "normativa_ids");
        var criteriosIds = ParseIds(args, "criterios_ids");

        var normativaTask = normativaIds.Count > 0
            ? qdrant.FetchChunksByIdsAsync(normativaIds, "normativa")
            : Task.FromResult<List<ChunkResult>>([]);
        var criteriosTask = criteriosIds.Count > 0
            ? qdrant.FetchChunksByIdsAsync(criteriosIds, "criterios_inss")
            : Task.FromResult<List<ChunkResult>>([]);

        await Task.WhenAll(normativaTask, criteriosTask);

        var normativaChunks = normativaTask.Result;
        var criteriosChunks = criteriosTask.Result;

        logger.LogInformation("[AGENT] fetch_details(normativa:{NReq}→{NFound}, criterios:{CReq}→{CFound})",
            normativaIds.Count, normativaChunks.Count, criteriosIds.Count, criteriosChunks.Count);

        return System.Text.Json.JsonSerializer.Serialize(new
        {
            normativa = normativaChunks.Select(ChunkToToolResult),
            criterios = criteriosChunks.Select(ChunkToToolResult),
        });
    }

    private async Task<string> SearchSentenciasAsync(System.Text.Json.JsonElement args)
    {
        var query = args.GetProperty("query").GetString() ?? "";
        var topK = args.TryGetProperty("top_k", out var tk) ? tk.GetInt32() : 5;

        var embedding = await openAi.EmbedAsync(query);
        var sparse = tfidf.BuildSparseVector(query, "sentencias");
        var results = await qdrant.SearchCollectionAsync("sentencias", embedding, sparse, Math.Clamp(topK, 1, 10));

        logger.LogInformation("[AGENT] search_sentencias({Query}) → {Count} chunks", query, results.Count);
        return System.Text.Json.JsonSerializer.Serialize(results.Select(ChunkToToolResult));
    }

    private async Task<string> GetRelatedChunksAsync(System.Text.Json.JsonElement args)
    {
        // Accept int or string id
        object chunkId = args.GetProperty("chunk_id").ValueKind == System.Text.Json.JsonValueKind.Number
            ? (object)args.GetProperty("chunk_id").GetInt64()
            : args.GetProperty("chunk_id").GetString() ?? "";

        var chunks = await qdrant.FetchChunksByIdsAsync([chunkId]);
        if (chunks.Count == 0) return "[]";

        var refs = chunks[0].Refs ?? [];
        if (refs.Count == 0) return "[]";

        var related = await qdrant.FetchChunksByIdsAsync(refs.Take(5).ToList());
        logger.LogInformation("[AGENT] get_related_chunks({Id}) → {Count} chunks", chunkId, related.Count);
        return System.Text.Json.JsonSerializer.Serialize(related.Select(ChunkToToolResult));
    }

    // ── Helpers ──────────────────────────────────────────────

    private static List<object> ParseIds(System.Text.Json.JsonElement args, string propertyName)
    {
        var ids = new List<object>();
        if (!args.TryGetProperty(propertyName, out var idsElem)) return ids;
        foreach (var el in idsElem.EnumerateArray())
        {
            if (el.ValueKind == System.Text.Json.JsonValueKind.Number)
                ids.Add(el.GetInt64());
            else if (long.TryParse(el.GetString(), out var parsed))
                ids.Add(parsed);
        }
        return ids;
    }

    /// <summary>Lightweight summary for normativa browse — no full text.</summary>
    private static object NormativaToSummary(ChunkResult r) => new Dictionary<string, object?>
    {
        ["id"] = r.Id,
        ["law"] = r.Law,
        ["section"] = r.Section,
        ["chapter"] = r.Chapter,
        ["resumen"] = r.Resumen,
    };

    /// <summary>Lightweight summary for criterios browse — no full text.</summary>
    private static object CriterioToSummary(ChunkResult r) => new Dictionary<string, object?>
    {
        ["id"] = r.Id,
        ["criterio_num"] = r.CriterioNum,
        ["fecha"] = r.Fecha,
        ["descripcion"] = r.Resumen,
    };

    private static object ChunkToToolResult(ChunkResult r)
    {
        var isCriterio = !string.IsNullOrEmpty(r.CriterioNum);

        var result = new Dictionary<string, object?>
        {
            ["id"] = r.Id,
            ["law"] = r.Law,
            ["section"] = r.Section,
            ["text"] = r.Text,
            ["collection"] = r.Collection,
        };

        if (isCriterio)
        {
            result["criterio_num"] = r.CriterioNum;
            if (!string.IsNullOrEmpty(r.Fecha))
                result["fecha"] = r.Fecha;
        }
        else
        {
            result["chapter"] = r.Chapter;
        }

        return result;
    }
}
