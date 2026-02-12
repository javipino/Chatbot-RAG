# Copilot Instructions - Chatbot RAG

## Proyecto

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española. Chat multi-modelo con preset "SS Expert (RAG)" desplegado en Azure Static Web Apps.

**Fuente de datos:** PDF del BOE "Código Laboral y de la Seguridad Social" — 36MB, 2,753 páginas, 132 leyes.

**URL producción:** https://icy-cliff-078467803.2.azurestaticapps.net

---

## ⚠️ RESTRICCIONES CRÍTICAS

### Azure
- **SOLO actuar sobre la suscripción:** `1acd8d40-20d5-43b4-b8a4-3aed0f6f38a6` (Visual Studio Professional Javi)
- Antes de cualquier operación en Azure, verificar que estás en la suscripción correcta con `az account show`
- NO crear recursos en otras suscripciones bajo ningún concepto

### Secretos
- Las API keys están en `.env` (nunca commitear) y en SWA App Settings
- Usar siempre variables de entorno en el código (`process.env.*` / `os.environ[]`)

---

## Recursos Azure

| Recurso | Nombre | Resource Group | Región |
|---------|--------|----------------|--------|
| Azure OpenAI (principal) | `javie-mku5l3k8-swedencentral` | ebook-reader | Sweden Central |
| Azure OpenAI (reader) | `openai-reader-javi` | ebook-reader | Sweden Central |
| Azure AI Search | `ai-search-javi` | ebook-reader | West Europe |
| Static Web App | `chatbot-rag-javi` | rg-chatbot-rag | West Europe |

### Deployments OpenAI
- **Principal:** `gpt-5.2`, `gpt-5.2-codex`
- **Reader:** `text-embedding-3-small` (1536 dims), `gpt-5-nano`

### Azure AI Search
- **Index:** `normativa`
- **Tier:** Free (50MB límite)

### Variables de entorno (SWA App Settings)
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_READER_ENDPOINT`, `AZURE_OPENAI_READER_KEY`
- `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_KEY`, `AZURE_SEARCH_INDEX`

---

## Estructura del proyecto

```
├── ui/                      # Frontend (static files, servido por SWA)
│   ├── index.html
│   ├── css/styles.css
│   └── js/                  # Módulos: config, storage, api, ui, chat, app
├── api/                     # Azure Functions (SWA managed functions)
│   ├── chat/                # POST /api/chat — Proxy para modelos
│   └── rag/                 # POST /api/rag — RAG endpoint
├── src/
│   ├── functions/           # Azure Functions originales (legacy)
│   └── scripts/             # Python scripts (extract, enrich, upload)
├── data/
│   └── chunks/              # JSON con chunks de normativa
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
