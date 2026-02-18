using Azure;
using Azure.AI.Agents.Persistent;
using Azure.Identity;
using BinaryData = System.BinaryData;

namespace ChatbotRag.Api.Agent;

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

        // Use PersistentAgentsClient directly (not via AIProjectClient) to avoid
        // endpoint transformation issues. Force V2025_05_01 API version since
        // the default "v1" may not be supported by all AI Foundry endpoints.
        var options = new PersistentAgentsAdministrationClientOptions(
            PersistentAgentsAdministrationClientOptions.ServiceVersion.V2025_05_01);

        _agentsClient = new PersistentAgentsClient(
            AppConfig.AiProjectEndpoint,
            new DefaultAzureCredential(),
            options);
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

        ## Instrucciones para el uso de tools

        Tienes acceso a una base de datos de normativa laboral y de Seguridad Social española.
        Debes usar las tools para buscar información ANTES de responder. No respondas sin consultar la base de datos.

        ### Estrategia de búsqueda
        1. Usa **search_normativa** para buscar por palabras clave. Cada búsqueda debe ser concisa (3-6 palabras técnico-legales).
        2. Si la pregunta involucra múltiples conceptos, haz varias búsquedas, una por concepto.
        3. Si conoces el artículo exacto que necesitas, usa **get_article** para obtenerlo directamente.
        4. Si un chunk tiene referencias relevantes, usa **get_related_chunks** para expandirlas.
        5. Si los resultados son insuficientes, reformula la búsqueda con sinónimos o términos más específicos.

        ### Cuándo re-buscar
        - Si los fragmentos obtenidos no responden completamente la pregunta, busca más.
        - Si la pregunta menciona un artículo o ley específica que no apareció, usa get_article.
        - Máximo 6 rondas de tool calls por pregunta.

        ### Equivalencias coloquiales → términos legales
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
