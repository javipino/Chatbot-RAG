# Copilot Instructions - Chatbot RAG

## Proyecto

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española. Chat multi-modelo con preset "SS Expert (RAG)" desplegado en Azure Static Web Apps.

**Fuentes de datos (3 colecciones en Qdrant Cloud):**
1. **Normativa** — BOE "Código Laboral y de la Seguridad Social" (5,648 chunks enriquecidos)
2. **Sentencias** — Jurisprudencia Tribunal Supremo (pendiente)
3. **Criterios INSS** — Criterios interpretativos (pendiente)

**URL producción:** https://icy-cliff-078467803.2.azurestaticapps.net

---

## ⚠️ RESTRICCIONES CRÍTICAS

### Azure
- **SOLO actuar sobre la suscripción:** `1acd8d40-20d5-43b4-b8a4-3aed0f6f38a6` (Visual Studio Professional Javi)
- Antes de cualquier operación en Azure, verificar que estás en la suscripción correcta con `az account show`
- NO crear recursos en otras suscripciones bajo ningún concepto

### Presupuesto
- **Crédito Azure:** 50€ máximo. No crear recursos de pago.
- Azure AI Search fue eliminado por coste. Usar Qdrant Cloud (free tier).

### Secretos
- Las API keys están en `.env` (nunca commitear) y en SWA App Settings
- Usar siempre variables de entorno en el código (`process.env.*` / `os.environ[]`)

---

## Recursos Azure

| Recurso | Nombre | Resource Group | Región |
|---------|--------|----------------|--------|
| Azure OpenAI (principal) | `javie-mku5l3k8-swedencentral` | ebook-reader | Sweden Central |
| Azure OpenAI (reader) | `openai-reader-javi` | ebook-reader | Sweden Central |
| Static Web App | `chatbot-rag-javi` | rg-chatbot-rag | West Europe |

### Recursos eliminados
- ~~Azure AI Search (`ai-search-javi`)~~ — Eliminado, migrado a Qdrant Cloud

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

### Variables de entorno (SWA App Settings)
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_READER_ENDPOINT`, `AZURE_OPENAI_READER_KEY`
- `QDRANT_URL`, `QDRANT_API_KEY`

---

## Arquitectura RAG (6 etapas)

```
Query → 1.Expand(Nano) → 2.Embed(e3s) → 3.Sparse(TF-IDF)
     → 4.Search(Qdrant ×3 colecciones, híbrido RRF)
     → 5.Rerank(Nano, top20→top8)
     → 6.Answer(GPT-5.2 + contexto)
```

- **Query expansion:** GPT-5 Nano expande pregunta general en términos legales específicos
- **Búsqueda híbrida:** Dense (semántica) + Sparse (palabras exactas/TF-IDF) con fusión RRF
- **Cross-collection:** 3 queries paralelas, ponderación configurable (normativa×1.0, sentencias×0.8, criterios×0.9)
- **Reranker:** GPT-5 Nano puntúa relevancia 1-10 de los top 20 para seleccionar top 8
- **Vocabulario TF-IDF:** JSON estático desplegado con la función (`api/data/tfidf_vocabulary.json`)

---

## Estructura del proyecto

```
├── ui/                      # Frontend (static files, servido por SWA)
│   ├── index.html
│   ├── css/styles.css
│   └── js/                  # Módulos: config, storage, api, ui, chat, app
├── api/                     # Azure Functions (SWA managed functions)
│   ├── chat/                # POST /api/chat — Proxy para modelos
│   ├── rag/                 # POST /api/rag — RAG endpoint (Qdrant + reranking)
│   └── data/
│       └── tfidf_vocabulary.json  # Vocabulario IDF para sparse vectors en runtime
├── src/
│   ├── functions/           # Azure Functions originales (legacy)
│   └── scripts/             # Python scripts (extract, enrich, upload, tfidf)
├── data/
│   ├── chunks/              # JSON con chunks de normativa
│   └── tfidf_vocabulary.json  # Vocabulario IDF global
├── docs/                    # Documentación del proyecto
├── staticwebapp.config.json # Config SWA (rutas, fallback, runtime)
└── .env.example             # Template de variables de entorno
```

---

## Despliegue

Auto-deploy vía GitHub Actions en cada push a `master`:
- **app_location:** `ui/` (frontend estático)
- **api_location:** `api/` (managed functions, Node 18)
- **Workflow:** `.github/workflows/azure-static-web-apps-icy-cliff-078467803.yml`

---

## Comandos útiles

```powershell
# Verificar suscripción Azure
az account show --query "{name:name, id:id}" -o table

# Ver variables de entorno de SWA
az staticwebapp appsettings list --name chatbot-rag-javi --resource-group rg-chatbot-rag

# Actualizar una variable de entorno
az staticwebapp appsettings set --name chatbot-rag-javi --resource-group rg-chatbot-rag --setting-names "KEY=value"

# Desplegar (automático con push)
git push origin master

# Ver estado del deploy
gh run list --repo javipino/Chatbot-RAG --limit 3
```

---

## Entorno de trabajo

- **OS:** Windows 10, PowerShell 5.1
- **Proxy corporativo:** `proxy-tmp.seg-social.es:8080` (bloquea POST desde scripts, browser same-origin funciona)
- **Sin derechos de admin**
- **GitHub:** repo `javipino/Chatbot-RAG` (público)

---

## Notas técnicas

- **GPT-5 Nano** no soporta `temperature`, solo `max_completion_tokens` (usar 4096)
- **Proxy corporativo** bloquea POST — por eso se usa Azure Functions como proxy
- **Qdrant free tier:** 1GB RAM, sin pausa por inactividad
- **TF-IDF vocabulary:** generado offline por `build_tfidf.py`, desplegado con la función
- **RRF k=2** en Qdrant (default). Azure AI Search usaba k=60.
