using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using ChatbotRag.Api.Models;

namespace ChatbotRag.Api.Services;

/// <summary>
/// Qdrant vector DB operations via REST API.
/// Uses HttpClient directly (named "qdrant") because the Qdrant .NET SDK
/// does not expose the hybrid Query API with prefetch/fusion/named vectors.
/// </summary>
public class QdrantService(IHttpClientFactory httpClientFactory, ILogger<QdrantService> logger)
{
    private static readonly JsonSerializerOptions _json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private HttpClient CreateClient()
    {
        var client = httpClientFactory.CreateClient("qdrant");
        return client;
    }

    /// <summary>Hybrid search (dense + sparse RRF) in one collection.</summary>
    public async Task<List<ChunkResult>> SearchCollectionAsync(
        string collectionName, float[] denseVector, QdrantSparseQuery? sparseVector, int topK = 10)
    {
        var prefetch = new List<QdrantPrefetch>
        {
            new() { Query = denseVector, Using = "text-dense", Limit = 20 },
        };

        if (sparseVector != null)
        {
            prefetch.Add(new QdrantPrefetch
            {
                Query = sparseVector,
                Using = "text-sparse",
                Limit = 20,
            });
        }

        var body = new QdrantQueryRequest
        {
            Prefetch = prefetch,
            Query = new QdrantFusionQuery { Fusion = "rrf" },
            Limit = topK,
            WithPayload = true,
        };

        var client = CreateClient();
        var response = await client.PostAsJsonAsync($"/collections/{collectionName}/points/query", body);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<QdrantQueryResponse>();
        return (result?.Result?.Points ?? []).Select(p => PointToChunk(p, collectionName)).ToList();
    }

    /// <summary>Cross-collection hybrid search with weighted merge.</summary>
    public async Task<List<ChunkResult>> SearchAllCollectionsAsync(
        float[] denseVector, QdrantSparseQuery? sparseVector, int finalLimit = 10)
    {
        int perColTopK = Math.Max(5, Math.Min(10, finalLimit));

        var tasks = AppConfig.Collections.Select(async col =>
        {
            try
            {
                var results = await SearchCollectionAsync(col.Name, denseVector, sparseVector, perColTopK);
                foreach (var r in results)
                {
                    r.WeightedScore = r.Score * col.Weight;
                    r.Collection = col.Name;
                }
                return results;
            }
            catch (Exception ex) when (ex.Message.Contains("404") || ex.Message.Contains("Not Found"))
            {
                return new List<ChunkResult>();
            }
            catch (Exception ex)
            {
                logger.LogWarning("Search in {Collection} failed: {Message}", col.Name, ex.Message);
                return new List<ChunkResult>();
            }
        });

        var all = (await Task.WhenAll(tasks)).SelectMany(x => x).ToList();
        all.Sort((a, b) => b.WeightedScore.CompareTo(a.WeightedScore));
        return all.Take(finalLimit).ToList();
    }

    /// <summary>Fetch chunks by point IDs from normativa collection.</summary>
    public async Task<List<ChunkResult>> FetchChunksByIdsAsync(IEnumerable<object> ids)
    {
        var idList = ids.ToList();
        if (idList.Count == 0) return [];

        var body = new QdrantFetchRequest { Ids = idList, WithPayload = true, WithVector = false };
        var client = CreateClient();
        var response = await client.PostAsJsonAsync("/collections/normativa/points", body);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<QdrantFetchResponse>();
        return (result?.Result ?? []).Select(p =>
        {
            var chunk = PointToChunk(p, "normativa");
            chunk.Score = 0.5;
            chunk.WeightedScore = 0.5;
            chunk.Chased = true;
            chunk.RefReason = "Pre-computed reference";
            return chunk;
        }).ToList();
    }

