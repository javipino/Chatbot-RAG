namespace ChatbotRag.Api.Services;

/// <summary>
/// Optional background service that pings /health every 5 minutes.
/// This is useful for diagnostics, but by itself it does NOT guarantee Azure F1
/// keep-alive because the process must already be running.
/// Use an external scheduler (for example GitHub Actions cron) for reliable keep-alive.
/// </summary>
public class KeepAliveService(ILogger<KeepAliveService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait for the app to fully start before pinging
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

        var targetUrl = Environment.GetEnvironmentVariable("KEEPALIVE_TARGET_URL");
        var baseUrl = !string.IsNullOrWhiteSpace(targetUrl)
            ? targetUrl.TrimEnd('/')
            : $"http://localhost:{Environment.GetEnvironmentVariable("PORT") ?? "8080"}";

        using var http = new HttpClient { BaseAddress = new Uri(baseUrl) };

        logger.LogInformation(
            "[KeepAlive] Started — pinging {Target}/health every {Min} min",
            baseUrl,
            Interval.TotalMinutes);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var resp = await http.GetAsync("/health", stoppingToken);
                logger.LogDebug("[KeepAlive] Ping {Status}", (int)resp.StatusCode);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("[KeepAlive] Ping failed: {Msg}", ex.Message);
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }
}
