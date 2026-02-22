using System.Text.Json.Serialization;

namespace ChatbotRag.Api.Models;

// ── Qdrant REST API DTOs ──

public class QdrantQueryRequest
{
    [JsonPropertyName("prefetch")]
    public List<QdrantPrefetch>? Prefetch { get; set; }

    [JsonPropertyName("query")]
    public object? Query { get; set; }

    [JsonPropertyName("using")]
    public string? Using { get; set; }

    [JsonPropertyName("filter")]
    public object? Filter { get; set; }

    [JsonPropertyName("limit")]
    public int Limit { get; set; }

    [JsonPropertyName("with_payload")]
    public bool WithPayload { get; set; } = true;
}

public class QdrantPrefetch
{
    [JsonPropertyName("query")]
    public object? Query { get; set; }

    [JsonPropertyName("using")]
    public string? Using { get; set; }

    [JsonPropertyName("limit")]
    public int Limit { get; set; }
}

public class QdrantSparseQuery
{
    [JsonPropertyName("indices")]
    public int[] Indices { get; set; } = [];

    [JsonPropertyName("values")]
    public float[] Values { get; set; } = [];
}

public class QdrantFusionQuery
{
    [JsonPropertyName("fusion")]
    public string Fusion { get; set; } = "rrf";
}

public class QdrantQueryResponse
{
    [JsonPropertyName("result")]
    public QdrantQueryResult? Result { get; set; }
}

public class QdrantQueryResult
{
    [JsonPropertyName("points")]
    public List<QdrantPoint>? Points { get; set; }
}

public class QdrantFetchRequest
{
    [JsonPropertyName("ids")]
    public List<object> Ids { get; set; } = [];

    [JsonPropertyName("with_payload")]
    public bool WithPayload { get; set; } = true;

    [JsonPropertyName("with_vector")]
    public bool WithVector { get; set; } = false;
}

public class QdrantScrollRequest
{
    [JsonPropertyName("filter")]
    public object? Filter { get; set; }

    [JsonPropertyName("limit")]
    public int Limit { get; set; }

    [JsonPropertyName("with_payload")]
    public bool WithPayload { get; set; } = true;
}

public class QdrantScrollResponse
{
    [JsonPropertyName("result")]
    public QdrantScrollResult? Result { get; set; }
}

public class QdrantScrollResult
{
    [JsonPropertyName("points")]
    public List<QdrantPoint>? Points { get; set; }
}

public class QdrantFetchResponse
{
    [JsonPropertyName("result")]
    public List<QdrantPoint>? Result { get; set; }
}

public class QdrantPoint
{
    [JsonPropertyName("id")]
    public object? Id { get; set; }

    [JsonPropertyName("score")]
    public double Score { get; set; }

    [JsonPropertyName("payload")]
    public QdrantPayload? Payload { get; set; }
}

public class QdrantPayload
{
    [JsonPropertyName("law")]
    public string? Law { get; set; }

    [JsonPropertyName("section")]
    public string? Section { get; set; }

    [JsonPropertyName("chapter")]
    public string? Chapter { get; set; }

    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("resumen")]
    public string? Resumen { get; set; }

    [JsonPropertyName("refs")]
    public List<object>? Refs { get; set; }

    [JsonPropertyName("collection")]
    public string? Collection { get; set; }

    // ── Criterio-specific fields ──

    [JsonPropertyName("fecha")]
    public string? Fecha { get; set; }

    [JsonPropertyName("criterio_num")]
    public string? CriterioNum { get; set; }

    [JsonPropertyName("titulo")]
    public string? Titulo { get; set; }

    [JsonPropertyName("palabras_clave")]
    public List<string>? PalabrasClave { get; set; }

    [JsonPropertyName("descripcion")]
    public string? Descripcion { get; set; }
}
