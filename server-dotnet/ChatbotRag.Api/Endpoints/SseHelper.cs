using System.Text;
using System.Text.Json;

namespace ChatbotRag.Api.Endpoints;

/// <summary>
/// Shared SSE (Server-Sent Events) utilities.
/// Event protocol:
///   event: token     → { text: "..." }
///   event: tool_status → { tool: "...", args: {...} }
///   event: done      → { contextChunkIds?: [...], threadId?: "...", sources: [...] }
///   event: error     → { message: "..." }
/// </summary>
public static class SseHelper
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task WriteTokenAsync(HttpResponse response, string text)
        => await WriteEventAsync(response, "token", new { text });

    public static async Task WriteToolStatusAsync(HttpResponse response, string tool, object? args = null)
        => await WriteEventAsync(response, "tool_status", new { tool, args });

    public static async Task WriteDoneAsync(HttpResponse response, object data)
        => await WriteEventAsync(response, "done", data);

    public static async Task WriteErrorAsync(HttpResponse response, string message)
        => await WriteEventAsync(response, "error", new { message });

    public static void SetSseHeaders(HttpResponse response)
    {
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        response.Headers.Connection = "keep-alive";
        response.Headers.Append("X-Accel-Buffering", "no"); // disable nginx buffering if applicable
    }

    private static async Task WriteEventAsync(HttpResponse response, string eventType, object data)
    {
        var json = JsonSerializer.Serialize(data, _json);
        var sb = new StringBuilder();
        sb.Append("event: ").AppendLine(eventType);
        sb.Append("data: ").AppendLine(json);
        sb.AppendLine();
        await response.WriteAsync(sb.ToString(), Encoding.UTF8);
        await response.Body.FlushAsync();
    }
}
