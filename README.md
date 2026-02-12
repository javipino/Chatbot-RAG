# Chatbot-RAG

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española.

## Descripción

Chatbot multi-modelo con un preset RAG especializado en legislación laboral. Los chunks de normativa se indexan en Azure AI Search con embeddings vectoriales, permitiendo búsqueda híbrida (vector + texto + semántica) + respuestas generadas por GPT.

**Fuente de datos:** PDF del BOE "Código Laboral y de la Seguridad Social" — 36MB, 2,753 páginas, 132 leyes.

**URL:** https://icy-cliff-078467803.2.azurestaticapps.net

## Estructura del proyecto

```
Chatbot-RAG/
├── ui/                          # Frontend (static files)
│   ├── index.html               # HTML principal
│   ├── css/styles.css           # Estilos
│   └── js/                      # Módulos JS
│       ├── config.js            # Presets de modelos y endpoints
│       ├── storage.js           # Wrapper de LocalStorage
│       ├── api.js               # Capa de comunicación API
│       ├── ui.js                # Manipulación DOM
│       ├── chat.js              # Estado y lógica del chat
│       └── app.js               # Inicialización y eventos
├── api/                         # Azure Functions (SWA managed)
│   ├── chat/                    # POST /api/chat — Proxy para modelos
│   └── rag/                     # POST /api/rag — Endpoint RAG
├── src/
│   ├── functions/               # Azure Functions originales (legacy)
│   └── scripts/                 # Scripts Python de procesamiento
├── data/
│   └── chunks/                  # Chunks JSON procesados
├── docs/                        # Documentación
├── staticwebapp.config.json     # Config de Azure Static Web Apps
└── .env.example                 # Template de variables de entorno
```

## Hosting

**Azure Static Web Apps** (Free tier):
- Frontend servido como ficheros estáticos desde `ui/`
- API como managed functions desde `api/`
- Same-origin (sin CORS)
- Auto-deploy desde GitHub en cada push a `master`

## Requisitos

- Python 3.10+ (para scripts de procesamiento)
- Azure CLI (`az`)
- GitHub CLI (`gh`) — opcional
- Cuentas configuradas:
  - Azure OpenAI (GPT + embeddings)
  - Azure AI Search

## Configuración

1. Copia el archivo de ejemplo:
   ```bash
   cp .env.example .env
   ```

2. Completa las API keys en `.env` (solo para scripts Python)

3. Las variables de entorno de las funciones API se configuran en Azure:
   ```powershell
   az staticwebapp appsettings set --name chatbot-rag-javi \
     --resource-group rg-chatbot-rag \
     --setting-names "AZURE_OPENAI_KEY=..." "AZURE_SEARCH_KEY=..."
   ```

## Uso

### Scripts de procesamiento (Python)

```bash
python src/scripts/create_index.py      # Crear índice en Azure Search
python src/scripts/enrich_chunks.py     # Enriquecer chunks con GPT
python src/scripts/upload_to_search.py  # Subir chunks con embeddings
```

### Despliegue

Automático con GitHub Actions — solo hacer push a `master`:
```bash
git push origin master
```

### Endpoints API

- `POST /api/chat` — Proxy genérico para Azure OpenAI / Azure AI
- `POST /api/rag` — RAG: embed query → hybrid search → GPT response

## Modelos disponibles

| Preset | Modelo | Formato API |
|--------|--------|-------------|
| GPT-5.2 Codex | gpt-5.2-codex | Responses API |
| GPT-5.2 | gpt-5.2 | Responses API |
| Kimi K2.5 | Kimi-K2.5 | Chat Completions |
| SS Expert (RAG) | gpt-5.2 + AI Search | RAG (server-side) |

## Arquitectura

```
Usuario → Static Web App (ui/) → /api/chat → Azure OpenAI (proxy)
                                → /api/rag  → Embeddings (text-embedding-3-small)
                                            → Azure AI Search (hybrid search, k=8)
                                            → Azure OpenAI GPT-5.2 (genera respuesta)
```

## Licencia

Proyecto privado.
