# Chatbot-RAG

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española.

## Descripción

Chatbot multi-modelo con backend .NET y dos modos RAG (pipeline y agente) especializados en legislación laboral española. Los documentos se indexan en Qdrant Cloud con embeddings + sparse vectors (TF-IDF), permitiendo búsqueda híbrida con fusión RRF + respuestas generadas por GPT-5.2.

**Fuentes de datos (3 colecciones en Qdrant Cloud):**
1. **Normativa** — BOE "Código Laboral y de la Seguridad Social" (5,301 chunks enriquecidos)
2. **Sentencias** — Jurisprudencia Tribunal Supremo (2,214 chunks)
3. **Criterios INSS** — Criterios interpretativos (828 chunks)

**URL:** https://func-consultas-internas.azurewebsites.net

## Arquitectura

```
Usuario → App Service (.NET 10 Minimal API)
           ├── /api/chat         → Azure OpenAI (proxy directo)
           ├── /api/rag-pipeline → Pipeline RAG (SSE streaming):
           │     1. Query expansion (GPT-5 Nano)
           │     2. Embedding (text-embedding-3-small)
           │     3. Sparse vector (TF-IDF local, per-collection)
           │     4. Hybrid search (Qdrant ×2 colecciones, RRF)
           │     5b. Reference expansion (pre-computed refs)
           │     5. Unified answer + eval (GPT-5.2)
           └── /api/rag-agent    → Agente AI Foundry (SSE streaming):
                 GPT-5.2 con 5 herramientas RAG iterativas
```

## Estructura del proyecto

```
├── public/                      # Frontend (vanilla JS, ES modules)
│   ├── index.html
│   ├── css/styles.css
│   └── js/                      # config, storage, api, ui, chat, app
├── server-dotnet/               # Backend .NET 10 (producción)
│   └── ChatbotRag.Api/
│       ├── Program.cs           # Entry point, DI, static files
│       ├── AppConfig.cs         # Env vars, constantes, SystemPrompt
│       ├── Agent/               # AgentManager, ToolDefinitions, ToolExecutor
│       ├── Data/                # 3 vocabularios TF-IDF (normativa, sentencias, criterios)
│       ├── Endpoints/           # Chat, RagPipeline, RagAgent, SSE
│       ├── Models/              # DTOs, ChunkResult, QdrantModels
│       ├── Pipeline/            # Expand, Search, Enrich, Answer stages
│       └── Services/            # OpenAI, Qdrant, TfIdf
├── src/scripts/                 # Offline data processing (Python + Node.js)
├── data/                        # Local data (gitignored)
├── docs/                        # Documentation
└── .github/workflows/           # CI/CD (deploy-dotnet.yml)
```

## Stack

- **Backend:** ASP.NET Core 10 Minimal API
- **Frontend:** Vanilla JS with ES modules (no framework, no bundler)
- **Hosting:** Azure App Service F1 (free tier, Linux) — `func-consultas-internas`
- **Vector DB:** Qdrant Cloud (free tier, 1GB RAM, 3 colecciones)
- **LLMs:** Azure OpenAI — GPT-5.2, GPT-5 Nano, text-embedding-3-small
- **Agent:** Azure AI Foundry (GPT-5.2 con 5 function tools)
- **CI/CD:** GitHub Actions → `dotnet publish` + zip deploy vía Kudu

## Presets disponibles

| Preset | Modelo | Endpoint | Descripción |
|--------|--------|----------|-------------|
| GPT-5.2 | `gpt-5.2` | `/api/chat` | Modelo general |
| GPT-5.2 Codex | `gpt-5.2-codex` | `/api/chat` | Modelo de código |
| SS Expert (RAG) | `gpt-5.2` + Qdrant | `/api/rag-pipeline` | Pipeline RAG (normativa + criterios) |
| SS Expert (Agente) | `gpt-5.2` + Foundry | `/api/rag-agent` | Agente con 5 herramientas RAG |

## Despliegue

Auto-deploy vía GitHub Actions en cada push a `master` (cambios en `server-dotnet/`, `public/` o workflow):

```bash
git push origin master
```

## Configuración

1. Copia `.env.example` → `.env` y completa las API keys
2. Configura App Service App Settings con las variables de entorno
3. Build local: `dotnet build server-dotnet/ChatbotRag.Api/ChatbotRag.Api.csproj`
4. Arranca local: establece las env vars del `.env` y ejecuta `dotnet run --project server-dotnet/ChatbotRag.Api`

## Licencia

Proyecto privado.
