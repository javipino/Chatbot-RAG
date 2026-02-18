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
        RESPONSE FORMAT INSTRUCTIONS:

        Answer the user's question using the provided regulation fragments. You are an expert in Spanish Social Security law.

        Your response MUST contain EXACTLY these two sections, separated by the delimiter:

        1. First, your complete answer to the user (in Spanish).

        ===META===

        2. After the delimiter, structured metadata:

        USED|indices of fragments you USED (comma-separated)
        DROP|indices of fragments that were NOT useful (comma-separated)
        NEED|... (only if CRITICAL information is MISSING)

        NEED formats (choose as appropriate):
        - If you know the exact article: NEED|article_number|law_name (law is MANDATORY, we cannot search without it)
        - If you need information but don't know the article: NEED|search keywords

        META rules:
        - USED and DROP are MANDATORY. If all fragments were useful, write DROP|none
        - NEED is OPTIONAL. Only use it if something truly essential is missing.

        Example:
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
            return "No relevant results found in the regulations.";

        return string.Join("\n\n---\n\n", results.Select((doc, i) =>
        {
            var parts = new List<string> { $"[{i}] {doc.Law ?? "?"} > {doc.Section ?? "?"}" };
            if (!string.IsNullOrEmpty(doc.Chapter)) parts.Add($"Chapter: {doc.Chapter}");
            if (!string.IsNullOrEmpty(doc.Resumen)) parts.Add($"Summary: {doc.Resumen}");
            if (!string.IsNullOrEmpty(doc.Text)) parts.Add($"Text: {doc.Text}");
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
            new SystemChatMessage($"REGULATION CONTEXT:\n\n{context}"),
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

        const string delimiter = "===META";
        var idx = raw.IndexOf(delimiter, StringComparison.Ordinal);
        var answer = idx >= 0 ? raw[..idx].Trim() : raw.Trim();
        return (answer, meta);
    }

    private static AnswerMeta ParseMeta(string raw)
    {
        const string delimiter = "===META";
        var meta = new AnswerMeta();
        var idx = raw.IndexOf(delimiter, StringComparison.Ordinal);
        if (idx < 0) return meta;

        // Skip delimiter and any trailing '=' or whitespace
        var afterDelim = raw[(idx + delimiter.Length)..];
        var metaSection = afterDelim.TrimStart('=').Trim();
        foreach (var line in metaSection.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("USED|"))
            {
                var val = trimmed[5..].Trim();
                if (!string.IsNullOrEmpty(val) && val != "none")
                    meta.Used = val.Split(',').Select(s => int.TryParse(s.Trim(), out var n) ? n : -1)
                                   .Where(n => n >= 0).ToList();
            }
            else if (trimmed.StartsWith("DROP|"))
            {
                var val = trimmed[5..].Trim();
                if (!string.IsNullOrEmpty(val) && val != "none")
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
