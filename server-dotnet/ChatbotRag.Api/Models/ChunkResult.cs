namespace ChatbotRag.Api.Models;

/// <summary>Unified chunk model shared between pipeline and agent tools.</summary>
public class ChunkResult
{
    public object? Id { get; set; }
    public string? Law { get; set; }
    public string? Section { get; set; }
    public string? Chapter { get; set; }
    public string? Text { get; set; }
    public string? Resumen { get; set; }
    public string? Collection { get; set; }
    public List<object>? Refs { get; set; }

    // Scoring
    public double Score { get; set; }
    public double WeightedScore { get; set; }
    public double FinalScore { get; set; }

    // Metadata flags
    public bool Carryover { get; set; }
    public bool Chased { get; set; }
    public string? RefReason { get; set; }

    // ── Criterio-specific metadata ──
    public string? Fecha { get; set; }
    public string? CriterioNum { get; set; }
    public string? Titulo { get; set; }
    public List<string>? PalabrasClave { get; set; }
}
