using Azure;
using Azure.AI.Agents.Persistent;
using Azure.Core;
using Azure.Identity;
using System.Net.Http.Headers;
using System.Text.Json;
using BinaryData = System.BinaryData;

namespace ChatbotRag.Api.Agent;

/// <summary>
/// Wraps DefaultAzureCredential to force the correct audience for Azure AI Foundry Agents API.
/// The SDK defaults to cognitiveservices.azure.com, but agents require ai.azure.com.
/// </summary>
internal sealed class AiFoundryCredential : TokenCredential
{
    private static readonly string[] Scopes = ["https://ai.azure.com/.default"];
    private readonly DefaultAzureCredential _inner = new();

    public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
        => _inner.GetToken(new TokenRequestContext(Scopes), cancellationToken);

    public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
        => _inner.GetTokenAsync(new TokenRequestContext(Scopes), cancellationToken);
}

/// <summary>
/// Manages the persistent agent lifecycle: create once at startup, reuse across requests.
/// Uses PersistentAgentsClient directly with Azure AI Foundry project endpoint.
/// </summary>
public class AgentManager : IAsyncDisposable
{
    private readonly PersistentAgentsClient _agentsClient;
    private string? _agentId;
    private readonly string? _configuredAgentId;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private readonly ILogger<AgentManager> _logger;
    private readonly AiFoundryCredential _credential;

    public PersistentAgentsClient AgentsClient => _agentsClient;

    public AgentManager(ILogger<AgentManager> logger)
    {
        _logger = logger;
        _credential = new AiFoundryCredential();
        _configuredAgentId = Environment.GetEnvironmentVariable("AZURE_AI_AGENT_ID");

        if (!string.IsNullOrWhiteSpace(_configuredAgentId))
            _logger.LogInformation("Using fixed Azure AI agent id from AZURE_AI_AGENT_ID: {Id}", _configuredAgentId);

        // Use PersistentAgentsClient directly with AiFoundryCredential that
        // forces the correct token audience (ai.azure.com instead of cognitiveservices.azure.com).
        _agentsClient = new PersistentAgentsClient(
            AppConfig.AiProjectEndpoint,
            _credential);
    }

    public async Task<string> GetAgentIdAsync()
    {
        if (!string.IsNullOrWhiteSpace(_configuredAgentId))
            return _configuredAgentId;

        if (!string.IsNullOrEmpty(_agentId)) return _agentId;

        await _initLock.WaitAsync();
        try
        {
            if (!string.IsNullOrEmpty(_agentId)) return _agentId;
            _agentId = await CreateAgentIdAsync();
            _logger.LogInformation("Persistent agent created: {Id}", _agentId);
            return _agentId;
        }
        finally
        {
            _initLock.Release();
        }
    }

    private async Task<string> CreateAgentIdAsync()
    {
        var token = await _credential.GetTokenAsync(
            new TokenRequestContext(["https://ai.azure.com/.default"]), CancellationToken.None);
        var endpoint = AppConfig.AiProjectEndpoint.TrimEnd('/');
        var url = $"{endpoint}/assistants?api-version=v1";

        // Build the tools array matching the OpenAI Assistants API format
        var tools = ToolDefinitions.All.Select(t =>
        {
            var ft = (FunctionToolDefinition)t;
            return new Dictionary<string, object>
            {
                ["type"] = "function",
                ["function"] = new Dictionary<string, object>
                {
                    ["name"] = ft.Name,
                    ["description"] = ft.Description,
                    ["parameters"] = JsonSerializer.Deserialize<JsonElement>(ft.Parameters.ToString())
                }
            };
        }).ToArray();

        var body = new Dictionary<string, object>
        {
            ["model"] = AppConfig.Gpt52Deployment,
            ["name"] = "ss-expert",
            ["instructions"] = BuildAgentInstructions(),
            ["tools"] = tools,
            ["tool_resources"] = new Dictionary<string, object>()
        };

        var jsonBody = JsonSerializer.Serialize(body, new JsonSerializerOptions { WriteIndented = false });
        _logger.LogInformation("Creating agent at {Url}, body length={Len}, tools={ToolCount}",
            url, jsonBody.Length, tools.Length);

        using var http = new HttpClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(jsonBody, System.Text.Encoding.UTF8, "application/json")
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);

