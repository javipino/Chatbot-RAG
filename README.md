# Chatbot-RAG

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española.

## Descripción

Chatbot multi-modelo con un preset RAG especializado en legislación laboral española. Los chunks de normativa se indexan en Qdrant Cloud con embeddings + sparse vectors (TF-IDF), permitiendo búsqueda híbrida con fusión RRF + respuestas generadas por GPT-5.2.

**Fuente de datos:** PDF del BOE "Código Laboral y de la Seguridad Social" — 36MB, 2,753 páginas, 132 leyes, 5,648 chunks enriquecidos.

**URL:** https://chatbot-rag-javi.azurewebsites.net

## Arquitectura

```
Usuario → App Service (Express.js)
           ├── /api/chat → Azure OpenAI (proxy directo)
           └── /api/rag  → Pipeline RAG:
                 1. Query expansion (GPT-5 Nano)
                 2. Embedding (text-embedding-3-small)
                 3. Sparse vector (TF-IDF/BM25 local)
                 4. Hybrid search (Qdrant Cloud, RRF)
                 5. Reranking (GPT-5 Nano) + refs + eval
                 6. Answer generation (GPT-5.2)
```

## Estructura del proyecto

```
├── public/                  # Frontend (vanilla JS, ES modules)
│   ├── index.html
│   ├── css/styles.css
│   └── js/                  # config, storage, api, ui, chat, app
├── server/                  # Backend (Express.js, modular)
│   ├── index.js             # Entry point
│   ├── config.js            # Env vars, constantes
│   ├── middleware/auth.js   # API key validation
│   ├── routes/              # chat.js, rag.js
│   ├── services/            # http, tfidf, openai, qdrant
│   └── pipeline/            # expand, search, rerank, enrich, answer
├── src/scripts/             # Offline data processing
├── data/                    # Local data (gitignored)
├── docs/                    # Documentation
└── deploy.ps1               # Manual deploy script
```

## Stack

- **Backend:** Express.js (Node 20 LTS)
- **Frontend:** Vanilla JS with ES modules (no framework, no bundler)
- **Hosting:** Azure App Service F1 (free tier, Linux)
- **Vector DB:** Qdrant Cloud (free tier, 1GB RAM)
- **LLMs:** Azure OpenAI — GPT-5.2, GPT-5 Nano, text-embedding-3-small
- **CI/CD:** GitHub Actions → zip deploy (no server-side build)

## Modelos disponibles

| Preset | Modelo | Descripción |
|--------|--------|-------------|
| GPT-5.2 Codex | `gpt-5.2-codex` | Modelo principal de código |
| GPT-5.2 | `gpt-5.2` | Modelo general |
| Kimi K2.5 | `Kimi-K2.5` | Azure AI model |
| SS Expert (RAG) | `gpt-5.2` + Qdrant | RAG especializado en normativa laboral |

## Despliegue

Auto-deploy vía GitHub Actions en cada push a `master`:

```bash
git push origin master
```

Deploy manual:

```powershell
.\deploy.ps1
```

## Configuración

1. Copia `.env.example` → `.env` y completa las API keys
2. Configura App Service App Settings con las variables de entorno
3. Instala dependencias: `npm install`
4. Arranca local: `npm start` (http://localhost:8080)

## Licencia

Proyecto privado.
