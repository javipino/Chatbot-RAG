using System.Text.Json.Serialization;

namespace ChatbotRag.Api.Models;

// ── Admin panel DTOs ──

public class NormativaChunkInput
{
    [JsonPropertyName("law")] public string Law { get; set; } = "";
    [JsonPropertyName("chapter")] public string? Chapter { get; set; }
    [JsonPropertyName("section")] public string Section { get; set; } = "";
    [JsonPropertyName("text")] public string Text { get; set; } = "";
}

public class AdminSearchResult
{
    [JsonPropertyName("id")] public object? Id { get; set; }
    [JsonPropertyName("law")] public string? Law { get; set; }
    [JsonPropertyName("section")] public string? Section { get; set; }
    [JsonPropertyName("chapter")] public string? Chapter { get; set; }
    [JsonPropertyName("text")] public string? Text { get; set; }
    [JsonPropertyName("collection")] public string? Collection { get; set; }

    // Criterio-specific
    [JsonPropertyName("titulo")] public string? Titulo { get; set; }
    [JsonPropertyName("descripcion")] public string? Descripcion { get; set; }
    [JsonPropertyName("fecha")] public string? Fecha { get; set; }
    [JsonPropertyName("criterioNum")] public string? CriterioNum { get; set; }
    [JsonPropertyName("palabrasClave")] public List<string>? PalabrasClave { get; set; }
}

public class CollectionInfoResponse
{
    [JsonPropertyName("result")] public CollectionInfoResult? Result { get; set; }
}

public class CollectionInfoResult
{
    [JsonPropertyName("points_count")] public long PointsCount { get; set; }
}
