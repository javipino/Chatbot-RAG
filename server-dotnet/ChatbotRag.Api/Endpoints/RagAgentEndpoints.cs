using Azure;
using Azure.AI.Agents.Persistent;
using ChatbotRag.Api.Agent;
using ChatbotRag.Api.Models;

namespace ChatbotRag.Api.Endpoints;

/// <summary>
/// POST /api/rag-agent
/// Agent-based RAG: GPT-5.2 decides what to search and how many times,
/// using function tools to query Qdrant. Thread-based conversation (no manual carryover).
/// Streams tokens + tool status events via SSE.
/// </summary>
public static class RagAgentEndpoints
{
    public static void MapRagAgent(this WebApplication app)
    {
        app.MapPost("/api/rag-agent", async (HttpContext ctx,
            RagAgentRequest req,
            AgentManager agentManager,
            ToolExecutor toolExecutor,
            ILogger<RagAgentRequest> logger) =>
        {
            // ── Auth ──
            if (!AuthHelper.Validate(ctx)) return;

            if (string.IsNullOrWhiteSpace(req.Message))
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsJsonAsync(new { error = "No message provided" });
                return;
            }

            SseHelper.SetSseHeaders(ctx.Response);

            try
            {
                await RunAgentAsync(ctx, req, agentManager, toolExecutor, logger);
            }
            catch (Exception ex) when (ex.Message.Contains("No assistant found", StringComparison.OrdinalIgnoreCase))
            {
                // Agent was deleted from Foundry — recreate and retry once
                logger.LogWarning("[AGENT] Stale agent — recreating and retrying");
                agentManager.InvalidateAgent();
                try
                {
                    req.ThreadId = null;
                    await RunAgentAsync(ctx, req, agentManager, toolExecutor, logger);
                }
                catch (Exception retryEx)
                {
                    logger.LogError(retryEx, "RAG Agent error (retry)");
                    await SseHelper.WriteErrorAsync(ctx.Response, $"{retryEx.GetType().Name}: {retryEx.Message}\n{retryEx.StackTrace}");
                }
            }
            catch (Exception ex) when (ex.Message.StartsWith("THREAD_RETRY:", StringComparison.Ordinal))
            {
                // Run failed on a resumed thread (e.g. thread was created by a different/deleted agent)
                var reason = ex.Message["THREAD_RETRY:".Length..];
                logger.LogWarning("[AGENT] Thread-level failure ({Reason}) — retrying with fresh thread", reason);
                try
                {
                    req.ThreadId = null;
                    await RunAgentAsync(ctx, req, agentManager, toolExecutor, logger);
                }
                catch (Exception retryEx)
                {
                    logger.LogError(retryEx, "RAG Agent error (thread retry)");
                    await SseHelper.WriteErrorAsync(ctx.Response, $"{retryEx.GetType().Name}: {retryEx.Message}");
                }
            }
            catch (RequestFailedException rfe) when (rfe.Status == 429)
            {
                logger.LogWarning("[AGENT] HTTP 429 rate limit: {Msg}", rfe.Message);
                await SseHelper.WriteRateLimitAsync(ctx.Response,
                    "Has superado el límite de tokens por minuto. Espera un momento y reintenta.");
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "RAG Agent error");
                await SseHelper.WriteErrorAsync(ctx.Response, $"{ex.GetType().Name}: {ex.Message}\n{ex.StackTrace}");
            }
        })
        .WithName("RagAgent");
    }

    private static async Task RunAgentAsync(HttpContext ctx, RagAgentRequest req,
        AgentManager agentManager, ToolExecutor toolExecutor, ILogger logger)
    {
        logger.LogInformation("[AGENT] Step 1: Getting agent ID...");
        var agentsClient = agentManager.AgentsClient;
        var agentId = await agentManager.GetAgentIdAsync();
        logger.LogInformation("[AGENT] Step 2: Agent ID = {Id}", agentId);

        // Verify agent has tools before running
        try
        {
            var agent = await agentsClient.Administration.GetAgentAsync(agentId);
            var toolCount = agent.Value?.Tools?.Count ?? -1;
            var instrLen = agent.Value?.Instructions?.Length ?? 0;
            logger.LogWarning("[AGENT] Agent verify: tools={ToolCount}, instrLen={InstrLen}, model={Model}",
                toolCount, instrLen, agent.Value?.Model ?? "null");
        }
        catch (Exception ex)
        {
            logger.LogError("[AGENT] Failed to verify agent: {Msg}", ex.Message);
        }

        // ── Thread management ──
        PersistentAgentThread thread;
        if (!string.IsNullOrEmpty(req.ThreadId))
        {
            thread = await agentsClient.Threads.GetThreadAsync(req.ThreadId);
            logger.LogInformation("[AGENT] Resuming thread {Id}", thread.Id);

            // Cancel any active runs before creating a new one
            // (the Assistants API doesn't allow concurrent runs on the same thread)
            await CancelActiveRunsAsync(agentsClient, thread.Id, logger);
        }
        else
        {
            logger.LogInformation("[AGENT] Step 3: Creating thread...");
            thread = await agentManager.CreateThreadAsync();
            logger.LogInformation("[AGENT] Step 3 done: thread {Id}", thread.Id);
        }

        // Add user message
        logger.LogInformation("[AGENT] Step 4: Adding message to thread...");
        await agentsClient.Messages.CreateMessageAsync(thread.Id, MessageRole.User, req.Message);
        logger.LogInformation("[AGENT] Step 4 done");

        // ── Streaming run ──
        logger.LogInformation("[AGENT] Step 5: Creating streaming run...");
        var stream = agentsClient.Runs.CreateRunStreamingAsync(thread.Id, agentId);
        logger.LogInformation("[AGENT] Step 5 done: stream created");
        var collectedSources = new List<object>();
        ThreadRun? currentRun = null;

        while (true)
        {
            var toolOutputs = new List<ToolOutput>();

            await foreach (var update in stream)
            {
                switch (update)
                {
                    case RunUpdate runUpdate when update.UpdateKind == StreamingUpdateReason.RunCreated:
                        currentRun = runUpdate.Value;
                        logger.LogInformation("[AGENT] Run created: {Id}", currentRun.Id);
                        break;

                    case RequiredActionUpdate actionUpdate:
                    {
                        var toolName = actionUpdate.FunctionName;
                        object? toolArgs = null;
                        try
                        {
                            toolArgs = System.Text.Json.JsonSerializer.Deserialize<object>(actionUpdate.FunctionArguments);
                        }
                        catch { }

                        logger.LogInformation("[AGENT] Tool call: {Tool}({Args})", toolName, actionUpdate.FunctionArguments);
                        await SseHelper.WriteToolStatusAsync(ctx.Response, toolName, toolArgs);

                        var result = await toolExecutor.ExecuteAsync(actionUpdate);

                        try
                        {
                            var parsed = System.Text.Json.JsonSerializer.Deserialize<List<System.Text.Json.JsonElement>>(result);
                            if (parsed != null) collectedSources.AddRange(parsed);
                        }
                        catch { }

                        toolOutputs.Add(new ToolOutput(actionUpdate.ToolCallId, result));
                        break;
                    }

                    case MessageContentUpdate contentUpdate when !string.IsNullOrEmpty(contentUpdate.Text):
                        await SseHelper.WriteTokenAsync(ctx.Response, contentUpdate.Text);
                        break;

                    case RunUpdate runUpdate when update.UpdateKind == StreamingUpdateReason.RunFailed:
                        var errorMsg = runUpdate.Value.LastError?.Message ?? "Run failed";
                        var errorCode = runUpdate.Value.LastError?.Code;
                        logger.LogError("[AGENT] Run failed: code={Code} error={Error} (resumed={Resumed})",
                            errorCode, errorMsg, !string.IsNullOrEmpty(req.ThreadId));

                        // Detect rate limit (429 / TPM / RPM)
                        if (IsRateLimitError(errorMsg, errorCode))
                        {
                            await SseHelper.WriteRateLimitAsync(ctx.Response,
                                "Has superado el límite de tokens por minuto. Espera un momento y reintenta.");
                            return;
                        }

                        // If we were resuming a thread and the run failed, signal to retry with a fresh thread
                        if (!string.IsNullOrEmpty(req.ThreadId))
                            throw new InvalidOperationException($"THREAD_RETRY:{errorMsg}");
                        await SseHelper.WriteErrorAsync(ctx.Response, errorMsg);
                        return;

                    case RunUpdate runUpdate when update.UpdateKind == StreamingUpdateReason.RunCompleted:
                        logger.LogInformation("[AGENT] Run completed: {Id}, status={Status}", runUpdate.Value.Id, runUpdate.Value.Status);
                        break;

                    default:
                        logger.LogWarning("[AGENT] Update: kind={Kind}, type={Type}", update.UpdateKind, update.GetType().Name);
                        break;
                }
            }

            if (toolOutputs.Count == 0)
                break;

            if (currentRun == null)
            {
                await SseHelper.WriteErrorAsync(ctx.Response, "Run state unavailable while submitting tool outputs.");
                return;
            }

            stream = agentsClient.Runs.SubmitToolOutputsToStreamAsync(currentRun, toolOutputs);
        }

        // ── Build deduplicated sources ──
        var seenSources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sources = collectedSources
            .Select(s =>
            {
                try
                {
                    var el = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(
                        System.Text.Json.JsonSerializer.Serialize(s));
                    var law = el.TryGetProperty("law", out var l) ? l.GetString() : null;
                    var section = el.TryGetProperty("section", out var sec) ? sec.GetString() : null;
                    var chapter = el.TryGetProperty("chapter", out var ch) ? ch.GetString() : null;
                    var collection = el.TryGetProperty("collection", out var col) ? col.GetString() : null;
                    var id = el.TryGetProperty("id", out var i) ? i.ToString() : null;
                    return new { id, law, section, chapter, collection };
                }
                catch { return null; }
            })
            .Where(s => s != null && seenSources.Add($"{s.law}|{s.section}"))
            .Take(20)
            .ToList();

        await SseHelper.WriteDoneAsync(ctx.Response, new
        {
            threadId = thread.Id,
            sources,
        });
    }

    private static bool IsRateLimitError(string message, string? code)
    {
        if (string.Equals(code, "rate_limit", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(code, "rate_limit_exceeded", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.IsNullOrEmpty(message)) return false;
        var m = message.AsSpan();
        return m.Contains("rate limit", StringComparison.OrdinalIgnoreCase)
            || m.Contains("429", StringComparison.Ordinal)
            || m.Contains("tokens per minute", StringComparison.OrdinalIgnoreCase)
            || m.Contains("TPM", StringComparison.Ordinal)
            || m.Contains("RPM", StringComparison.Ordinal)
            || m.Contains("quota", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Cancel any in_progress or requires_action runs on a thread.
    /// The Assistants API doesn't allow creating a new run while one is active.
    /// </summary>
    private static async Task CancelActiveRunsAsync(PersistentAgentsClient client, string threadId, ILogger logger)
    {
        try
        {
            await foreach (var run in client.Runs.GetRunsAsync(threadId))
            {
                var status = run.Status.ToString();
                if (status is "InProgress" or "Queued" or "RequiresAction" or "in_progress" or "queued" or "requires_action")
                {
                    logger.LogWarning("[AGENT] Cancelling active run {RunId} (status={Status}) on thread {ThreadId}",
                        run.Id, status, threadId);
                    try
                    {
                        await client.Runs.CancelRunAsync(threadId, run.Id);
                        // Wait a bit for cancellation to propagate
                        await Task.Delay(500);
                    }
                    catch (Exception ex)
                    {
                        logger.LogWarning("[AGENT] Failed to cancel run {RunId}: {Msg}", run.Id, ex.Message);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning("[AGENT] Failed to list runs for thread {ThreadId}: {Msg}", threadId, ex.Message);
        }
    }
}
