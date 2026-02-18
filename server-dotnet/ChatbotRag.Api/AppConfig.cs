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
        You are an expert in Spanish labor law and Social Security legislation.
        You are provided with regulation fragments as context. Use them as your primary source, but you may reason across fragments, connect ideas, and apply legal logic to give thorough and useful answers.

        Cite the specific law and article when you use one. If something is not covered by the fragments, request it via NEED.
        Always respond in Spanish, clearly and with structure. Professional but approachable tone.

        If sources conflict, higher-ranking law prevails (Ley > Reglamento > Orden).
        Lower-ranking rules may only improve worker rights, never reduce them.
        When in doubt, apply the interpretation most favorable to the worker.
        Verify the entire answer is internally consistent and aligned with the fragments before concluding. If critical information is missing, use NEED in the META section.
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
