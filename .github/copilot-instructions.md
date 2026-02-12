# Copilot Instructions - Chatbot RAG

## Proyecto

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española. Integrado como preset "SS Expert (RAG)" en un chat UI desplegado en Azure Functions.

**Fuente de datos:** PDF del BOE "Código Laboral y de la Seguridad Social" — 36MB, 2,753 páginas, 132 leyes.

---

## ⚠️ RESTRICCIONES CRÍTICAS

### Azure
- **SOLO actuar sobre la suscripción:** `1acd8d40-20d5-43b4-b8a4-3aed0f6f38a6` (Visual Studio Professional Javi)
- Antes de cualquier operación en Azure, verificar que estás en la suscripción correcta con `az account show`
- NO crear recursos en otras suscripciones bajo ningún concepto

### Secretos
- Las API keys están en `.env` (nunca commitear)
- Usar siempre variables de entorno en el código (`process.env.*` / `os.environ[]`)

---

## Recursos Azure

| Recurso | Nombre | Región |
|---------|--------|--------|
| Azure OpenAI (principal) | `javie-mku5l3k8-swedencentral` | Sweden Central |
| Azure OpenAI (reader) | `openai-reader-javi` | Sweden Central |
| Azure AI Search | `ai-search-javi` | West Europe |
| Function App | `func-consultas-internas` | West Europe |

### Deployments OpenAI
- **Principal:** `gpt-5.2`, `gpt-5.2-codex`
- **Reader:** `text-embedding-3-small` (1536 dims), `gpt-5-nano`

### Azure AI Search
- **Index:** `normativa`
- **Tier:** Free (50MB límite)

---

## Estructura del proyecto

```
├── src/
│   ├── azure-function/     # Azure Functions (app, api, rag)
│   └── scripts/            # Python scripts (extract, enrich, upload)
├── data/
│   └── chunks/             # JSON con chunks de normativa
├── docs/                   # Documentación del proyecto
├── ui/                     # Archivos UI standalone
└── .env.example            # Template de variables de entorno
```

---

## Comandos útiles

```powershell
# Verificar suscripción Azure
az account show --query "{name:name, id:id}" -o table

# Desplegar función
cd src/azure-function
func azure functionapp publish func-consultas-internas

# Logs de la function app
az webapp log tail --name func-consultas-internas --resource-group rg-consultas-internas
```

---

## Entorno de trabajo

- **OS:** Windows 10, PowerShell 5.1
- **Proxy corporativo:** `proxy-tmp.seg-social.es:8080` (bloquea POST, SSL transparente)
- **Sin derechos de admin**
