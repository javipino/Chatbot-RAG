using Azure.AI.Agents.Persistent;
using BinaryData = System.BinaryData;

namespace ChatbotRag.Api.Agent;

/// <summary>
/// Function tool definitions exposed to the persistent agent.
/// Combined browse/fetch tools to force backend parallelism and minimize tool-call rounds.
/// </summary>
public static class ToolDefinitions
{
    public static FunctionToolDefinition Browse { get; } = new(
        name: "browse",
        description: """
            Search BOTH the legislation database (normativa) AND the INSS criteria collection simultaneously.
            Returns lightweight summaries from each collection — NO full text.
            After reviewing summaries, use fetch_details with the relevant IDs to get full text.
            Search terms should be concise technical-legal keywords (3-6 words in Spanish).
            Example: "vacaciones anuales retribuidas días disfrute", "incapacidad temporal cotización prestación".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                query = new { type = "string", description = "Search keywords (3-6 technical-legal terms in Spanish)" },
            },
            required = new[] { "query" }
        }));

    public static FunctionToolDefinition FetchDetails { get; } = new(
        name: "fetch_details",
        description: """
            Fetch the FULL TEXT of specific chunks by their IDs from normativa and/or criterios collections.
            Use this after browse to retrieve complete content for the chunks you identified as relevant.
            Provide IDs for each collection separately. Request only the IDs you need (typically 3-6 per collection).
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                normativa_ids = new { type = "array", items = new { type = "integer" }, description = "Chunk IDs from normativa results (optional)" },
                criterios_ids = new { type = "array", items = new { type = "integer" }, description = "Chunk IDs from criterios results (optional)" },
            },
            required = Array.Empty<string>()
        }));

    public static FunctionToolDefinition SearchSentencias { get; } = new(
        name: "search_sentencias",
        description: """
            Search the Supreme Court case law collection on Social Security and labor law.
            ⚠️ EXCEPTIONAL USE ONLY — key rulings are already in INSS criteria.
            Use only when you need specific judicial precedents not covered by criteria.
            Example: "pensión viudedad convivencia more uxorio", "despido nulo discriminación".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                query = new { type = "string", description = "Case law search keywords (in Spanish)" },
                top_k = new { type = "integer", description = "Number of results (default 5, max 10)", @default = 5 },
            },
            required = new[] { "query" }
        }));

    public static FunctionToolDefinition GetRelatedChunks { get; } = new(
        name: "get_related_chunks",
        description: """
            Fetch the chunks referenced by a given chunk (cited articles, related provisions).
            Useful for following cross-references from an article you've already found.
            Provide the id of the chunk obtained from browse or fetch_details.
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                chunk_id = new { type = "string", description = "Chunk ID (UUID or integer) to get references from" },
            },
            required = new[] { "chunk_id" }
        }));

    // IMPORTANT: Must be declared AFTER all tool properties to ensure they are
    // initialized before this collection expression captures their values.
    public static readonly IReadOnlyList<ToolDefinition> All =
    [
        Browse,
        FetchDetails,
        SearchSentencias,
        GetRelatedChunks,
    ];
}
