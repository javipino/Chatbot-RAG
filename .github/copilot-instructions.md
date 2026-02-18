# Copilot Instructions - Chatbot RAG

## Proyecto

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española. Chat multi-modelo con dos backends desplegados en Azure App Service (B1).

**Fuentes de datos (3 colecciones en Qdrant Cloud):**
1. **Normativa** — BOE "Código Laboral y de la Seguridad Social" (5,648 chunks enriquecidos)
2. **Sentencias** — Jurisprudencia Tribunal Supremo (pendiente)
3. **Criterios INSS** — Criterios interpretativos (pendiente)

**URL producción:** https://chatbot-rag-javi.azurewebsites.net

---

## ⚠️ RESTRICCIONES CRÍTICAS

### Azure
- **SOLO actuar sobre la suscripción:** `1acd8d40-20d5-43b4-b8a4-3aed0f6f38a6` (Visual Studio Professional Javi)
- Antes de cualquier operación en Azure, verificar que estás en la suscripción correcta con `az account show`
- NO crear recursos en otras suscripciones bajo ningún concepto

### Presupuesto
- **Crédito Azure:** 50€ máximo. No crear recursos de pago sin consultar.
- App Service **B1** (~€13/mes): sin límite de CPU. Se migró de F1 porque el backend .NET consume más CPU en arranque frío.
- Azure AI Search fue eliminado por coste. Usar Qdrant Cloud (free tier).

### Secretos
- Las API keys están en `.env` (nunca commitear) y en App Service App Settings
- Usar siempre variables de entorno en el código (`process.env.*` / `os.environ[]` / `Environment.GetEnvironmentVariable()`)

---

## Recursos Azure

| Recurso | Nombre | Resource Group | Región |
|---------|--------|----------------|--------|
| Azure OpenAI (principal) | `javie-mku5l3k8-swedencentral` | ebook-reader | Sweden Central |
| Azure OpenAI (reader) | `OpenAI-reader-Javi` | ebook-reader | Sweden Central |
| Azure AI Foundry project | `javie-mku5l3k8-swedencentral_project` | ebook-reader | Sweden Central |
| App Service (B1) | `chatbot-rag-javi` | rg-chatbot-rag | West Europe |
| App Service Plan (B1) | `plan-chatbot-rag` | rg-chatbot-rag | West Europe |

### Recursos eliminados
- ~~Azure AI Search (`ai-search-javi`)~~ — Eliminado, migrado a Qdrant Cloud
- ~~Static Web App (`chatbot-rag-javi`)~~ — Eliminado, migrado a App Service
- ~~SpeechAI-Javi~~ — Eliminado (no usado)

### Deployments OpenAI
- **Principal:** `gpt-5.2`, `gpt-5.2-codex`
- **Reader:** `text-embedding-3-small` (1536 dims), `gpt-5-nano`

### Azure AI Foundry
- **Proyecto:** `javie-mku5l3k8-swedencentral_project`
- **Endpoint:** `https://javie-mku5l3k8-swedencentral.services.ai.azure.com/api/projects/javie-mku5l3k8-swedencentral_project`
- **Usado por:** `AgentManager.cs` para crear agentes persistentes con herramientas RAG
- **Auth:** `DefaultAzureCredential` (requiere Managed Identity con rol **Azure AI Developer** en producción)

### Qdrant Cloud (base de datos vectorial)
- **Tier:** Free (1GB RAM, sin pausa, "free forever")
- **Región:** EU
- **Colecciones:** `normativa`, `sentencias`, `criterios_inss`
- **Dense vectors:** 1536 dims, cosine
- **Sparse vectors:** TF-IDF con IDF modifier (para búsqueda híbrida)
- **Fusion:** RRF (Reciprocal Rank Fusion)

