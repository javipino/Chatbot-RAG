# Copilot Instructions - Chatbot RAG

## Proyecto

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española. Chat multi-modelo con preset "SS Expert (RAG)" desplegado en Azure App Service (F1 free tier).

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
- **Crédito Azure:** 50€ máximo. No crear recursos de pago.
- App Service F1: 60 min CPU/día. Evitar builds en servidor (Oryx).
- Azure AI Search fue eliminado por coste. Usar Qdrant Cloud (free tier).

### Secretos
- Las API keys están en `.env` (nunca commitear) y en App Service App Settings
- Usar siempre variables de entorno en el código (`process.env.*` / `os.environ[]`)

---

## Recursos Azure

| Recurso | Nombre | Resource Group | Región |
|---------|--------|----------------|--------|
| Azure OpenAI (principal) | `javie-mku5l3k8-swedencentral` | ebook-reader | Sweden Central |
| Azure OpenAI (reader) | `OpenAI-reader-Javi` | ebook-reader | Sweden Central |
| App Service (F1 free) | `chatbot-rag-javi` | rg-chatbot-rag | West Europe |
| App Service Plan (F1) | `plan-chatbot-rag` | rg-chatbot-rag | West Europe |

### Recursos eliminados
- ~~Azure AI Search (`ai-search-javi`)~~ — Eliminado, migrado a Qdrant Cloud
- ~~Static Web App (`chatbot-rag-javi`)~~ — Eliminado, migrado a App Service
- ~~SpeechAI-Javi~~ — Eliminado (no usado)

### Deployments OpenAI
- **Principal:** `gpt-5.2`, `gpt-5.2-codex`
- **Reader:** `text-embedding-3-small` (1536 dims), `gpt-5-nano`

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
- `QDRANT_URL`, `QDRANT_API_KEY`
- `RAG_API_KEY`

---

## Arquitectura

### Stack
- **Backend:** Express.js (Node 20 LTS, Linux) — modularizado en `server/`
- **Frontend:** Vanilla JS con ES modules — en `public/`
- **Hosting:** Azure App Service F1 (free, 60 min CPU/día, 230s timeout)
- **Vector DB:** Qdrant Cloud (free tier)
- **LLMs:** Azure OpenAI (GPT-5.2 + GPT-5 Nano + text-embedding-3-small)
- **CI/CD:** GitHub Actions — pre-built zip deploy (sin Oryx build en servidor)

### RAG Pipeline (6 etapas)

```
Query → 1.Expand(Nano) → 2.Embed(e3s) → 3.Sparse(TF-IDF)
     → 4.Search(Qdrant ×3 colecciones, híbrido RRF)
     → 5.Rerank(Nano) → 5b.Refs → 5c.Eval(GPT-5.2 iterativo)
     → 6.Answer(GPT-5.2 + contexto)
```

- **Query expansion:** GPT-5 Nano expande pregunta general en 1-4 búsquedas legales específicas
- **Búsqueda híbrida:** Dense (semántica) + Sparse (TF-IDF/BM25) con fusión RRF
- **Cross-collection:** 3 queries paralelas, ponderación configurable (normativa×1.0, sentencias×0.8, criterios×0.9)
- **Reranker:** GPT-5 Nano puntúa relevancia 1-10, topK dinámico (8-16 según nº queries)
- **Reference expansion:** Chunks pre-computados `refs[]` → fetch por ID desde Qdrant
- **Context evaluation:** GPT-5.2 evalúa contexto (NEED/DROP/READY), iterativo ×2
- **Vocabulario TF-IDF:** JSON estático desplegado con el servidor (`server/data/tfidf_vocabulary.json`)

### Logging

Todas las etapas emiten logs con tag `[STAGE]` para diagnóstico:
- `[INIT]`, `[S1-EXPAND]`, `[S2-EMBED]`, `[S3-SPARSE]`, `[S4-SEARCH]`, `[S4-MERGE]`
- `[S4→S5]`, `[S5-RERANK]`, `[S5b-REFS]`, `[S5c-EVAL]`, `[S5c-FETCH]`
- `[S6-ANSWER]`

---

## Estructura del proyecto

