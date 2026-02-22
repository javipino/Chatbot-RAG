namespace ChatbotRag.Api.Services;

/// <summary>
/// Background service that pings /health every 5 minutes to prevent Azure F1
/// from putting the app to sleep. Active only 08:00–00:00 CET (Europe/Madrid).
/// CPU cost: ~0.2s/day (negligible vs F1's 60 min/day quota).
/// </summary>
public class KeepAliveService(ILogger<KeepAliveService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);
    private static readonly TimeZoneInfo SpainTz = GetSpainTimeZone();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait for the app to fully start before pinging
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

        var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
        using var http = new HttpClient { BaseAddress = new Uri($"http://localhost:{port}") };

        logger.LogInformation("[KeepAlive] Started — pinging /health every {Min} min (08:00–00:00 CET)",
            Interval.TotalMinutes);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var spainNow = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, SpainTz);
                var hour = spainNow.Hour;

                if (hour >= 8) // 08:00–23:59 (00:00 = next day, so hour 0-7 is off)
                {
                    var resp = await http.GetAsync("/health", stoppingToken);
                    logger.LogDebug("[KeepAlive] Ping {Status} at {Time:HH:mm} CET",
                        (int)resp.StatusCode, spainNow);
                }
                else
                {
                    logger.LogDebug("[KeepAlive] Sleeping hours ({Hour}:xx CET) — skipped", hour);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("[KeepAlive] Ping failed: {Msg}", ex.Message);
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }

    private static TimeZoneInfo GetSpainTimeZone()
    {
        // Linux uses IANA IDs, Windows uses Windows IDs
        try { return TimeZoneInfo.FindSystemTimeZoneById("Europe/Madrid"); }
        catch { return TimeZoneInfo.FindSystemTimeZoneById("Romance Standard Time"); }
    }
}
