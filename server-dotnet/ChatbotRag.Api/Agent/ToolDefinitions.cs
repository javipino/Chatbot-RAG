using Azure.AI.Agents.Persistent;
using BinaryData = System.BinaryData;

namespace ChatbotRag.Api.Agent;

/// <summary>
/// Function tool definitions exposed to the persistent agent.
/// </summary>
public static class ToolDefinitions
{
    public static FunctionToolDefinition SearchNormativa { get; } = new(
        name: "search_normativa",
        description: """
            Search the Spanish labor and Social Security legislation database (BOE, ET, LGSS, LPRL, etc.)
            using hybrid semantic + keyword search. Use it to find relevant articles and regulations.
            Search terms should be concise technical-legal keywords (3-6 words in Spanish).
            Example: "vacaciones anuales retribuidas días disfrute", "incapacidad temporal cotización prestación".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                query = new { type = "string", description = "Search keywords (3-6 technical-legal terms in Spanish)" },
                top_k = new { type = "integer", description = "Number of results to return (default 8, max 15)", @default = 8 },
            },
            required = new[] { "query" }
        }));

    public static FunctionToolDefinition SearchSentencias { get; } = new(
        name: "search_sentencias",
        description: """
            Search the Supreme Court case law collection on Social Security and labor law.
            Use it when you need judicial precedents or court interpretations of a regulation.
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

    public static FunctionToolDefinition SearchCriterios { get; } = new(
        name: "search_criterios",
        description: """
            Search the INSS management criteria collection (Criterios de Gestión del INSS).
            These are official interpretive criteria from the National Social Security Institute
            on how to apply Social Security regulations in practice.
            Use it for questions about benefits calculation, eligibility, administrative procedures,
            or when you need the INSS's official position on how to interpret a regulation.
            Example: "jubilación anticipada coeficientes reductores bomberos", "incapacidad permanente total subsidio desempleo".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                query = new { type = "string", description = "Search keywords about INSS criteria (in Spanish)" },
                top_k = new { type = "integer", description = "Number of results (default 8, max 15)", @default = 8 },
            },
            required = new[] { "query" }
        }));

    public static FunctionToolDefinition GetArticle { get; } = new(
        name: "get_article",
        description: """
            Fetch a specific article from the regulations by its number and law name.
            Use it when you know exactly which article you need (e.g., if a search result mentions it).
            Example: article_number="48", law_name="Estatuto de los Trabajadores".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                article_number = new { type = "string", description = "Article number. E.g.: '48', '205.1'" },
                law_name = new { type = "string", description = "Law name. E.g.: 'Estatuto de los Trabajadores', 'LGSS', 'Ley de Prevención de Riesgos Laborales'" },
            },
            required = new[] { "article_number", "law_name" }
        }));

    public static FunctionToolDefinition GetRelatedChunks { get; } = new(
        name: "get_related_chunks",
        description: """
            Fetch the chunks referenced by a given chunk (cited articles, related provisions).
            Useful for following cross-references from an article you've already found.
            Provide the id of the chunk obtained from search_normativa or get_article.
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
        SearchNormativa,
        SearchSentencias,
        SearchCriterios,
        GetArticle,
        GetRelatedChunks,
    ];
}
