using ChatbotRag.Api.Models;
using ChatbotRag.Api.Services;

namespace ChatbotRag.Api.Endpoints;

public static class AdminEndpoints
{
    public static void MapAdmin(this WebApplication app)
    {
        var group = app.MapGroup("/api/admin");

        // ── Criterios INSS ──

        group.MapGet("/criterios", async (HttpContext ctx, QdrantService qdrant, string? q) =>
        {
            if (!AuthHelper.Validate(ctx)) return;
            var results = await qdrant.ScrollPointsAsync("criterios_inss", q, limit: 50);
            await ctx.Response.WriteAsJsonAsync(results);
        });

        group.MapPost("/criterios", async (HttpContext ctx, AdminService admin) =>
        {
            if (!AuthHelper.Validate(ctx)) return;

            SseHelper.SetSseHeaders(ctx.Response);
            try
            {
                var form = await ctx.Request.ReadFormAsync();
                var file = form.Files.GetFile("pdf");
                if (file == null || file.Length == 0)
                {
                    await SseHelper.WriteErrorAsync(ctx.Response, "No se proporcionó archivo PDF.");
                    return;
                }

                var titulo = form["titulo"].ToString();
                if (string.IsNullOrWhiteSpace(titulo))
                {
                    await SseHelper.WriteErrorAsync(ctx.Response, "El título es obligatorio.");
                    return;
                }

                var descripcion = form["descripcion"].ToString();
                var fecha = form["fecha"].ToString();
                var emisor = form["emisor"].ToString();

                using var stream = file.OpenReadStream();
                var id = await admin.ProcessCriterioAsync(
                    stream, titulo, descripcion, fecha, emisor,
                    async msg => await SseHelper.WriteToolStatusAsync(ctx.Response, "pipeline", msg));

                await SseHelper.WriteDoneAsync(ctx.Response, new { id, message = $"Criterio creado con ID {id}" });
            }
            catch (Exception ex)
            {
                await SseHelper.WriteErrorAsync(ctx.Response, ex.Message);
            }
        }).DisableAntiforgery();

        group.MapDelete("/criterios/{id:long}", async (HttpContext ctx, QdrantService qdrant, long id) =>
        {
            if (!AuthHelper.Validate(ctx)) return;
            await qdrant.DeletePointAsync("criterios_inss", id);
            await ctx.Response.WriteAsJsonAsync(new { message = $"Criterio {id} eliminado." });
        });

        // ── Normativa ──

        group.MapGet("/normativa", async (HttpContext ctx, QdrantService qdrant, string? q, string? law) =>
        {
            if (!AuthHelper.Validate(ctx)) return;
            var results = await qdrant.ScrollPointsAsync("normativa", q, law, limit: 50);
            await ctx.Response.WriteAsJsonAsync(results);
        });

        group.MapGet("/normativa/{id:long}", async (HttpContext ctx, QdrantService qdrant, long id) =>
        {
            if (!AuthHelper.Validate(ctx)) return;
            var point = await qdrant.GetPointByIdAsync("normativa", id);
            if (point == null)
            {
                ctx.Response.StatusCode = 404;
                await ctx.Response.WriteAsJsonAsync(new { error = "Chunk no encontrado." });
                return;
            }
            await ctx.Response.WriteAsJsonAsync(point);
        });

        group.MapPost("/normativa", async (HttpContext ctx, AdminService admin) =>
        {
            if (!AuthHelper.Validate(ctx)) return;

            SseHelper.SetSseHeaders(ctx.Response);
            try
            {
                var input = await ctx.Request.ReadFromJsonAsync<NormativaChunkInput>();
                if (input == null || string.IsNullOrWhiteSpace(input.Text))
                {
                    await SseHelper.WriteErrorAsync(ctx.Response, "El texto del chunk es obligatorio.");
                    return;
                }

                var id = await admin.AddNormativaChunkAsync(input,
                    async msg => await SseHelper.WriteToolStatusAsync(ctx.Response, "pipeline", msg));

                await SseHelper.WriteDoneAsync(ctx.Response, new { id, message = $"Chunk normativa creado con ID {id}" });
            }
            catch (Exception ex)
            {
                await SseHelper.WriteErrorAsync(ctx.Response, ex.Message);
            }
        });

        group.MapPut("/normativa/{id:long}", async (HttpContext ctx, AdminService admin, long id) =>
        {
            if (!AuthHelper.Validate(ctx)) return;

            SseHelper.SetSseHeaders(ctx.Response);
            try
            {
                var input = await ctx.Request.ReadFromJsonAsync<NormativaChunkInput>();
                if (input == null || string.IsNullOrWhiteSpace(input.Text))
                {
                    await SseHelper.WriteErrorAsync(ctx.Response, "El texto del chunk es obligatorio.");
                    return;
                }

                await admin.UpdateNormativaChunkAsync(id, input,
                    async msg => await SseHelper.WriteToolStatusAsync(ctx.Response, "pipeline", msg));

                await SseHelper.WriteDoneAsync(ctx.Response, new { id, message = $"Chunk {id} actualizado" });
            }
            catch (Exception ex)
            {
                await SseHelper.WriteErrorAsync(ctx.Response, ex.Message);
            }
        });

        group.MapDelete("/normativa/{id:long}", async (HttpContext ctx, QdrantService qdrant, long id) =>
        {
            if (!AuthHelper.Validate(ctx)) return;
            await qdrant.DeletePointAsync("normativa", id);
            await ctx.Response.WriteAsJsonAsync(new { message = $"Chunk {id} eliminado." });
        });
    }
}
