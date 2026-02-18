using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ChatbotRag.Api.Models;

namespace ChatbotRag.Api.Endpoints;

/// <summary>
/// POST /api/chat
/// Proxy for direct model calls. Streams tokens via SSE for Azure OpenAI deployments.
/// Maintains backward-compatible contract: accepts _host, _path, _apikey in body.
/// </summary>
public static class ChatEndpoints
{
    private static readonly JsonSerializerOptions _json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static void MapChat(this WebApplication app)
    {
        app.MapPost("/api/chat", async (HttpContext ctx, IHttpClientFactory httpClientFactory, ILogger<ChatProxyRequest> logger) =>
        {
            using var bodyReader = new StreamReader(ctx.Request.Body);
            var bodyStr = await bodyReader.ReadToEndAsync();
            if (string.IsNullOrEmpty(bodyStr))
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsJsonAsync(new { error = "Empty body" });
                return;
            }

            JsonObject body;
            try { body = JsonNode.Parse(bodyStr)!.AsObject(); }
            catch
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsJsonAsync(new { error = "Invalid JSON" });
                return;
            }

            // Extract + strip routing overrides
            var host = body["_host"]?.GetValue<string>()
                ?? $"{AppConfig.PrincipalEndpoint}";
            var path = body["_path"]?.GetValue<string>()
                ?? "/openai/deployments/gpt-5.2/chat/completions?api-version=2025-01-01-preview";
            var apiKey = body["_apikey"]?.GetValue<string>() ?? AppConfig.PrincipalKey;
            body.Remove("_host");
            body.Remove("_path");
            body.Remove("_apikey");

            // Normalize host — strip protocol if present
            if (host.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                host.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                host = new Uri(host).Host;

            // ── Check if client wants streaming ──
            bool wantsStream = body["stream"]?.GetValue<bool>() == true;

            try
            {
                var httpClient = httpClientFactory.CreateClient("forward");
                var request = new HttpRequestMessage(HttpMethod.Post, $"https://{host}{path}");
                request.Headers.Add("api-key", apiKey);
                request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");

                if (wantsStream)
                {
                    // Forward streaming response directly as SSE to client
                    SseHelper.SetSseHeaders(ctx.Response);
                    var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

                    if (!response.IsSuccessStatusCode)
                    {
                        var errorBody = await response.Content.ReadAsStringAsync();
                        await SseHelper.WriteErrorAsync(ctx.Response, $"Upstream {(int)response.StatusCode}: {errorBody[..Math.Min(500, errorBody.Length)]}");
                        return;
                    }

                    await using var responseStream = await response.Content.ReadAsStreamAsync();
                    using var reader = new StreamReader(responseStream);
                    while (!reader.EndOfStream && !ctx.RequestAborted.IsCancellationRequested)
                    {
                        var line = await reader.ReadLineAsync();
                        if (line == null) break;

                        // Parse SSE "data:" lines from upstream OpenAI stream
                        if (line.StartsWith("data: "))
                        {
                            var data = line[6..].Trim();
                            if (data == "[DONE]")
                            {
                                await SseHelper.WriteDoneAsync(ctx.Response, new { });
                                break;
                            }
                            try
                            {
                                using var doc = JsonDocument.Parse(data);
                                var root = doc.RootElement;
                                // chat completions format
                                if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0)
                                {
                                    var delta = choices[0];
                                    string? text = null;
                                    if (delta.TryGetProperty("delta", out var d) && d.TryGetProperty("content", out var c))
                                        text = c.GetString();
                                    else if (delta.TryGetProperty("text", out var t))
                                        text = t.GetString();
                                    if (!string.IsNullOrEmpty(text))
                                        await SseHelper.WriteTokenAsync(ctx.Response, text);
                                }
                                // responses API format
                                else if (root.TryGetProperty("type", out var typeEl))
                                {
                                    var type = typeEl.GetString();
                                    if (type == "response.text.delta" && root.TryGetProperty("delta", out var deltaTxt))
                                    {
                                        var text = deltaTxt.GetString();
                                        if (!string.IsNullOrEmpty(text))
                                            await SseHelper.WriteTokenAsync(ctx.Response, text);
                                    }
                                    else if (type == "response.done")
                                    {
                                        await SseHelper.WriteDoneAsync(ctx.Response, new { });
                                    }
                                }
                            }
                            catch { /* ignore malformed chunks */ }
                        }
                    }
                }
                else
                {
                    // Non-streaming: forward and return full response
                    var response = await httpClient.SendAsync(request);
                    var responseBody = await response.Content.ReadAsStringAsync();

                    ctx.Response.StatusCode = (int)response.StatusCode;
                    ctx.Response.ContentType = "application/json";
                    await ctx.Response.WriteAsync(responseBody);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Chat proxy error");
                ctx.Response.StatusCode = 502;
                await ctx.Response.WriteAsJsonAsync(new { error = $"Error conectando: {ex.Message}" });
            }
        })
        .WithName("ChatProxy");
    }
}
