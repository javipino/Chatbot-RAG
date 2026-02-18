using Azure;
using Azure.AI.Agents.Persistent;
using Azure.Core;
using Azure.Identity;
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
    private PersistentAgent? _agent;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private readonly ILogger<AgentManager> _logger;

    public PersistentAgentsClient AgentsClient => _agentsClient;

    public AgentManager(ILogger<AgentManager> logger)
    {
        _logger = logger;

        // Use PersistentAgentsClient directly with AiFoundryCredential that
        // forces the correct token audience (ai.azure.com instead of cognitiveservices.azure.com).
        _agentsClient = new PersistentAgentsClient(
            AppConfig.AiProjectEndpoint,
            new AiFoundryCredential());
    }

    public async Task<string> GetAgentIdAsync()
    {
        if (_agent != null) return _agent.Id;

        await _initLock.WaitAsync();
        try
        {
            if (_agent != null) return _agent.Id;
            _agent = await CreateAgentAsync();
            _logger.LogInformation("Persistent agent created: {Id}", _agent.Id);
            return _agent.Id;
        }
        finally
        {
            _initLock.Release();
        }
    }

    private async Task<PersistentAgent> CreateAgentAsync()
    {
        var tools = ToolDefinitions.All;

        // Azure AI Foundry API requires tool_resources field even if empty
        var toolResources = new ToolResources();

        return await _agentsClient.Administration.CreateAgentAsync(
            model: AppConfig.Gpt52Deployment,
            name: "ss-expert",
            instructions: BuildAgentInstructions(),
            tools: tools,
            toolResources: toolResources);
    }

    private static string BuildAgentInstructions() =>
        $$"""
        {{AppConfig.SystemPrompt}}

        ## Tool Usage Instructions

        You have access to a database of Spanish labor and Social Security legislation.
        You MUST use tools to search for information BEFORE answering. Never answer without consulting the database.

        ### Search Strategy
        1. Use **search_normativa** to search by keywords. Each search should be concise (3-6 technical-legal terms in Spanish).
        2. If the question involves multiple concepts, make separate searches, one per concept.
        3. If you know the exact article you need, use **get_article** to fetch it directly.
        4. If a chunk has relevant references, use **get_related_chunks** to expand them.
        5. If results are insufficient, reformulate the search with synonyms or more specific terms.

        ### When to Re-search
        - If the fragments obtained don't fully answer the question, search more.
        - If the question mentions a specific article or law that didn't appear, use get_article.
        - Maximum 6 rounds of tool calls per question.

        ### Colloquial → Legal Term Equivalences
        - "baja de maternidad" → "suspensión contrato nacimiento cuidado menor"
        - "despido" → "extinción contrato"
        - "paro" → "prestación desempleo"
        - "baja médica" → "incapacidad temporal"
        - "pensión" → "jubilación prestación contributiva"
        - "finiquito" → "liquidación haberes extinción contrato"
        """;

    /// <summary>Create a new thread for a conversation.</summary>
    public async Task<PersistentAgentThread> CreateThreadAsync() =>
        await _agentsClient.Threads.CreateThreadAsync();

    public async ValueTask DisposeAsync()
    {
        if (_agent != null)
        {
            try
            {
                await _agentsClient.Administration.DeleteAgentAsync(_agent.Id);
                _logger.LogInformation("Persistent agent deleted: {Id}", _agent.Id);
            }
            catch (Exception ex)
            {
                _logger.LogWarning("Could not delete agent on shutdown: {Message}", ex.Message);
            }
        }
    }
}
