using Azure;
using Azure.AI.Agents.Persistent;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Identity;
using System.Net.Http.Headers;
using System.Net.Http.Json;
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
/// Pipeline policy that logs outgoing HTTP requests for debugging SDK calls.
/// </summary>
internal sealed class LoggingPolicy(ILogger logger) : HttpPipelinePolicy
{
    public override void Process(HttpMessage message, ReadOnlyMemory<HttpPipelinePolicy> pipeline)
    {
        LogRequest(message);
        ProcessNext(message, pipeline);
        LogResponse(message);
    }

    public override async ValueTask ProcessAsync(HttpMessage message, ReadOnlyMemory<HttpPipelinePolicy> pipeline)
    {
        LogRequest(message);
        await ProcessNextAsync(message, pipeline);
        LogResponse(message);
    }

    private void LogRequest(HttpMessage message)
    {
        var req = message.Request;
        logger.LogWarning("[SDK-HTTP] {Method} {Uri}", req.Method, req.Uri);
        if (req.Content != null)
        {
            using var ms = new System.IO.MemoryStream();
            req.Content.WriteTo(ms, default);
            var body = System.Text.Encoding.UTF8.GetString(ms.ToArray());
            // Truncate to 500 chars for logging
            logger.LogWarning("[SDK-HTTP] Body: {Body}", body.Length > 500 ? body[..500] + "..." : body);
        }
    }

    private void LogResponse(HttpMessage message)
    {
        var resp = message.Response;
        logger.LogWarning("[SDK-HTTP] Response: {Status} {Reason}", resp.Status, resp.ReasonPhrase);
        if (resp.Status >= 400)
        {
            using var reader = new System.IO.StreamReader(resp.ContentStream ?? System.IO.Stream.Null, leaveOpen: true);
            var body = reader.ReadToEnd();
            logger.LogWarning("[SDK-HTTP] Error body: {Body}", body.Length > 1000 ? body[..1000] : body);
            // Reset stream position for SDK to read
            if (resp.ContentStream?.CanSeek == true)
                resp.ContentStream.Position = 0;
        }
    }
}

/// <summary>
/// Manages the persistent agent lifecycle: create once at startup, reuse across requests.
/// Uses PersistentAgentsClient directly with Azure AI Foundry project endpoint.
/// </summary>
public class AgentManager : IAsyncDisposable
{
    private readonly PersistentAgentsClient _agentsClient;
    private string? _agentId;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private readonly ILogger<AgentManager> _logger;
    private readonly AiFoundryCredential _credential;

    public PersistentAgentsClient AgentsClient => _agentsClient;

    public AgentManager(ILogger<AgentManager> logger)
    {
        _logger = logger;
        _credential = new AiFoundryCredential();

        // Use PersistentAgentsClient directly with AiFoundryCredential that
        // forces the correct token audience (ai.azure.com instead of cognitiveservices.azure.com).
        var options = new PersistentAgentsAdministrationClientOptions();
        options.AddPolicy(new LoggingPolicy(logger), HttpPipelinePosition.BeforeTransport);

        _agentsClient = new PersistentAgentsClient(
            AppConfig.AiProjectEndpoint,
            _credential,
            options);
    }

    public async Task<string> GetAgentIdAsync()
    {
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
        var token = await _credential.GetTokenAsync(new TokenRequestContext(["https://ai.azure.com/.default"]), CancellationToken.None);
        var endpoint = AppConfig.AiProjectEndpoint.TrimEnd('/');
        var url = $"{endpoint}/assistants?api-version=v1";

        using var http = new HttpClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(new
            {
                model = AppConfig.Gpt52Deployment,
                name = "ss-expert",
                instructions = BuildAgentInstructions(),
                tools = BuildRawTools(),
                tool_resources = new { }
            })
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);

        var response = await http.SendAsync(request);
        var responseBody = await response.Content.ReadAsStringAsync();

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Agent creation failed: {(int)response.StatusCode} {response.ReasonPhrase}. Body: {responseBody}");
        }

        using var doc = System.Text.Json.JsonDocument.Parse(responseBody);
        if (!doc.RootElement.TryGetProperty("id", out var idElement) || string.IsNullOrWhiteSpace(idElement.GetString()))
        {
            throw new InvalidOperationException($"Agent creation succeeded but no id was returned. Body: {responseBody}");
        }

        return idElement.GetString()!;
    }

    private static object[] BuildRawTools() =>
    [
        new
        {
            type = "function",
            function = new
            {
                name = "search_normativa",
                description = "Search the Spanish labor and Social Security legislation database (BOE, ET, LGSS, LPRL, etc.) using hybrid semantic + keyword search.",
                parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        query = new { type = "string", description = "Search keywords (3-6 technical-legal terms in Spanish)" },
                        top_k = new { type = "integer", description = "Number of results to return (default 8, max 15)", @default = 8 }
                    },
                    required = new[] { "query" }
                }
            }
        },
        new
        {
            type = "function",
            function = new
            {
                name = "search_sentencias",
                description = "Search the Supreme Court case law collection on Social Security and labor law.",
                parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        query = new { type = "string", description = "Case law search keywords (in Spanish)" },
                        top_k = new { type = "integer", description = "Number of results (default 5, max 10)", @default = 5 }
                    },
                    required = new[] { "query" }
                }
            }
        },
        new
        {
            type = "function",
            function = new
            {
                name = "get_article",
                description = "Fetch a specific article from the regulations by its number and law name.",
                parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        article_number = new { type = "string", description = "Article number. E.g.: '48', '205.1'" },
                        law_name = new { type = "string", description = "Law name. E.g.: 'Estatuto de los Trabajadores', 'LGSS'" }
                    },
                    required = new[] { "article_number", "law_name" }
                }
            }
        },
        new
        {
            type = "function",
            function = new
            {
                name = "get_related_chunks",
                description = "Fetch the chunks referenced by a given chunk.",
                parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        chunk_id = new { type = "string", description = "Chunk ID (UUID or integer) to get references from" }
                    },
                    required = new[] { "chunk_id" }
                }
            }
        }
    ];

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