        var response = await http.SendAsync(request);
        var responseBody = await response.Content.ReadAsStringAsync();

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogError("Agent creation failed: {Status} {Reason}. Body: {Body}",
                (int)response.StatusCode, response.ReasonPhrase, responseBody);
            throw new InvalidOperationException(
                $"Agent creation failed: {(int)response.StatusCode} {response.ReasonPhrase}. Body: {responseBody}");
        }

        using var doc = JsonDocument.Parse(responseBody);
        if (!doc.RootElement.TryGetProperty("id", out var idElement) ||
            string.IsNullOrWhiteSpace(idElement.GetString()))
            throw new InvalidOperationException(
                $"Agent creation succeeded but no id was returned. Body: {responseBody}");

        var agentId = idElement.GetString()!;

        // Log tool count from response
        var respToolCount = doc.RootElement.TryGetProperty("tools", out var toolsEl)
            ? toolsEl.GetArrayLength() : -1;
        _logger.LogInformation("Agent created: {Id}, response tools={ToolCount}", agentId, respToolCount);

        return agentId;
    }

    private static string BuildAgentInstructions() =>
        $$"""
        {{AppConfig.SystemPrompt}}

        ## Tool Usage Instructions

        You have access to a database of Spanish labor and Social Security legislation.
        You MUST use tools to search for information BEFORE answering. Never answer without consulting the database.

        ### Search Strategy (priority order)
        1. **search_normativa** — Primary source. Search legislation by keywords (3-6 technical-legal terms in Spanish).
        2. **search_criterios** — Very important. Search INSS management criteria: official interpretations on how to apply regulations in practice (search with 3-6 technical-legal terms in Spanish). You can use the law and article to searh here too.
        3. **get_article** — When you know the exact article number and law name.
        4. **get_related_chunks** — To expand cross-references from a chunk you've already found.
        5. If the question involves multiple concepts, make separate searches, one per concept.
        6. If results are insufficient, reformulate with synonyms or more specific terms.

        ### ⚠️ search_sentencias — USE ONLY EXCEPTIONALLY
        **Do NOT use search_sentencias by default.** The key content from Supreme Court rulings is already
        summarized and incorporated into the INSS criteria (search_criterios). Only use search_sentencias when:
        - A criterio explicitly references a specific court ruling (STS) and you need the full judicial reasoning.
        - The user explicitly asks about a particular sentencia or court case.
        - Normativa + criterios are insufficient and you suspect there is relevant case law not yet covered by criteria.

        ### When to Re-search
        - If the fragments obtained don't fully answer the question, search more (normativa or criterios first).
        - If the question mentions a specific article or law that didn't appear, use get_article.

        ### Colloquial → Legal Term Equivalences
        - "baja de maternidad" → "suspensión contrato nacimiento cuidado menor"
        - "despido" → "extinción contrato"
        - "paro" → "prestación desempleo"
        - "baja médica" → "incapacidad temporal"
        - "pensión" → "jubilación prestación contributiva"
        - "finiquito" → "liquidación haberes extinción contrato"
        """;

    /// <summary>Invalidate the cached agent ID so the next GetAgentIdAsync() call recreates it.</summary>
    public void InvalidateAgent()
    {
        _agentId = null;
        _logger.LogWarning("Agent ID invalidated — will recreate on next request");
    }

    /// <summary>Create a new thread for a conversation.</summary>
    public async Task<PersistentAgentThread> CreateThreadAsync() =>
        await _agentsClient.Threads.CreateThreadAsync();

    public async ValueTask DisposeAsync()
    {
        if (!string.IsNullOrWhiteSpace(_configuredAgentId))
            return;

        if (!string.IsNullOrEmpty(_agentId))
        {
            try
            {
                await _agentsClient.Administration.DeleteAgentAsync(_agentId);
                _logger.LogInformation("Persistent agent deleted: {Id}", _agentId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Could not delete agent on shutdown: {Message}", ex.Message);
            }
        }
    }
}
