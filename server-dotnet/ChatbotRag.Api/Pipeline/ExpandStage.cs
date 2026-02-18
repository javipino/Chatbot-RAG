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
        Eres un asistente legal. Tu tarea es generar las PALABRAS CLAVE de búsqueda necesarias para encontrar normativa relevante en una base de datos de legislación laboral y de Seguridad Social española.

        RESPONDE SOLO con un JSON array de strings. Cada string es una búsqueda de 3-6 palabras clave.

        Reglas:
        - Cada query debe ser CORTA: solo 3-6 palabras clave relevantes. NO escribas frases completas.
        - NO incluyas números de artículo (ej: "artículo 48", "art. 250"). La búsqueda semántica no los necesita.
        - Incluye el término técnico-legal Y el coloquial si son distintos.
        - Si la pregunta es SIMPLE (un solo concepto), devuelve UN array con una sola query.
          Ejemplo: "¿cuántos días de vacaciones tengo?" → ["vacaciones anuales retribuidas días disfrute"]
        - Si la pregunta es COMPLEJA (compara o involucra varios conceptos), devuelve VARIAS queries (una por concepto).
          Ejemplo: "¿qué diferencia hay entre despido objetivo y disciplinario?" →
          ["despido objetivo causas indemnización",
           "despido disciplinario causas procedimiento"]
        - Equivalencias coloquiales a términos legales:
          * "baja de maternidad" → "suspensión contrato nacimiento cuidado menor"
          * "despido" → "extinción contrato despido"
          * "paro" → "prestación desempleo"
          * "baja médica" → "incapacidad temporal prestación"
          * "pensión" → "jubilación prestación contributiva"
          * "finiquito" → "liquidación haberes extinción contrato"
        - Máximo 4 queries. Agrupa conceptos cercanos si son más.

        RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.
        """;

    private const string ExpandFollowupPrompt =
        """
        Eres un asistente legal. El usuario hace una pregunta de CONTINUACIÓN sobre la conversación previa.
        Ya tenemos el contexto normativo de la pregunta anterior (se inyectará automáticamente).
        Tu tarea es generar SOLO las búsquedas ADICIONALES necesarias para los conceptos NUEVOS que aparecen en esta pregunta de continuación.

        RESPONDE SOLO con un JSON array de strings (3-6 palabras clave cada una).
        - Si la pregunta no introduce conceptos nuevos (ej: "¿puedes explicarlo mejor?"), devuelve un array vacío: []
        - Si introduce conceptos nuevos, genera queries SOLO para esos conceptos nuevos.
          Ejemplo (si la conversación era sobre vacaciones): "¿y si no me las dan?" → ["sanción incumplimiento empresario vacaciones reclamación"]
        - NO repitas búsquedas de conceptos que ya se trataron en la conversación anterior.
        - Máximo 3 queries nuevas.

        RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.
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
