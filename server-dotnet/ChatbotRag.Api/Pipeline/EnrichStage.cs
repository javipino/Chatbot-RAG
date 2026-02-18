using ChatbotRag.Api.Models;
using ChatbotRag.Api.Services;

namespace ChatbotRag.Api.Pipeline;

/// <summary>
/// Stage 5b: Reference Expansion.
/// Ported from server/pipeline/enrich.js.
/// </summary>
public class EnrichStage(QdrantService qdrant, ILogger<EnrichStage> logger)
{
    private const int MaxRefsPerChunk = 3;
    private const int MaxTotalRefs = 15;
    private const double RefScoreFactor = 0.8;

    // ── Law rank hierarchy ──
    private static readonly Dictionary<string, int> LawRank = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Constitución Española [parcial]"] = 1,
        ["Ley Orgánica de Libertad Sindical"] = 1,
        ["Texto refundido de la Ley del Estatuto de los Trabajadores"] = 2,
        ["Texto refundido de la Ley General de la Seguridad Social"] = 2,
        ["Ley del Estatuto del trabajo autónomo"] = 2,
        ["Texto refundido de la Ley sobre Infracciones y Sanciones en el Orden Social"] = 2,
        ["Ley reguladora de la jurisdicción social"] = 2,
        ["Ley de Prevención de Riesgos Laborales"] = 2,
        ["Ley de Empleo [parcial]"] = 2,
        ["Ley de trabajo a distancia [parcial]"] = 2,
        ["Ley de protección social de las personas trabajadoras del sector marítimo-pesquero"] = 2,
    };

    private static int GetLawRank(string? lawName)
    {
        if (string.IsNullOrEmpty(lawName)) return 99;
        if (LawRank.TryGetValue(lawName, out var rank)) return rank;
        if (System.Text.RegularExpressions.Regex.IsMatch(lawName, @"^Ley\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return 2;
        if (lawName.Contains("Reglamento General", StringComparison.OrdinalIgnoreCase)) return 3;
        if (lawName.Contains("Real Decreto", StringComparison.OrdinalIgnoreCase)) return 4;
        return 5;
    }

    private static bool IsSibling(ChunkResult source, ChunkResult target)
    {
        if (string.IsNullOrEmpty(source.Section) || string.IsNullOrEmpty(target.Section)
            || source.Law != target.Law || source.Id?.ToString() == target.Id?.ToString())
            return false;

        string? GetArtBase(string sec) =>
            System.Text.RegularExpressions.Regex.Match(sec, @"^Art[ií]culo\s+(\d+(?:\s*(?:bis|ter|quater|quinquies))?)", System.Text.RegularExpressions.RegexOptions.IgnoreCase) is { Success: true } m
                ? m.Groups[1].Value.Trim().ToLowerInvariant() : null;

        var srcArt = GetArtBase(source.Section);
        var tgtArt = GetArtBase(target.Section);
        return srcArt != null && tgtArt != null && srcArt == tgtArt;
    }

    /// <summary>
    /// Expand pre-computed references from search results.
    /// Filtering: upward/equal law rank + siblings. Capped per-chunk and globally.
    /// </summary>
    public async Task<(List<ChunkResult> Added, int RefsFound)> ExpandReferencesAsync(
        IList<ChunkResult> results, Action<string, string> log)
    {
        var existingIds = new HashSet<string>(results.Select(r => r.Id?.ToString() ?? ""), StringComparer.OrdinalIgnoreCase);
        var allRefIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var r in results)
            foreach (var refId in r.Refs ?? [])
            {
                var key = refId?.ToString() ?? "";
                if (!existingIds.Contains(key)) allRefIds.Add(key);
            }

        if (allRefIds.Count == 0)
        {
            log("S5b-REFS", "No pre-computed references to fetch");
            return ([], 0);
        }

        log("S5b-REFS", $"Fetching {allRefIds.Count} candidate refs to filter...");
        var fetched = await qdrant.FetchChunksByIdsAsync(allRefIds.Cast<object>());
        var fetchedMap = fetched.ToDictionary(f => f.Id?.ToString() ?? "", StringComparer.OrdinalIgnoreCase);

        // Second pass: filter + score
        var neededIds = new Dictionary<string, (string Reason, double Score)>(StringComparer.OrdinalIgnoreCase);

        foreach (var r in results)
        {
            var refs = r.Refs ?? [];
            if (refs.Count == 0) continue;

            int srcRank = GetLawRank(r.Law);
            var kept = new List<(string Id, string Reason, ChunkResult Target)>();
            int skipped = 0;

            foreach (var refId in refs)
            {
                var key = refId?.ToString() ?? "";
                if (existingIds.Contains(key) || neededIds.ContainsKey(key)) continue;
                if (!fetchedMap.TryGetValue(key, out var target)) continue;

                int tgtRank = GetLawRank(target.Law);
                bool isSib = IsSibling(r, target);

                if (isSib || tgtRank <= srcRank)
                    kept.Add((key, isSib ? "sibling" : "upward", target));
                else
                    skipped++;
            }

            kept = kept.Take(MaxRefsPerChunk).ToList();

            if (kept.Count + skipped > 0)
                log("S5b-REFS", $"id={r.Id} ({(r.Section ?? "?")[..Math.Min(40, r.Section?.Length ?? 0)]}) → {kept.Count} kept, {skipped} filtered out");

            double parentScore = r.WeightedScore > 0 ? r.WeightedScore : r.Score;
            foreach (var (id, reason, _) in kept)
            {
                double inherited = parentScore * RefScoreFactor;
                if (!neededIds.TryGetValue(id, out var existing) || inherited > existing.Score)
                    neededIds[id] = (reason, inherited);
            }
        }

        var newResults = neededIds
            .Select(kv =>
            {
                if (!fetchedMap.TryGetValue(kv.Key, out var chunk) || existingIds.Contains(chunk.Id?.ToString() ?? ""))
                    return null;
                chunk.FinalScore = kv.Value.Score;
                chunk.RefReason = kv.Value.Reason;
                return chunk;
            })
            .Where(c => c != null)
            .Cast<ChunkResult>()
            .OrderByDescending(c => c.FinalScore)
            .ToList();

        int beforeCap = newResults.Count;
        if (newResults.Count > MaxTotalRefs)
        {
            log("S5b-REFS", $"Global cap: {beforeCap} → {MaxTotalRefs} refs (cut {beforeCap - MaxTotalRefs} lowest-score)");
            newResults = newResults.Take(MaxTotalRefs).ToList();
        }

        if (newResults.Count > 0)
        {
            log("S5b-REFS", $"Added {newResults.Count} referenced chunks{(beforeCap > MaxTotalRefs ? $" (capped from {beforeCap})" : "")} ({allRefIds.Count - beforeCap} filtered out):");
            foreach (var r in newResults)
                log("S5b-REFS", $"  + id={r.Id} [{r.RefReason}] score={r.FinalScore:F4} ({r.Collection}) {r.Law ?? "?"} > {(r.Section ?? "?")[..Math.Min(60, r.Section?.Length ?? 0)]}");
        }
        else
        {
            log("S5b-REFS", $"All {allRefIds.Count} candidate refs filtered out (no upward/sibling matches)");
        }

        return (newResults, allRefIds.Count);
    }
}
