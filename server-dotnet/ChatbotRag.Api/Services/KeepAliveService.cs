namespace ChatbotRag.Api.Services;

/// <summary>
/// Background service that pings /health every 5 minutes to prevent Azure F1
/// from putting the app to sleep. Runs 24/7.
/// CPU cost: ~0.3s/day (negligible vs F1's 60 min/day quota).
/// </summary>
public class KeepAliveService(ILogger<KeepAliveService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait for the app to fully start before pinging
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

        var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
        using var http = new HttpClient { BaseAddress = new Uri($"http://localhost:{port}") };

        logger.LogInformation("[KeepAlive] Started — pinging /health every {Min} min",
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
