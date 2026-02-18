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
                "search_normativa" => await SearchNormativaAsync(args),
                "search_sentencias" => await SearchSentenciasAsync(args),
                "get_article" => await GetArticleAsync(args),
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

    private async Task<string> SearchNormativaAsync(System.Text.Json.JsonElement args)
    {
        var query = args.GetProperty("query").GetString() ?? "";
        var topK = args.TryGetProperty("top_k", out var tk) ? tk.GetInt32() : 8;

        var embedding = await openAi.EmbedAsync(query);
        var sparse = tfidf.BuildSparseVector(query);
        var results = await qdrant.SearchAllCollectionsAsync(embedding, sparse, Math.Clamp(topK, 1, 15));

        logger.LogInformation("[AGENT] search_normativa({Query}) → {Count} chunks", query, results.Count);
        return System.Text.Json.JsonSerializer.Serialize(results.Select(ChunkToToolResult));
    }

    private async Task<string> SearchSentenciasAsync(System.Text.Json.JsonElement args)
    {
        var query = args.GetProperty("query").GetString() ?? "";
        var topK = args.TryGetProperty("top_k", out var tk) ? tk.GetInt32() : 5;

        var embedding = await openAi.EmbedAsync(query);
        var sparse = tfidf.BuildSparseVector(query);
        var results = await qdrant.SearchCollectionAsync("sentencias", embedding, sparse, Math.Clamp(topK, 1, 10));

        logger.LogInformation("[AGENT] search_sentencias({Query}) → {Count} chunks", query, results.Count);
        return System.Text.Json.JsonSerializer.Serialize(results.Select(ChunkToToolResult));
    }

    private async Task<string> GetArticleAsync(System.Text.Json.JsonElement args)
    {
        var articleNumber = args.GetProperty("article_number").GetString() ?? "";
        var lawName = args.GetProperty("law_name").GetString() ?? "";

        var results = await qdrant.FetchByArticleFilterAsync(
            [(articleNumber, lawName)],
            openAi.EmbedAsync,
            tfidf.BuildSparseVector,
            (tag, msg) => logger.LogDebug("[{Tag}] {Msg}", tag, msg));

        logger.LogInformation("[AGENT] get_article({Art}, {Law}) → {Count} chunks", articleNumber, lawName, results.Count);
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

    private static object ChunkToToolResult(ChunkResult r) => new
    {
        id = r.Id,
        law = r.Law,
        section = r.Section,
        chapter = r.Chapter,
        resumen = r.Resumen,
        text = r.Text,
        score = r.WeightedScore > 0 ? r.WeightedScore : r.Score,
        collection = r.Collection,
    };
}
