using OpenAI.Chat;
using ChatbotRag.Api.Services;
using ApiChatMessage = ChatbotRag.Api.Models.ChatMessage;

namespace ChatbotRag.Api.Pipeline;

/// <summary>
/// Stage 1: Query Expansion using GPT-5 Nano.
/// Ported from server/pipeline/expand.js.
/// </summary>
public class ExpandStage(OpenAiService openAi, ILogger<ExpandStage> logger)
{
    private const string ExpandSystemPrompt =
        """
        You are a legal assistant. Your task is to generate the SEARCH KEYWORDS needed to find relevant regulations in a database of Spanish labor and Social Security legislation.

        RESPOND ONLY with a JSON array of strings. Each string is a search query of 3-6 keywords.

        Rules:
        - Each query must be SHORT: only 3-6 relevant keywords. Do NOT write full sentences.
        - Do NOT include article numbers (e.g., "artículo 48", "art. 250"). Semantic search does not need them.
        - Include both the technical legal term AND the colloquial one if they differ.
        - If the question is SIMPLE (one concept), return an array with a single query.
          Example: "¿cuántos días de vacaciones tengo?" → ["vacaciones anuales retribuidas días disfrute"]
        - If the question is COMPLEX (compares or involves several concepts), return MULTIPLE queries (one per concept).
          Example: "¿qué diferencia hay entre despido objetivo y disciplinario?" →
          ["despido objetivo causas indemnización",
           "despido disciplinario causas procedimiento"]
        - Colloquial-to-legal equivalences:
          * "baja de maternidad" → "suspensión contrato nacimiento cuidado menor"
          * "despido" → "extinción contrato despido"
          * "paro" → "prestación desempleo"
          * "baja médica" → "incapacidad temporal prestación"
          * "pensión" → "jubilación prestación contributiva"
          * "finiquito" → "liquidación haberes extinción contrato"
        - Maximum 4 queries. Group closely related concepts if there are more.

        RESPOND ONLY with the JSON array. No explanations, no markdown, no backticks.
        """;

    private const string ExpandFollowupPrompt =
        """
        You are a legal assistant. The user is asking a FOLLOW-UP question about the previous conversation.
        We already have the regulatory context from the previous question (it will be injected automatically).
        Your task is to generate ONLY the ADDITIONAL searches needed for NEW concepts appearing in this follow-up question.

        RESPOND ONLY with a JSON array of strings (3-6 keywords each).
        - If the question introduces no new concepts (e.g., "can you explain that better?"), return an empty array: []
        - If it introduces new concepts, generate queries ONLY for those new concepts.
          Example (if the conversation was about vacations): "¿y si no me las dan?" → ["sanción incumplimiento empresario vacaciones reclamación"]
        - Do NOT repeat searches for concepts already covered in the previous conversation.
        - Maximum 3 new queries.

        RESPOND ONLY with the JSON array. No explanations, no markdown, no backticks.
        """;

    /// <summary>
    /// Decompose user query into 1-4 short keyword search strings.
    /// </summary>
    public async Task<string[]> ExpandQueryAsync(
        string query, IList<ApiChatMessage> conversationHistory, bool hasCarryover = false)
    {
        try
        {
            bool isFollowUp = hasCarryover && conversationHistory.Count > 1;
            var systemPrompt = isFollowUp ? ExpandFollowupPrompt : ExpandSystemPrompt;

            var messages = new List<ChatMessage> { new SystemChatMessage(systemPrompt) };

            if (isFollowUp && conversationHistory.Count > 0)
            {
                var recent = conversationHistory.TakeLast(4);
                foreach (var msg in recent)
                {
                    var content = (msg.Content ?? "")[..Math.Min(200, msg.Content?.Length ?? 0)];
                    if (msg.Role == "user") messages.Add(new UserChatMessage(content));
                    else if (msg.Role == "assistant") messages.Add(new AssistantChatMessage(content));
                }
            }

            // Ensure current query is the final user message
            if (messages[^1] is not UserChatMessage lastUser || lastUser.Content[0].Text != query)
                messages.Add(new UserChatMessage(query));

            var nanoResponse = await openAi.CallNanoAsync(messages);

            // Parse JSON array (handle markdown code fences)
            var cleaned = System.Text.RegularExpressions.Regex.Replace(nanoResponse, @"```json\s*|```\s*", "").Trim();
            var match = System.Text.RegularExpressions.Regex.Match(cleaned, @"\[[\s\S]*\]");
            if (match.Success)
            {
                var queries = System.Text.Json.JsonSerializer.Deserialize<string[]>(match.Value);
                if (queries != null && queries.All(q => q is string))
                    return queries.Take(4).ToArray();
            }

            // Fallback
            return nanoResponse.Trim().Length > 0 ? [nanoResponse.Trim()] : [query];
        }
        catch (Exception ex)
        {
            logger.LogWarning("Query expansion failed, using original: {Message}", ex.Message);
            return [query];
        }
    }
}
