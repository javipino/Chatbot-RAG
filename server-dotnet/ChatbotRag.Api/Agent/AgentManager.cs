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
    private string? _configuredAgentId;
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

        ### Workflow
        1. **browse(query)** — Searches BOTH normativa and INSS criteria simultaneously (query: 3-6 technical-legal terms in Spanish). Returns lightweight summaries (no full text). Review them.
        2. **fetch_details(normativa_ids, criterios_ids)** — Fetches full text for the IDs you selected. Answer based on the full text.

        Repeat browse/fetch as needed: different queries for different concepts, broader or narrower terms, etc. Use **get_related_chunks** to follow cross-references from a chunk you already have.
        Search as many times as needed to give the best possible answer.
        
        **search_sentencias** searches Supreme Court case law. Most relevant rulings are already included in INSS criteria, so use it only when you need a specific precedent not covered by the criteria results.

        ### Tips
        - Search terms: 3-6 concise technical-legal keywords in Spanish
        - Translate colloquial terms: "baja de maternidad" → "suspensión contrato nacimiento cuidado menor", "despido" → "extinción contrato", "paro" → "prestación desempleo", "baja médica" → "incapacidad temporal"
        """;

    /// <summary>Invalidate the cached agent ID so the next GetAgentIdAsync() call recreates it.</summary>
    public void InvalidateAgent()
    {
        _logger.LogWarning("Agent ID invalidated (was configured={Configured}, cached={Cached}) — will recreate on next request",
            _configuredAgentId, _agentId);
        _configuredAgentId = null;
        _agentId = null;
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
