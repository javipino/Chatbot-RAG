namespace ChatbotRag.Api.Endpoints;

/// <summary>Shared API key auth helper for endpoints that use endpoint filters.</summary>
public static class AuthHelper
{
    /// <summary>
    /// Validates the x-api-key header. Returns true if authorized (or no key configured).
    /// Writes 401 and returns false if unauthorized.
    /// </summary>
    public static bool Validate(HttpContext ctx)
    {
        var configuredKey = AppConfig.RagApiKey;
        if (string.IsNullOrEmpty(configuredKey)) return true; // open access

        var provided = ctx.Request.Headers["x-api-key"].FirstOrDefault();
        if (provided == configuredKey) return true;

        ctx.Response.StatusCode = 401;
        ctx.Response.WriteAsJsonAsync(new { error = "Invalid or missing API key" });
        return false;
    }
}
