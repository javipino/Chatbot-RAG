using Azure.AI.Agents.Persistent;
using BinaryData = System.BinaryData;

namespace ChatbotRag.Api.Agent;

/// <summary>
/// Function tool definitions exposed to the persistent agent.
/// </summary>
public static class ToolDefinitions
{
    public static readonly IReadOnlyList<ToolDefinition> All =
    [
        SearchNormativa,
        SearchSentencias,
        GetArticle,
        GetRelatedChunks,
    ];

    public static FunctionToolDefinition SearchNormativa { get; } = new(
        name: "search_normativa",
        description: """
            Busca en la base de datos de normativa laboral y de Seguridad Social española (BOE, ET, LGSS, LPRL, etc.)
            usando búsqueda híbrida semántica + palabras clave. Úsala para encontrar artículos y regulaciones relevantes.
            Los términos deben ser técnico-legales y concisos (3-6 palabras).
            Ejemplo: "vacaciones anuales retribuidas días disfrute", "incapacidad temporal cotización prestación".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                query = new { type = "string", description = "Palabras clave de búsqueda (3-6 términos técnico-legales)" },
                top_k = new { type = "integer", description = "Número de resultados a devolver (default 8, max 15)", @default = 8 },
            },
            required = new[] { "query" }
        }));

    public static FunctionToolDefinition SearchSentencias { get; } = new(
        name: "search_sentencias",
        description: """
            Busca en la colección de jurisprudencia del Tribunal Supremo sobre Seguridad Social y derecho laboral.
            Úsala cuando necesites precedentes judiciales o interpretaciones de los tribunales sobre una norma.
            Ejemplo: "pensión viudedad convivencia more uxorio", "despido nulo discriminación".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                query = new { type = "string", description = "Palabras clave de búsqueda jurisprudencial" },
                top_k = new { type = "integer", description = "Número de resultados (default 5, max 10)", @default = 5 },
            },
            required = new[] { "query" }
        }));

    public static FunctionToolDefinition GetArticle { get; } = new(
        name: "get_article",
        description: """
            Obtiene un artículo específico de la normativa por su número y ley.
            Úsala cuando sepas exactamente qué artículo necesitas (p. ej., si una búsqueda lo menciona).
            Ejemplo: article_number="48", law_name="Estatuto de los Trabajadores".
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                article_number = new { type = "string", description = "Número del artículo. Ej: '48', '205.1'" },
                law_name = new { type = "string", description = "Nombre de la ley. Ej: 'Estatuto de los Trabajadores', 'LGSS', 'Ley de Prevención de Riesgos Laborales'" },
            },
            required = new[] { "article_number", "law_name" }
        }));

    public static FunctionToolDefinition GetRelatedChunks { get; } = new(
        name: "get_related_chunks",
        description: """
            Obtiene los chunks referenciados por un chunk dado (artículos citados, disposiciones relacionadas).
            Útil para seguir las referencias cruzadas de un artículo ya encontrado.
            Proporciona el id del chunk obtenido con search_normativa o get_article.
            """,
        parameters: BinaryData.FromObjectAsJson(new
        {
            type = "object",
            properties = new
            {
                chunk_id = new { type = "string", description = "ID del chunk (UUID o entero) del que obtener referencias" },
            },
            required = new[] { "chunk_id" }
        }));
}
