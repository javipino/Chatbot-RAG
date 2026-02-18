namespace ChatbotRag.Api;

public static class AppConfig
{
    // ── Azure OpenAI ──
    public static string PrincipalEndpoint =>
        NormalizeHostname(Env("AZURE_OPENAI_ENDPOINT"), "javie-mku5l3k8-swedencentral.cognitiveservices.azure.com");

    public static string PrincipalKey => Env("AZURE_OPENAI_KEY") ?? "";

    public static string ReaderEndpoint =>
        NormalizeHostname(Env("AZURE_OPENAI_READER_ENDPOINT"), "openai-reader-javi.cognitiveservices.azure.com");

    public static string ReaderKey => Env("AZURE_OPENAI_READER_KEY") ?? "";

    public static string FoundryEndpoint =>
        NormalizeHostname(Env("AZURE_FOUNDRY_ENDPOINT"), "openai-reader-javi.services.ai.azure.com");

    public static string FoundryKey => Env("AZURE_FOUNDRY_KEY") ?? ReaderKey;

    // ── Azure AI Foundry Project ──
    public static string AiProjectEndpoint =>
        Env("AZURE_AI_PROJECT_ENDPOINT")
        ?? "https://javie-mku5l3k8-swedencentral.services.ai.azure.com/api/projects/javie-mku5l3k8-swedencentral_project";

    // ── Qdrant ──
    public static string QdrantUrl => Env("QDRANT_URL") ?? "";
    public static string QdrantApiKey => Env("QDRANT_API_KEY") ?? "";

    // ── Auth ──
    public static string? RagApiKey => Env("RAG_API_KEY");

    // ── Deployments ──
    public static string EmbeddingDeployment => "text-embedding-3-small";
    public static string NanoDeployment => "gpt-5-nano";
    public static string Gpt52Deployment => "gpt-5.2";
    public static string Gpt52CodexDeployment => "gpt-5.2-codex";

    // ── Collection weights for cross-collection search ──
    public static readonly (string Name, double Weight)[] Collections =
    [
        ("normativa", 1.0),
        ("sentencias", 0.8),
        ("criterios_inss", 0.9),
    ];

    public static readonly string SystemPrompt =
        """
        Eres un experto en legislación laboral y de Seguridad Social española.
        Te proporcionamos fragmentos de normativa como contexto. Úsalos como base principal, pero puedes razonar, conectar ideas entre fragmentos, y aplicar lógica jurídica para dar respuestas completas y útiles.

        Cita la ley y artículo cuando lo uses. Si algo no está cubierto por los fragmentos, amplia información en NEED.
        Responde en español, de forma clara y estructurada. Tono profesional pero cercano.

        Si hay contradicción entre fuentes, prevalece la de mayor rango (Ley > Reglamento > Orden).
        Las normas de rango inferior solo pueden mejorar los derechos del trabajador, nunca empeorarlos.
        En caso de duda, aplica la interpretación más favorable al trabajador.
        Comprueba que toda la respuesta es coherente entre sí y con los fragmentos antes de concluir. Si falta información crítica, usa NEED en la sección META.
        """;

    private static string? Env(string key) => Environment.GetEnvironmentVariable(key);

    private static string NormalizeHostname(string? value, string fallback)
    {
        var raw = (value ?? fallback).Trim();
        if (string.IsNullOrEmpty(raw)) return fallback;
        try
        {
            if (raw.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                raw.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                return new Uri(raw).Host;
        }
        catch { }
        // Strip protocol prefix manually
        raw = System.Text.RegularExpressions.Regex.Replace(raw, @"^https?://", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var slashIdx = raw.IndexOf('/');
        return slashIdx >= 0 ? raw[..slashIdx] : raw;
    }
}