    /// <summary>Fetch chunks by article number + law name (metadata filter + semantic fallback).</summary>
    public async Task<List<ChunkResult>> FetchByArticleFilterAsync(
        IEnumerable<(string Art, string Ley)> refs,
        Func<string, Task<float[]>> embedFn,
        Func<string, QdrantSparseQuery?> buildSparseFn,
        Action<string, string> log)
    {
        var allMatched = new List<ChunkResult>();
        var client = CreateClient();

        foreach (var (art, ley) in refs)
        {
            try
            {
                var artBase = art.Split('.')[0];
                var lawWords = CleanLawName(ley);
                var searchQuery = $"Artículo {art} {ley}";
                var seenIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var points = new List<QdrantPoint>();

                // Strategy 1: Metadata filter
                try
                {
                    var filterBody = new
                    {
                        limit = 5,
                        with_payload = true,
                        filter = new
                        {
                            must = new object[]
                            {
                                new { key = "section", match = new { text = $"Artículo {artBase}" } },
                                new { key = "law", match = new { text = lawWords } },
                            }
                        }
                    };
                    var resp = await client.PostAsJsonAsync("/collections/normativa/points/scroll", filterBody);
                    if (resp.IsSuccessStatusCode)
                    {
                        var scrollResult = await resp.Content.ReadFromJsonAsync<QdrantScrollResponse>();
                        var filterPoints = scrollResult?.Result?.Points ?? [];
                        log("S5c-FETCH", $"  Filter found {filterPoints.Count} for Art.{artBase} ({lawWords})");
                        foreach (var p in filterPoints)
                        {
                            var key = p.Id?.ToString() ?? "";
                            if (seenIds.Add(key)) points.Add(p);
                        }
                    }
                }
                catch (Exception ex) { log("S5c-FETCH", $"  Filter failed: {ex.Message}"); }

                // Strategy 2: Semantic search
                try
                {
                    var embedding = await embedFn(searchQuery);
                    var sparse = buildSparseFn(searchQuery);
                    var prefetch = new List<object>
                    {
                        new { query = embedding, using_ = "text-dense", limit = 10 },
                    };
                    if (sparse != null)
                        prefetch.Add(new { query = sparse, using_ = "text-sparse", limit = 10 });

                    var lawKeyword = lawWords.Split(' ')[0];
                    object? filter = string.IsNullOrEmpty(lawKeyword) ? null
                        : new { must = new[] { new { key = "law", match = new { text = lawKeyword } } } };

                    // Build prefetch list manually (avoid "using" keyword conflict with named args)
                    var prefetchList = new List<Dictionary<string, object>>
                    {
                        new() { ["query"] = embedding, ["using"] = "text-dense", ["limit"] = 10 },
                    };
                    if (sparse != null)
                        prefetchList.Add(new() { ["query"] = new { indices = sparse.Indices, values = sparse.Values }, ["using"] = "text-sparse", ["limit"] = 10 });

                    var queryBody = new JsonObject
                    {
                        ["limit"] = 5,
                        ["with_payload"] = true,
                        ["query"] = new JsonObject { ["fusion"] = "rrf" },
                        ["prefetch"] = JsonNode.Parse(JsonSerializer.Serialize(prefetchList)),
                    };
                    if (filter != null)
                        queryBody["filter"] = JsonNode.Parse(JsonSerializer.Serialize(filter));

                    var resp = await client.PostAsJsonAsync("/collections/normativa/points/query", queryBody);
                    if (resp.IsSuccessStatusCode)
                    {
                        var qResult = await resp.Content.ReadFromJsonAsync<QdrantQueryResponse>();
                        var semPoints = qResult?.Result?.Points ?? [];
                        log("S5c-FETCH", $"  Semantic found {semPoints.Count} for \"{searchQuery}\"");
                        foreach (var p in semPoints)
                        {
                            var key = p.Id?.ToString() ?? "";
                            if (seenIds.Add(key)) points.Add(p);
                        }
                    }
                }
                catch (Exception ex) { log("S5c-FETCH", $"  Semantic fallback failed: {ex.Message}"); }

                log("S5c-FETCH", $"  Total: {points.Count} chunks for Art.{artBase} {ley}");

                foreach (var p in points)
                {
                    var chunk = PointToChunk(p, "normativa");
                    chunk.Chased = true;
                    chunk.RefReason = $"Eval requested: Art.{art} {ley}";
                    allMatched.Add(chunk);
                }
            }
            catch (Exception ex)
            {
                log("S5c-FETCH", $"  Chase failed for Art.{art}: {ex.Message}");
            }
        }

        return allMatched;
    }

    // ── Private helpers ──

    private static ChunkResult PointToChunk(QdrantPoint p, string collection) => new()
    {
        Id = p.Id,
        Score = p.Score,
        WeightedScore = p.Score,
        Collection = collection,
        Law = p.Payload?.Law,
        Section = p.Payload?.Section,
        Chapter = p.Payload?.Chapter,
        Text = p.Payload?.Text,
        Resumen = p.Payload?.Resumen,
        Refs = p.Payload?.Refs,
    };

    /// <summary>Strip "Texto refundido de la Ley del?" prefix, keep first 2 words &gt;3 chars.</summary>
    private static string CleanLawName(string ley)
    {
        var cleaned = System.Text.RegularExpressions.Regex.Replace(
            ley, @"Texto refundido de la Ley del?\s*", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Trim();
        return string.Join(' ',
            cleaned.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                   .Where(w => w.Length > 3)
                   .Take(2));
    }
}
