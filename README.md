# Chatbot-RAG

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española.

## Descripción

Este proyecto implementa un chatbot que puede responder preguntas sobre legislación laboral española utilizando RAG. Los chunks de normativa se indexan en Azure AI Search con embeddings vectoriales, permitiendo búsqueda semántica + respuestas generadas por GPT.

**Fuente de datos:** PDF del BOE "Código Laboral y de la Seguridad Social" — 36MB, 2,753 páginas, 132 leyes.

## Estructura del proyecto

```
Chatbot-RAG/
├── .env.example         # Variables de entorno (copiar a .env)
├── docs/                # Documentación
│   ├── SESSION-CONTEXT.md
│   └── plan-*.md
├── src/
│   ├── functions/       # Azure Functions (Node.js)
│   │   ├── api/         # Proxy API para modelos
│   │   ├── app/         # UI del chat
│   │   └── rag/         # Endpoint RAG
│   └── scripts/         # Scripts Python de procesamiento
├── data/
│   └── chunks/          # Chunks JSON procesados
└── ui/
    └── index.html       # Interfaz web del chat
```

## Requisitos

- Python 3.10+
- Node.js 18+ (para Azure Functions)
- Azure CLI (`az`)
- Cuentas configuradas:
  - Azure OpenAI (GPT + embeddings)
  - Azure AI Search

## Configuración

1. Copia el archivo de ejemplo:
   ```bash
   cp .env.example .env
   ```

2. Completa las API keys en `.env`

3. Para scripts Python:
   ```bash
   pip install openai
   ```

## Uso

### Scripts de procesamiento (Python)

```bash
# Crear índice en Azure Search
python src/scripts/create_index.py

# Enriquecer chunks con GPT
python src/scripts/enrich_chunks.py

# Subir chunks con embeddings a Search
python src/scripts/upload_to_search.py
```

### Azure Functions

Desplegar en Azure Functions App `func-consultas-internas`:
- `GET /api/app` - Sirve la UI del chat
- `POST /api/api` - Proxy para llamadas a modelos
- `POST /api/rag` - Endpoint RAG (búsqueda + generación)

## Arquitectura

```
Usuario → Chat UI → /api/rag → Azure AI Search (vector search)
                            ↓
                    Azure OpenAI GPT (genera respuesta con contexto)
```

## Licencia

Proyecto privado.
