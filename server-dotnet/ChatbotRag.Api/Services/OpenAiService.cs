using Azure;
using Azure.AI.OpenAI;
using OpenAI.Chat;
using OpenAI.Embeddings;
using System.ClientModel;

namespace ChatbotRag.Api.Services;

/// <summary>
/// Wrapper around Azure.AI.OpenAI SDK for embeddings and chat completions.
/// Exposes typed clients for Reader endpoint (nano + embeddings) and Principal endpoint (gpt-5.2).
/// </summary>
public class OpenAiService
{
    private readonly EmbeddingClient _embeddingClient;
    private readonly ChatClient _nanoClient;
    private readonly ChatClient _gpt52Client;

    public OpenAiService()
    {
        // Reader endpoint: embeddings + gpt-5-nano
        var readerClient = new AzureOpenAIClient(
            new Uri($"https://{AppConfig.ReaderEndpoint}/"),
            new AzureKeyCredential(AppConfig.ReaderKey));

        _embeddingClient = readerClient.GetEmbeddingClient(AppConfig.EmbeddingDeployment);
        _nanoClient = readerClient.GetChatClient(AppConfig.NanoDeployment);

        // Principal endpoint: gpt-5.2
        var principalClient = new AzureOpenAIClient(
            new Uri($"https://{AppConfig.PrincipalEndpoint}/"),
            new AzureKeyCredential(AppConfig.PrincipalKey));

        _gpt52Client = principalClient.GetChatClient(AppConfig.Gpt52Deployment);
    }

    /// <summary>Embed text using text-embedding-3-small (1536 dims).</summary>
    public async Task<float[]> EmbedAsync(string text)
    {
        var result = await _embeddingClient.GenerateEmbeddingAsync(text);
        return result.Value.ToFloats().ToArray();
    }

    /// <summary>Call gpt-5-nano (Reader endpoint). No temperature support.</summary>
    public async Task<string> CallNanoAsync(IEnumerable<ChatMessage> messages)
    {
        var options = new ChatCompletionOptions { MaxOutputTokenCount = 4096 };
        var result = await _nanoClient.CompleteChatAsync(messages.ToList(), options);
        return result.Value.Content[0].Text ?? "";
    }

    /// <summary>Call gpt-5.2 (Principal endpoint) — single response.</summary>
    public async Task<string> CallGpt52Async(IEnumerable<ChatMessage> messages)
    {
        var result = await _gpt52Client.CompleteChatAsync(messages.ToList());
        return result.Value.Content[0].Text ?? "";
    }

    public async IAsyncEnumerable<string> CallGpt52StreamingAsync(IEnumerable<ChatMessage> messages)
    {
        await foreach (var update in _gpt52Client.CompleteChatStreamingAsync(messages.ToList()))
        {
            foreach (var part in update.ContentUpdate)
                if (!string.IsNullOrEmpty(part.Text))
                    yield return part.Text;
        }
    }

    /// <summary>Call gpt-5.2 with function tools.</summary>
    public async Task<ChatCompletion> CallGpt52WithToolsAsync(
        IEnumerable<ChatMessage> messages, IEnumerable<ChatTool> tools,
        ChatToolChoice? toolChoice = null)
    {
        var opts = new ChatCompletionOptions();
        foreach (var t in tools) opts.Tools.Add(t);
        if (toolChoice != null) opts.ToolChoice = toolChoice;
        return (await _gpt52Client.CompleteChatAsync(messages.ToList(), opts)).Value;
    }
}