### Variables de entorno (App Service App Settings)
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_READER_ENDPOINT`, `AZURE_OPENAI_READER_KEY`
- `AZURE_AI_PROJECT_ENDPOINT`
- `QDRANT_URL`, `QDRANT_API_KEY`
- `RAG_API_KEY`
- `SCM_DO_BUILD_DURING_DEPLOYMENT=false`
- `WEBSITE_RUN_FROM_PACKAGE=0`

---

## Arquitectura

### Stack activo (producción)
- **Backend .NET:** ASP.NET Core 10 Minimal API — `server-dotnet/ChatbotRag.Api/`
- **Frontend:** Vanilla JS con ES modules — `public/` (servido como static files por el backend .NET desde `wwwroot/`)
- **Hosting:** Azure App Service B1, Linux, runtime `DOTNETCORE|10.0`
- **Startup command:** `dotnet ChatbotRag.Api.dll`
- **Vector DB:** Qdrant Cloud (free tier)
- **LLMs:** Azure OpenAI (GPT-5.2 + GPT-5 Nano + text-embedding-3-small)
- **CI/CD:** `.github/workflows/deploy-dotnet.yml` — `dotnet publish` + zip deploy vía Kudu

### RAG Pipeline

```
Query → 1.Expand(Nano) → 2.Embed(e3s) → 3.Sparse(TF-IDF)
     → 4.Search(Qdrant ×3 colecciones, híbrido RRF)
     → 5b.Refs(filtradas, score heredado) → Cap(sort+top25) → 5.Answer+Eval(GPT-5.2)
