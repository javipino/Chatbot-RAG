using ChatbotRag.Api;
using ChatbotRag.Api.Agent;
using ChatbotRag.Api.Endpoints;
using ChatbotRag.Api.Pipeline;
using ChatbotRag.Api.Services;

// App Service Linux sets PORT env var; default to 8080 for container compatibility
var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// ── Logging ──
builder.Logging.AddConsole();

// ── HttpClients ──
builder.Services.AddHttpClient("qdrant", c =>
{
    c.BaseAddress = new Uri(AppConfig.QdrantUrl.TrimEnd('/') + '/');
    c.DefaultRequestHeaders.Add("api-key", AppConfig.QdrantApiKey);
    c.Timeout = TimeSpan.FromSeconds(30);
});

builder.Services.AddHttpClient("forward", c =>
{
    c.Timeout = TimeSpan.FromSeconds(120);
});

// ── Core services ──
builder.Services.AddSingleton<TfidfService>();
builder.Services.AddSingleton<OpenAiService>();
builder.Services.AddScoped<QdrantService>();

// ── Pipeline stages ──
builder.Services.AddScoped<ExpandStage>();
builder.Services.AddScoped<SearchStage>();
builder.Services.AddScoped<EnrichStage>();
builder.Services.AddScoped<AnswerStage>();

// ── Agent (only when Foundry endpoint is configured) ──
var hasFoundry = !string.IsNullOrEmpty(AppConfig.AiProjectEndpoint);
if (hasFoundry)
{
    builder.Services.AddSingleton<AgentManager>();
    builder.Services.AddScoped<ToolExecutor>();
}

// ── Keep-alive self-ping (prevents F1 cold starts, 8:00–00:00 CET) ──
builder.Services.AddHostedService<ChatbotRag.Api.Services.KeepAliveService>();

var app = builder.Build();

// ── Static files + SPA fallback ──
// In publish output, public/ is copied to wwwroot/. In dev, point to workspace public/.
var publicPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "wwwroot"));
if (!Directory.Exists(publicPath))
    publicPath = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "public"));

if (Directory.Exists(publicPath))
{
    var fileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(publicPath);
    app.UseDefaultFiles(new DefaultFilesOptions
    {
        FileProvider = fileProvider,
        RequestPath = "",
    });
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = fileProvider,
        RequestPath = "",
    });
}
else
{
    app.Logger.LogWarning("Static files directory not found: {Path}", publicPath);
}

// ── API endpoints ──
app.MapGet("/health", () => Results.Ok(new { status = "ok", ts = DateTime.UtcNow }));
app.MapChat();
app.MapRagPipeline();
if (hasFoundry) app.MapRagAgent();

// ── SPA fallback (serve index.html for any non-API route) ──
app.MapFallback(async ctx =>
{
    var indexPath = Path.Combine(publicPath, "index.html");
    if (File.Exists(indexPath))
    {
        ctx.Response.ContentType = "text/html";
        await ctx.Response.SendFileAsync(indexPath);
    }
    else
    {
        ctx.Response.StatusCode = 404;
    }
});

app.Run();