```
├── public/                      # Frontend (static files, ES modules)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── config.js            # Presets de modelos y endpoints
│       ├── storage.js           # Wrapper de LocalStorage
│       ├── api.js               # Capa de comunicación API
│       ├── ui.js                # Manipulación DOM, markdown, sidebar
│       ├── chat.js              # Estado y lógica del chat
│       └── app.js               # Inicialización, eventos, imports
├── server/                      # Backend Express (modular)
│   ├── index.js                 # Entry point, Express app, static + SPA
│   ├── config.js                # Env vars, constantes, SYSTEM_PROMPT
│   ├── middleware/
│   │   └── auth.js              # x-api-key validation
│   ├── routes/
│   │   ├── chat.js              # POST /api/chat — Proxy para modelos
│   │   └── rag.js               # POST /api/rag — Orquestador RAG pipeline
│   ├── services/
│   │   ├── http.js              # httpsRequest() helper
│   │   ├── tfidf.js             # Stemmer español, tokenizer, sparse vectors
│   │   ├── openai.js            # embed(), callNano(), callGPT52()
│   │   └── qdrant.js            # searchCollection(), fetchByArticleFilter()
│   ├── pipeline/
│   │   ├── expand.js            # Stage 1: Query decomposition
│   │   ├── search.js            # Stages 2-4: Embed + sparse + hybrid search
│   │   ├── rerank.js            # Stage 5: LLM reranking
│   │   ├── enrich.js            # Stages 5b+5c: Refs + context evaluation
│   │   └── answer.js            # Stage 6: Context building + generation
│   └── data/
│       └── tfidf_vocabulary.json
├── src/scripts/                 # Offline processing (Python + Node.js)
│   ├── extract_chunks.py        # Extrae texto del PDF, segmenta por artículo
│   ├── clean_chunks_v2.py       # Limpia headers/footers del BOE
│   ├── enhance_chunks.py        # Añade jerarquía capítulo/título/sección
│   ├── enrich_chunks.py         # Enriquece con GPT-5 Nano
│   ├── build_tfidf.js           # Genera vocabulario IDF
│   ├── upload_to_qdrant.js      # Embede + sparse + sube a Qdrant
│   ├── add_refs.js              # Genera refs[] pre-computados
│   └── (otros: download, fix, test, check scripts)
├── data/                        # Datos locales (no commiteados, en .gitignore)
│   ├── chunks/                  # JSON con chunks procesados
│   └── sentencias/              # PDFs y metadata de sentencias
├── docs/                        # Documentación
│   ├── rag-pipeline-stages.md   # Detalle de cada etapa del pipeline
│   └── plan-ragSeguridadSocial.prompt.prompt.md
├── .github/
│   ├── copilot-instructions.md  # ← este archivo
│   └── workflows/deploy.yml     # CI/CD: GitHub Actions → App Service
├── deploy.ps1                   # Deploy manual (zip deploy local)
├── package.json                 # "start": "node server/index.js"
└── .env.example                 # Template de variables de entorno
```

---

## Despliegue

### CI/CD (GitHub Actions)
Auto-deploy en cada push a `master`:
1. `npm ci --omit=dev` (instala solo express)
2. `zip -r deploy.zip server/ public/ node_modules/ package.json package-lock.json`
3. Kudu zipdeploy API vía `curl` con basic auth (publish profile credentials)
4. Poll async hasta `status=4` (success)
5. `SCM_DO_BUILD_DURING_DEPLOYMENT=false` en App Settings (evita Oryx build)

**Workflow:** `.github/workflows/deploy.yml`
**Requiere:** GitHub secret `AZURE_WEBAPP_PUBLISH_PROFILE` (en environment `Chatbot-RAG`)

⚠️ **Zip paths:** En Windows, usar .NET `ZipFile` con `.Replace('\\','/')` para crear
zips con forward slashes. `Compress-Archive` usa backslashes que rompen rsync en Linux.

### Deploy manual
```powershell
.\deploy.ps1
```

### App Service Config
- **Startup command:** `node server/index.js`
- **Runtime:** Node 20 LTS, Linux
- **Plan:** F1 (free) — límite 60 min CPU/día

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

# Desplegar (automático con push)
git push origin master

# Ver estado del deploy
gh run list --repo javipino/Chatbot-RAG --limit 3

# Deploy manual
.\deploy.ps1
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
- **RRF k=2** en Qdrant (default). Azure AI Search usaba k=60.
- **App Service F1:** 60 min CPU/day. Pre-build zip deploy evita consumo de CPU en servidor.
- **Express:** Única dependencia npm en producción (`express@^4.22.1`)
- **ES modules (frontend):** `<script type="module">`, imports entre módulos. No bundler.
