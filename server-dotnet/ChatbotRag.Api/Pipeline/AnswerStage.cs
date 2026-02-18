using OpenAI.Chat;
using ChatbotRag.Api.Models;
using ChatbotRag.Api.Services;
using ApiChatMessage = ChatbotRag.Api.Models.ChatMessage;
using OaiChatMessage = OpenAI.Chat.ChatMessage;

namespace ChatbotRag.Api.Pipeline;

/// <summary>
/// Stage 5: Unified Answer + Evaluation (GPT-5.2).
/// Ported from server/pipeline/answer.js.
/// </summary>
public class AnswerStage(OpenAiService openAi)
{
    private const string AnswerWrapper =
        """
        INSTRUCCIONES DE FORMATO DE RESPUESTA:

        Responde a la pregunta del usuario usando los fragmentos de normativa proporcionados, eres un experto en seguridad social en españa.

        Tu respuesta DEBE tener EXACTAMENTE estas dos secciones, separadas por el delimitador:

        1. Primero tu respuesta completa al usuario.

        ===META===

        2. Después del delimitador, metadata en formato estructurado:

        USED|índices de los fragmentos que has USADO (separados por comas)
        DROP|índices de fragmentos que NO aportan nada (separados por comas)
        NEED|... (solo si FALTA información CRÍTICA)

        Formatos de NEED (elige el apropiado):
        - Si sabes el artículo exacto: NEED|número_artículo|nombre_ley (la ley es OBLIGATORIA, sin ella no podemos buscar)
        - Si necesitas información pero no sabes el artículo: NEED|palabras clave de búsqueda

        Reglas para META:
        - USED y DROP son OBLIGATORIOS. Si todos fueron útiles, pon DROP|ninguno
        - NEED es OPCIONAL. Solo si realmente falta algo imprescindible.

        Ejemplos:
        ===META===
        USED|0,2,5,7
        DROP|1,3,4,6
        NEED|48|Estatuto Trabajadores
        NEED|régimen especial trabajadores autónomos cotización
        """;

    /// <summary>Build numbered context string from search results.</summary>
    public static string BuildContext(IList<ChunkResult> results)
    {
        if (results.Count == 0)
            return "No se encontraron resultados relevantes en la normativa.";

        return string.Join("\n\n---\n\n", results.Select((doc, i) =>
        {
            var parts = new List<string> { $"[{i}] {doc.Law ?? "?"} > {doc.Section ?? "?"}" };
            if (!string.IsNullOrEmpty(doc.Chapter)) parts.Add($"Capítulo: {doc.Chapter}");
            if (!string.IsNullOrEmpty(doc.Resumen)) parts.Add($"Resumen: {doc.Resumen}");
            if (!string.IsNullOrEmpty(doc.Text)) parts.Add($"Texto: {doc.Text}");
            return string.Join('\n', parts);
        }));
    }

    /// <summary>
    /// Build the message array for GPT-5.2 (system + context + instructions + conversation).
    /// </summary>
    private static List<OaiChatMessage> BuildMessages(string context, IList<ApiChatMessage> messages)
    {
        var augmented = new List<OaiChatMessage>
        {
            new SystemChatMessage(AppConfig.SystemPrompt),
            new SystemChatMessage($"CONTEXTO DE NORMATIVA:\n\n{context}"),
            new SystemChatMessage(AnswerWrapper),
        };

        foreach (var msg in messages.TakeLast(6))
        {
            if (msg.Role == "user") augmented.Add(new UserChatMessage(msg.Content));
            else if (msg.Role == "assistant") augmented.Add(new AssistantChatMessage(msg.Content));
        }

        return augmented;
    }

    /// <summary>Streaming version — yields answer tokens and then the parsed meta.</summary>
    public async IAsyncEnumerable<(string? Token, AnswerMeta? Meta)> GenerateStreamingAsync(
        string context, IList<ApiChatMessage> messages)
    {
        var chatMessages = BuildMessages(context, messages);
        var rawBuilder = new System.Text.StringBuilder();

        await foreach (var token in openAi.CallGpt52StreamingAsync(chatMessages))
        {
            rawBuilder.Append(token);
            yield return (token, null);
        }

        // Parse META section
        var meta = ParseMeta(rawBuilder.ToString());
        yield return (null, meta);
    }

    /// <summary>Non-streaming version for NEED retry calls.</summary>
    public async Task<(string Answer, AnswerMeta Meta)> GenerateAsync(
        string context, IList<ApiChatMessage> messages)
    {
        var chatMessages = BuildMessages(context, messages);
        var raw = await openAi.CallGpt52Async(chatMessages);
        var meta = ParseMeta(raw);

        const string delimiter = "===META===";
        var idx = raw.IndexOf(delimiter, StringComparison.Ordinal);
        var answer = idx >= 0 ? raw[..idx].Trim() : raw.Trim();
        return (answer, meta);
    }

    private static AnswerMeta ParseMeta(string raw)
    {
        const string delimiter = "===META===";
        var meta = new AnswerMeta();
        var idx = raw.IndexOf(delimiter, StringComparison.Ordinal);
        if (idx < 0) return meta;

        var metaSection = raw[(idx + delimiter.Length)..].Trim();
        foreach (var line in metaSection.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("USED|"))
            {
                var val = trimmed[5..].Trim();
                if (!string.IsNullOrEmpty(val) && val != "ninguno")
                    meta.Used = val.Split(',').Select(s => int.TryParse(s.Trim(), out var n) ? n : -1)
                                   .Where(n => n >= 0).ToList();
            }
            else if (trimmed.StartsWith("DROP|"))
            {
                var val = trimmed[5..].Trim();
                if (!string.IsNullOrEmpty(val) && val != "ninguno")
                    meta.Drop = val.Split(',').Select(s => int.TryParse(s.Trim(), out var n) ? n : -1)
                                   .Where(n => n >= 0).ToList();
            }
            else if (trimmed.StartsWith("NEED|"))
            {
                var parts = trimmed.Split('|');
                if (parts.Length >= 3)
                {
                    var artMatch = System.Text.RegularExpressions.Regex.Match(parts[1].Trim(), @"(\d+(?:\.\d+)?)");
                    if (artMatch.Success)
                        meta.Need.Add(new NeedRequest { Type = "article", Art = artMatch.Groups[1].Value, Ley = parts[2].Trim() });
                }
                else if (parts.Length == 2 && parts[1].Trim().Length > 0)
                {
                    meta.Need.Add(new NeedRequest { Type = "query", Query = parts[1].Trim() });
                }
            }
        }
        return meta;
    }
}

public class AnswerMeta
{
    public List<int> Used { get; set; } = [];
    public List<int> Drop { get; set; } = [];
    public List<NeedRequest> Need { get; set; } = [];
}

public class NeedRequest
{
    public string Type { get; set; } = "";   // "article" | "query"
    public string? Art { get; set; }
    public string? Ley { get; set; }
    public string? Query { get; set; }
}
