using ChatbotRag.Api.Models;
using ChatbotRag.Api.Pipeline;
using ChatbotRag.Api.Services;

namespace ChatbotRag.Api.Endpoints;

/// <summary>
/// POST /api/rag-pipeline
/// Classic deterministic 5-stage RAG pipeline (port of server/routes/rag.js).
/// Streams tokens via SSE and returns final metadata in the "done" event.
/// </summary>
public static class RagPipelineEndpoints
{
    private const double CarryoverScore = 0.5;
    private const int MaxChunksToModel = 25;
    private const int NeedRetryCap = MaxChunksToModel + 5;

    public static void MapRagPipeline(this WebApplication app)
    {
        app.MapPost("/api/rag-pipeline", async (HttpContext ctx,
            RagPipelineRequest req,
            ExpandStage expand,
            SearchStage search,
            EnrichStage enrich,
            AnswerStage answer,
            QdrantService qdrant,
            TfidfService tfidf,
            OpenAiService openAi,
            ILogger<RagPipelineRequest> logger) =>
        {
            // ── Auth ──
            if (!AuthHelper.Validate(ctx)) return;

            SseHelper.SetSseHeaders(ctx.Response);

            var messages = req.Messages;
            if (messages == null || messages.Count == 0)
            {
                await SseHelper.WriteErrorAsync(ctx.Response, "No messages provided");
                return;
            }

            var lastUser = messages.LastOrDefault(m => m.Role == "user");
            if (lastUser == null)
            {
                await SseHelper.WriteErrorAsync(ctx.Response, "No user message found");
                return;
            }
            var query = lastUser.Content;

            void Log(string stage, string msg)
            {
                logger.LogInformation("[{Stage}] {Msg}", stage, msg);
            }

            try
            {
                // ── Stage 1: Query Expansion ──
                bool hasCarryover = req.PreviousChunkIds?.Count > 0;
                var expandedQueries = await expand.ExpandQueryAsync(query, messages, hasCarryover);
                Log("S1-EXPAND", $"Expanded to {expandedQueries.Length} queries: [{string.Join(", ", expandedQueries)}]");

                // ── Carryover chunks ──
                var carryoverChunks = new List<ChunkResult>();
                if (hasCarryover)
                {
                    carryoverChunks = await qdrant.FetchChunksByIdsAsync(req.PreviousChunkIds!);
                    foreach (var c in carryoverChunks)
                    {
                        c.Score = CarryoverScore;
                        c.WeightedScore = CarryoverScore;
                        c.FinalScore = CarryoverScore;
                        c.Carryover = true;
                    }
                    Log("CARRYOVER", $"Loaded {carryoverChunks.Count} carryover chunks");
                }

                // ── Stages 2-4: Search ──
                List<ChunkResult> searchResults;
                List<SearchDebugEntry> searchDebug;

                if (expandedQueries.Length == 0 || (expandedQueries.Length == 1 && string.IsNullOrWhiteSpace(expandedQueries[0])))
                {
                    searchResults = [];
                    searchDebug = [];
                }
                else
                {
                    (searchResults, searchDebug) = await search.SearchAllAsync(expandedQueries, Log);
                }
                Log("S4-RESULTS", $"Search returned {searchResults.Count} results");

                // ── Merge carryover + search ──
                var seenIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var allChunks = new List<ChunkResult>();
                foreach (var c in carryoverChunks)
                {
                    if (seenIds.Add(c.Id?.ToString() ?? "")) allChunks.Add(c);
                }
                foreach (var r in searchResults)
                {
                    if (seenIds.Add(r.Id?.ToString() ?? "")) allChunks.Add(r);
                }

                // ── Stage 5b: Reference Expansion ──
                var (refChunks, refsFound) = await enrich.ExpandReferencesAsync(allChunks, Log);
                foreach (var rc in refChunks)
                    if (seenIds.Add(rc.Id?.ToString() ?? "")) allChunks.Add(rc);

                // ── Score, sort, cap ──
                foreach (var c in allChunks)
                {
                    if (c.FinalScore == 0)
                        c.FinalScore = c.WeightedScore > 0 ? c.WeightedScore : c.Score;
                }
                allChunks.Sort((a, b) => b.FinalScore.CompareTo(a.FinalScore));
                var capped = allChunks.Take(MaxChunksToModel).ToList();
                Log("S5-CAP", $"Capped {allChunks.Count} → {capped.Count} chunks for model");

                // ── Stage 5: Answer (streaming) ──
                var context = AnswerStage.BuildContext(capped);
                var answerText = new System.Text.StringBuilder();
                AnswerMeta? meta = null;

                // Use '===META' prefix as delimiter — model sometimes omits the trailing '==='
                const string metaDelimiter = "===META";
                // Buffer the last N-1 chars to prevent partial delimiter leaking across token boundaries
                const int bufferSize = 6; // metaDelimiter.Length - 1
                bool metaSeen = false;
                int emittedLength = 0;

                await foreach (var (token, parsedMeta) in answer.GenerateStreamingAsync(context, messages))
                {
                    if (token != null && !metaSeen)
                    {
                        answerText.Append(token);
                        var full = answerText.ToString();
                        var delimIdx = full.IndexOf(metaDelimiter, StringComparison.Ordinal);

                        if (delimIdx >= 0)
                        {
                            metaSeen = true;
                            // Emit only text before delimiter that hasn't been emitted yet
                            if (delimIdx > emittedLength)
                            {
                                var toEmit = full[emittedLength..delimIdx].TrimEnd();
                                if (!string.IsNullOrEmpty(toEmit))
                                    await SseHelper.WriteTokenAsync(ctx.Response, toEmit);
                            }
                        }
                        else
                        {
                            // Emit all text except last bufferSize chars (could be start of delimiter)
                            var safeEnd = full.Length - bufferSize;
                            if (safeEnd > emittedLength)
                            {
                                var toEmit = full[emittedLength..safeEnd];
                                await SseHelper.WriteTokenAsync(ctx.Response, toEmit);
                                emittedLength = safeEnd;
                            }
                        }
                    }
                    else if (parsedMeta != null)
                    {
                        meta = parsedMeta;
                    }
                }

                // Flush remaining buffer if META was never found
                if (!metaSeen && emittedLength < answerText.Length)
                {
                    var remaining = answerText.ToString()[emittedLength..];
                    if (!string.IsNullOrEmpty(remaining))
                        await SseHelper.WriteTokenAsync(ctx.Response, remaining);
                }

                meta ??= new AnswerMeta();
                Log("S5-ANSWER", $"Used={meta.Used.Count}, Drop={meta.Drop.Count}, Need={meta.Need.Count}");

                // ── NEED retry iteration ──
                if (meta.Need.Count > 0)
                {
                    Log("S5-NEED", $"Processing {meta.Need.Count} NEED requests...");
                    var needChunks = new List<ChunkResult>();
                    var articleNeeds = meta.Need.Where(n => n.Type == "article")
                        .Select(n => (n.Art!, n.Ley!)).ToList();
                    if (articleNeeds.Count > 0)
                    {
                        var fetched = await qdrant.FetchByArticleFilterAsync(
                            articleNeeds, openAi.EmbedAsync, tfidf.BuildSparseVector, Log);
                        needChunks.AddRange(fetched);
                    }

                    foreach (var need in meta.Need.Where(n => n.Type == "query"))
                    {
                        var (newResults, _) = await search.SearchAllAsync([need.Query!], Log);
                        needChunks.AddRange(newResults);
                    }

                    // Merge NEED chunks
                    foreach (var nc in needChunks)
                    {
                        var key = nc.Id?.ToString() ?? "";
                        if (!seenIds.Contains(key))
                        {
                            seenIds.Add(key);
                            if (nc.FinalScore == 0) nc.FinalScore = nc.WeightedScore > 0 ? nc.WeightedScore : nc.Score;
                            allChunks.Add(nc);
                        }
                    }

                    // Re-sort, cap to NeedRetryCap for retry
                    allChunks.Sort((a, b) => b.FinalScore.CompareTo(a.FinalScore));
                    capped = allChunks.Take(NeedRetryCap).ToList();

                    // Re-generate (non-streaming, since we already started streaming)
                    context = AnswerStage.BuildContext(capped);
                    var (retryAnswer, retryMeta) = await answer.GenerateAsync(context, messages);

                    // Emit a replacement token with the retry answer (prefixed to signal replacement)
                    await SseHelper.WriteTokenAsync(ctx.Response,
                        "\n\n<!-- RETRY ANSWER -->\n\n" + retryAnswer);
                    meta = retryMeta;
                    answerText.Clear();
                    answerText.Append(retryAnswer);
                    Log("S5-ANSWER", $"NEED retry: Used={meta.Used.Count}, Drop={meta.Drop.Count}");
                }

                // ── Build contextChunkIds (exclude DROPped) ──
                var dropSet = new HashSet<int>(meta.Drop);
                var contextChunkIds = capped
                    .Select((c, i) => (Chunk: c, Idx: i))
                    .Where(x => !dropSet.Contains(x.Idx))
                    .Select(x => x.Chunk.Id)
                    .Where(id => id != null)
                    .ToList();

                // ── Build sources (deduped) ──
                var seenSources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var sources = capped
                    .Where((c, i) => meta.Used.Count == 0 || meta.Used.Contains(i))
                    .Select(c => new SourceInfo
                    {
                        Id = c.Id,
                        Law = c.Law,
                        Section = c.Section,
                        Chapter = c.Chapter,
                        Collection = c.Collection,
                        Carryover = c.Carryover,
                    })
                    .Where(s => seenSources.Add($"{s.Law}|{s.Section}"))
                    .Take(15)
                    .ToList();

                await SseHelper.WriteDoneAsync(ctx.Response, new
                {
                    contextChunkIds,
                    sources,
                    debug = new
                    {
                        expandedQueries,
                        searchResults = searchResults.Count,
                        searchDetail = searchDebug,
                        refChasing = new { refsFound, chasedAdded = refChunks.Count },
                        usedIndices = meta.Used,
                        dropIndices = meta.Drop,
                        needRequests = meta.Need,
                        totalSources = allChunks.Count,
                    }
                });
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "RAG Pipeline error");
                await SseHelper.WriteErrorAsync(ctx.Response, ex.Message);
            }
        })
        .RequireAuthorization("RagApiKey")
        .WithName("RagPipeline");
    }
}