```

- **Query expansion:** GPT-5 Nano genera 1-4 búsquedas de keywords (3-6 palabras)
- **Context carryover:** Chunks de turnos anteriores se arrastran automáticamente (score=0.5)
- **Búsqueda híbrida:** Dense (semántica) + Sparse (TF-IDF/BM25) con fusión RRF
- **Cross-collection:** 3 colecciones en paralelo, ponderación (normativa×1.0, sentencias×0.8, criterios×0.9)
- **Reference expansion:** Refs pre-computadas filtradas (dirección ascendente, siblings, cap 3/chunk, cap global 15 refs). Score heredado = padre × 0.8
- **Scoring & Cap:** Todos los chunks se puntúan con `_score`, se ordenan por score desc y se toman top 25 (`MAX_CHUNKS_TO_MODEL`)
- **Unified answer:** GPT-5.2 responde + reporta USED/DROP/NEED en una sola llamada
- **DROP → carryover:** Chunks marcados como DROP no se arrastran a turnos siguientes
- **Vocabulario TF-IDF:** JSON estático desplegado con el servidor (`server-dotnet/ChatbotRag.Api/Data/tfidf_vocabulary.json`)

### Agent Mode (Azure AI Foundry)

⚠️ **Estado: inestable** — `CreateAgentAsync` falla con `Unknown fields: model, name, instructions` (incompatibilidad SDK ↔ API endpoint de AI Foundry).

Modo alternativo al pipeline. Usa `AgentManager` + `ToolExecutor` para crear un agente con herramientas:
- `search_normativa` — busca en Qdrant
- `search_sentencias` — busca en jurisprudencia
- `get_article` — fetch de artículo concreto
- `get_related_chunks` — expande referencias de un chunk

El agente llama a las herramientas iterativamente. Endpoint: `POST /api/rag-agent` (SSE streaming).

**MSI configurada:** App Service tiene System-Assigned Identity (`5d5eeccf-ed1d-4098-b72a-e7cb458f94b8`) con roles `Azure AI Developer` + `Azure AI User` en `javie-mku5l3k8-swedencentral` hub.

### Endpoints API (.NET)

| Endpoint | Descripción |
|----------|-------------|
| `POST /api/chat` | Proxy directo a Azure OpenAI (cualquier modelo) |
| `POST /api/rag-pipeline` | Pipeline RAG completo (SSE streaming) |
| `POST /api/rag-agent` | Agente con herramientas RAG (SSE streaming, requiere Foundry) |

### Presets del frontend

| Preset ID | Nombre | Backend |
|-----------|--------|---------|
| `ss-expert-pipeline` | SS Expert (RAG) | `/api/rag-pipeline` (SSE) — **activo y funcional** |
| `ss-expert-agent` | SS Expert (Agente) | `/api/rag-agent` (SSE) — ⚠️ inestable |

### SSE Streaming Protocol

El backend emite eventos SSE:
```
event: token\ndata: {"text":"..."}\n\n
event: tool_status\ndata: {"message":"Buscando normativa..."}\n\n
event: done\ndata: {"usage":{...}}\n\n
event: error\ndata: {"message":"..."}\n\n
```

El frontend (`api.js` → `callStreaming()`) maneja estos eventos mostrando tokens progresivamente y pills de actividad de herramientas.

---

## Estructura del proyecto

```
├── public/                      # Frontend (static files, ES modules)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── config.js            # Presets de modelos y endpoints
│       ├── storage.js           # Wrapper de LocalStorage
│       ├── api.js               # Capa de comunicación API (call + callStreaming)
│       ├── ui.js                # DOM, markdown, sidebar, streaming helpers
│       ├── chat.js              # Estado y lógica del chat
│       └── app.js               # Inicialización, eventos, imports
├── server-dotnet/               # Backend .NET 10 (ACTIVO en producción)
│   └── ChatbotRag.Api/
│       ├── Program.cs           # Entry point, DI, static files, PORT env var
│       ├── AppConfig.cs         # Env vars, constantes, SystemPrompt
│       ├── appsettings.json
│       ├── Agent/
│       │   ├── AgentManager.cs  # AIProjectClient + PersistentAgentsClient
│       │   ├── ToolDefinitions.cs
│       │   └── ToolExecutor.cs  # Ejecuta herramientas RAG del agente
│       ├── Data/
│       │   └── tfidf_vocabulary.json
│       ├── Endpoints/
│       │   ├── AuthHelper.cs    # Valida x-api-key header
│       │   ├── ChatEndpoints.cs # POST /api/chat
│       │   ├── RagPipelineEndpoints.cs  # POST /api/rag-pipeline (SSE)
│       │   ├── RagAgentEndpoints.cs     # POST /api/rag-agent (SSE)
│       │   └── SseHelper.cs     # Writes SSE events to HttpResponse
│       ├── Models/
│       │   ├── ApiModels.cs     # Request/Response DTOs
│       │   ├── ChunkResult.cs   # Chunk con score
│       │   └── QdrantModels.cs  # Qdrant REST response models
│       ├── Pipeline/
│       │   ├── ExpandStage.cs   # Stage 1: Query decomposition (Nano)
│       │   ├── SearchStage.cs   # Stages 2-4: Embed + sparse + Qdrant
│       │   ├── EnrichStage.cs   # Stage 5b: Reference expansion
│       │   └── AnswerStage.cs   # Stage 5: GPT-5.2 answer + eval
│       └── Services/
│           ├── OpenAiService.cs # embed(), callNano(), callGPT52(), streaming
│           ├── QdrantService.cs # searchCollection(), fetchByIds()
│           └── TfidfService.cs  # Sparse vector computation
├── src/scripts/                 # Offline processing (Python + Node.js)
│   ├── extract_chunks.py        # Extrae texto del PDF, segmenta por artículo
│   ├── clean_chunks_v2.py       # Limpia headers/footers del BOE
│   ├── enhance_chunks.py        # Añade jerarquía capítulo/título/sección
│   ├── enrich_chunks.py         # Enriquece con GPT-5 Nano
│   ├── build_tfidf.js           # Genera vocabulario IDF
│   ├── upload_to_qdrant.js      # Embede + sparse + sube a Qdrant
│   ├── add_refs.js              # Genera refs[] pre-computados
│   ├── transcribe_audio.js      # Transcribe audio OGG/MP3→WAV via Azure Speech
│   └── (otros: download, fix, test, check scripts)
├── data/                        # Datos locales (no commiteados, en .gitignore)
│   ├── chunks/                  # JSON con chunks procesados
│   └── sentencias/              # PDFs y metadata de sentencias
├── docs/                        # Documentación
│   ├── rag-pipeline-stages.md   # Detalle de cada etapa del pipeline
│   └── plan-ragSeguridadSocial.prompt.prompt.md
├── .github/
│   ├── copilot-instructions.md  # ← este archivo
│   ├── workflows/deploy-dotnet.yml  # CI/CD activo: .NET → App Service
│   └── workflows/deploy.yml         # CI/CD legacy (desactivado, solo manual)
├── deploy.ps1                   # Deploy manual Node.js (zip deploy)
├── package.json                 # Node.js deps (express, ffmpeg-static, etc.)
└── .env.example                 # Template de variables de entorno
```

---

## Despliegue

### CI/CD activo — .NET (GitHub Actions)
Se dispara en push a `master` con cambios en `server-dotnet/**`, `public/**` o el propio workflow:
1. `dotnet publish` — framework-dependent (sin `-r linux-x64`), output en `./publish`
2. Copia `public/` → `publish/wwwroot/`
3. Crea `publish/oryx-manifest.toml` con `PlatformName=dotnet`, `PlatformVersion=10.0`
4. Zip con Python (forward slashes) → Kudu zipdeploy async
5. Poll hasta `status=4`

**Workflow:** `.github/workflows/deploy-dotnet.yml`
**Requiere:** GitHub secret `AZURE_WEBAPP_PUBLISH_PROFILE` (en environment `Chatbot-RAG`)

⚠️ **Oryx manifest:** Aunque `SCM_DO_BUILD_DURING_DEPLOYMENT=false`, Oryx sigue generando el startup script. Necesita `oryx-manifest.toml` para detectar el runtime .NET correctamente.

⚠️ **Puerto:** App Service envía `PORT=8080`. El `Program.cs` lee `$PORT` en `builder.WebHost.UseUrls()`. Sin esto, ASP.NET Core escucha en 5000 y App Service mata el proceso.

### CI/CD legacy — Node.js
**Desactivado** (sin push trigger). Para activar de nuevo: descomentar el bloque `push:` en `.github/workflows/deploy.yml`.

### App Service Config
- **Runtime:** `DOTNETCORE|10.0`, Linux
- **Startup command:** `dotnet ChatbotRag.Api.dll`
- **Plan:** B1 (Basic) — sin límite CPU
- `SCM_DO_BUILD_DURING_DEPLOYMENT=false`
- `WEBSITE_RUN_FROM_PACKAGE=0`

---

## Comandos útiles

```powershell
# Verificar suscripción Azure
az account show --query "{name:name, id:id}" -o table

# Ver variables de entorno del App Service
az webapp config appsettings list --name chatbot-rag-javi --resource-group rg-chatbot-rag -o table

# Actualizar una variable de entorno
az webapp config appsettings set --name chatbot-rag-javi --resource-group rg-chatbot-rag --settings "KEY=value"

# Ver logs en tiempo real
az webapp log tail --name chatbot-rag-javi --resource-group rg-chatbot-rag

# Descargar logs
az webapp log download --name chatbot-rag-javi --resource-group rg-chatbot-rag --log-file app-logs.zip

# Ver estado de deploys
gh run list --repo javipino/Chatbot-RAG --limit 5

# Re-disparar deploy .NET manualmente
gh workflow run "Deploy .NET Backend to Azure App Service" --repo javipino/Chatbot-RAG --ref master

# Build local .NET
dotnet build server-dotnet/ChatbotRag.Api/ChatbotRag.Api.csproj

# Publicar local (para probar el zip)
dotnet publish server-dotnet/ChatbotRag.Api/ChatbotRag.Api.csproj -c Release -o ./publish
```

---

## Entorno de trabajo

- **OS:** Windows 10, PowerShell 5.1
- **Sin derechos de admin**
- **GitHub:** repo `javipino/Chatbot-RAG` (público), cuenta `javipino`
- **Git remote:** `https://javipino@github.com/javipino/Chatbot-RAG.git`

---

## Notas técnicas

- **GPT-5 Nano** no soporta `temperature`, solo `max_completion_tokens` (usar 4096)
- **Qdrant free tier:** 1GB RAM, sin pausa por inactividad
- **TF-IDF vocabulary:** generado offline por `build_tfidf.js`, desplegado con el servidor
- **RRF k=2** en Qdrant (default)
- **App Service B1:** sin límite CPU, ~€13/mes. Migrado de F1 porque el .NET consume CPU en arranque frío.
- **ES modules (frontend):** `<script type="module">`, imports entre módulos. No bundler.
- **`AIProjectClient`** (Azure.AI.Projects 1.1.0): solo acepta `AuthenticationTokenProvider`. Usar `DefaultAzureCredential` vía Azure.Identity. En producción requiere Managed Identity con rol **Azure AI Developer** en el proyecto Foundry.
- **`dotnet publish` sin `-r linux-x64`:** produce IL portable (framework-dependent). Con `-r linux-x64` produce binario nativo que el contenedor App Service no puede ejecutar como DLL.
- **Zip paths:** usar Python `zipfile` para crear zips con forward slashes. `Compress-Archive` de PowerShell usa backslashes que pueden causar problemas.
