using ChatbotRag.Api.Models;
using ChatbotRag.Api.Services;

namespace ChatbotRag.Api.Pipeline;

/// <summary>
/// Stages 2-4: Embed + Sparse + Hybrid Search
/// Ported from server/pipeline/search.js.
/// </summary>
public class SearchStage(OpenAiService openAi, TfidfService tfidf, QdrantService qdrant, ILogger<SearchStage> logger)
{
    private const int SingleQueryResults = 10;
    private const int MultiQueryTotalResults = 16;
    private const int MultiQueryMinPerQuery = 3;

    private static (int PerQueryLimit, int TotalLimit) ComputeSearchBudget(int queryCount)
    {
        if (queryCount <= 1) return (SingleQueryResults, SingleQueryResults);
        int perQuery = Math.Max(MultiQueryMinPerQuery, MultiQueryTotalResults / queryCount);
        return (perQuery, perQuery * queryCount);
    }

    /// <summary>
    /// Execute parallel hybrid search for all expanded queries.
    /// Returns deduplicated, sorted, capped results plus debug info.
    /// </summary>
    public async Task<(List<ChunkResult> Results, List<SearchDebugEntry> Debug)> SearchAllAsync(
        string[] expandedQueries, Action<string, string> log)
    {
        var (perQueryLimit, totalLimit) = ComputeSearchBudget(expandedQueries.Length);
        log("S4-BUDGET", $"Queries={expandedQueries.Length}, perQuery={perQueryLimit}, totalCap={totalLimit}");

        // Run all queries in parallel
        var tasks = expandedQueries.Select(async (query, qi) =>
        {
            var embedding = await openAi.EmbedAsync(query);
            log("S2-EMBED", $"Query[{qi}] embedded → {embedding.Length} dims");

            QdrantSparseQuery? SparseBuilder(string collection)
            {
                var s = tfidf.BuildSparseVector(query, collection);
                return s;
            }
            log("S3-SPARSE", $"Query[{qi}] sparse builders ready");

            var results = await qdrant.SearchAllCollectionsAsync(embedding, SparseBuilder, perQueryLimit);
            var byColl = results.GroupBy(r => r.Collection ?? "?").ToDictionary(g => g.Key, g => g.Count());
            log("S4-SEARCH", $"Query[{qi}] → {results.Count} results: {string.Join(", ", byColl.Select(kv => $"{kv.Key}:{kv.Value}"))}");
            for (int i = 0; i < results.Count; i++)
            {
                var r = results[i];
                log("S4-SEARCH", $"  [{i}] id={r.Id} score={(r.WeightedScore > 0 ? r.WeightedScore : r.Score):F4} ({r.Collection}) {r.Law ?? "?"} > {(r.Section ?? "?")[..Math.Min(60, r.Section?.Length ?? 0)]}");
            }

            return (QueryIndex: qi, Results: results);
        });

        var resultSets = await Task.WhenAll(tasks);

        // Merge and deduplicate — keep highest weighted score for duplicates
        var allResults = new Dictionary<string, ChunkResult>(StringComparer.OrdinalIgnoreCase);
        var debugDetail = new List<SearchDebugEntry>();
        int dupeCount = 0;

        foreach (var (qi, results) in resultSets)
        {
            debugDetail.Add(new SearchDebugEntry
            {
                QueryIndex = qi,
                Query = expandedQueries[qi][..Math.Min(100, expandedQueries[qi].Length)],
                Count = results.Count,
                TopIds = results.Take(5).Select(r => r.Id?.ToString() ?? "").ToList(),
            });

            foreach (var r in results)
            {
                var key = r.Id?.ToString() ?? "";
                if (!allResults.TryGetValue(key, out var existing))
                    allResults[key] = r;
                else
                {
                    dupeCount++;
                    if (r.WeightedScore > existing.WeightedScore)
                        allResults[key] = r;
                }
            }
        }

        var sorted = allResults.Values
            .OrderByDescending(r => r.WeightedScore > 0 ? r.WeightedScore : r.Score)
            .Take(totalLimit)
            .ToList();

        log("S4-MERGE", $"Total unique: {allResults.Count}, dupes removed: {dupeCount}, kept top {totalLimit}: {sorted.Count}");

        return (sorted, debugDetail);
    }
}

public class SearchDebugEntry
{
    public int QueryIndex { get; set; }
    public string Query { get; set; } = "";
    public int Count { get; set; }
    public List<string> TopIds { get; set; } = [];
}
