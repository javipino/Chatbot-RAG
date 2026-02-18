using System.Text.Json.Serialization;

namespace ChatbotRag.Api.Models;

public class ChatMessage
{
    [JsonPropertyName("role")]
    public string Role { get; set; } = "";

    [JsonPropertyName("content")]
    public string Content { get; set; } = "";
}

// ── /api/rag-pipeline ──

public class RagPipelineRequest
{
    [JsonPropertyName("messages")]
    public List<ChatMessage> Messages { get; set; } = [];

    [JsonPropertyName("previousChunkIds")]
    public List<object>? PreviousChunkIds { get; set; }
}

public class SourceInfo
{
    [JsonPropertyName("id")]
    public object? Id { get; set; }

    [JsonPropertyName("law")]
    public string? Law { get; set; }

    [JsonPropertyName("section")]
    public string? Section { get; set; }

    [JsonPropertyName("chapter")]
    public string? Chapter { get; set; }

    [JsonPropertyName("collection")]
    public string? Collection { get; set; }

    [JsonPropertyName("carryover")]
    public bool Carryover { get; set; }
}

// ── /api/rag-agent ──

public class RagAgentRequest
{
    [JsonPropertyName("message")]
    public string Message { get; set; } = "";

    [JsonPropertyName("threadId")]
    public string? ThreadId { get; set; }
}

// ── /api/chat ──

public class ChatProxyRequest
{
    [JsonPropertyName("messages")]
    public List<ChatMessage>? Messages { get; set; }

    [JsonPropertyName("input")]
    public object? Input { get; set; }

    [JsonPropertyName("model")]
    public string? Model { get; set; }

    [JsonPropertyName("_host")]
    public string? Host { get; set; }

    [JsonPropertyName("_path")]
    public string? Path { get; set; }

    [JsonPropertyName("_apikey")]
    public string? ApiKey { get; set; }
}
