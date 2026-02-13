# RAG Seguridad Social - Contexto de sesión

## Qué es este proyecto

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española. Chat multi-modelo con preset "SS Expert (RAG)" desplegado en Azure Static Web Apps.

**Fuentes de datos (3 colecciones):**
1. **Normativa** — PDF del BOE "Código Laboral y de la Seguridad Social" (36MB, 2,753 págs, 132 leyes). 5,648 chunks enriquecidos.
2. **Sentencias** — Jurisprudencia del Tribunal Supremo (Sala Social). Pendiente de procesar.
3. **Criterios INSS** — Criterios interpretativos del Instituto Nacional de la Seguridad Social. Pendiente de procesar.

**URL producción:** https://icy-cliff-078467803.2.azurestaticapps.net

---

## Credenciales y endpoints

### Azure OpenAI (principal - GPT-5.2)
- **Endpoint:** `javie-mku5l3k8-swedencentral.cognitiveservices.azure.com`
- **API Key:** Ver `.env` (variable `AZURE_OPENAI_KEY`)
- **Deployments:** `gpt-5.2`, `gpt-5.2-codex`

### Azure OpenAI (reader - embeddings + nano)
- **Endpoint:** `openai-reader-javi.cognitiveservices.azure.com`
- **API Key:** Ver `.env` (variable `AZURE_OPENAI_READER_KEY`)
- **Deployments:** `text-embedding-3-small` (1536 dims), `gpt-5-nano`

### Kimi K2.5 (Azure AI)
- **Endpoint:** `openai-reader-javi.services.ai.azure.com`
- **Path:** `/openai/v1/chat/completions`
- **API Key:** misma que reader

### Qdrant Cloud (vector database — reemplaza Azure AI Search)
- **Cluster:** Free tier, 1GB RAM, región EU
- **Endpoint:** Ver `.env` (variable `QDRANT_URL`)
- **API Key:** Ver `.env` (variable `QDRANT_API_KEY`)
- **Colecciones:** `normativa`, `sentencias`, `criterios_inss`
- **Configuración:** Dense vectors 1536 dims (cosine) + Sparse vectors (TF-IDF con IDF modifier) + Payload indexes
- **Búsqueda:** Híbrida (prefetch dense + sparse, fusion RRF)

### Azure Static Web App
- **Nombre:** `chatbot-rag-javi`
- **Resource Group:** `rg-chatbot-rag`
- **URL:** https://icy-cliff-078467803.2.azurestaticapps.net
- **Frontend:** `ui/` (estático)
- **API:** `api/` (managed functions, Node 18)

### Entorno de trabajo
- **PC:** Windows 10, PowerShell 5.1, sin derechos de admin
- **Proxy corporativo:** `proxy-tmp.seg-social.es:8080` (bloquea POST, SSL transparente)
- **Local:** `C:\Repos\Training\RAG\`

---

## Estructura del proyecto

```
C:\Repos\Training\RAG\
├── ui/                          # Frontend (static files, servido por SWA)
│   ├── index.html
│   ├── css/styles.css
│   └── js/                      # Módulos: config, storage, api, ui, chat, app
├── api/                         # Azure Functions (SWA managed functions)
│   ├── host.json
│   ├── package.json             # Deps: @qdrant/js-client-rest
│   ├── chat/                    # POST /api/chat — Proxy para modelos
│   │   ├── function.json
│   │   └── index.js
│   ├── rag/                     # POST /api/rag — RAG endpoint (Qdrant + reranking)
│   │   ├── function.json
│   │   └── index.js
│   └── data/
│       └── tfidf_vocabulary.json  # Vocabulario IDF para sparse vectors en runtime
├── src/
│   ├── functions/               # Azure Functions originales (legacy, de func-consultas-internas)
│   └── scripts/
│       ├── extract_chunks.py    # Extrae texto del PDF, segmenta por artículo
│       ├── clean_chunks_v2.py   # Limpia headers/footers del BOE
│       ├── enhance_chunks.py    # Añade jerarquía capítulo/título/sección
│       ├── enrich_chunks.py     # Enriquece con GPT-5 Nano (resumen, keywords, preguntas)
│       ├── build_tfidf.py       # Genera sparse vectors TF-IDF + vocabulario IDF
│       ├── upload_to_qdrant.py  # Embede + genera sparse + sube a Qdrant Cloud
│       └── (varios test_*.py, analyze_*.py, check_*.py)
├── data/
│   ├── chunks/
│   │   ├── normativa_chunks_enriched.json  (17MB, 5,648 chunks enriquecidos)
│   │   └── normativa_chunks_v2.json        (11MB, chunks sin enriquecimiento)
│   └── tfidf_vocabulary.json               # Vocabulario IDF global (generado por build_tfidf.py)
├── docs/
│   └── SESSION-CONTEXT.md       # ← este archivo
├── staticwebapp.config.json     # Config SWA (rutas, fallback, runtime)
└── .env.example                 # Template de variables de entorno
```

---

## Arquitectura RAG (pipeline de 6 etapas)

```
Usuario → Azure Function (api/rag)
  ├─ 1. Query Expansion (GPT-5 Nano)
  │     Pregunta del usuario → términos legales específicos
  ├─ 2. Embedding (text-embedding-3-small)
  │     Query original → vector denso 1536d
  ├─ 3. Sparse Vector (TF-IDF)
  │     Query expandida → tokenizar + IDF desde vocabulario precargado
  ├─ 4. Búsqueda híbrida en Qdrant (3 colecciones en paralelo)
  │     Cada colección: prefetch(dense) + prefetch(sparse) → fusion RRF
  │     Ponderación cross-collection: normativa×1.0, sentencias×0.8, criterios×0.9
  ├─ 5. Reranker (GPT-5 Nano)
  │     Top 20 resultados → Nano puntúa relevancia 1-10 → seleccionar top 8
  └─ 6. Respuesta (GPT-5.2)
        Top 8 como contexto + system prompt experto legal → respuesta final
```

### Desglose de llamadas por query
| Llamada | Modelo | Tokens estimados | Propósito |
|---------|--------|-----------------|-----------|
| Query expansion | GPT-5 Nano | ~100 tokens | Expandir pregunta en términos legales |
| Embedding | text-embedding-3-small | ~50 tokens | Generar vector denso de la query |
| Reranker | GPT-5 Nano | ~500-1000 tokens | Puntuar relevancia de top 20 resultados |
| Respuesta | GPT-5.2 | ~2000-4000 tokens | Respuesta final con contexto y citas |

---

## Estado del pipeline de datos

| Paso | Estado | Descripción |
|------|--------|-------------|
| 1. Extracción PDF | ✅ Completo | 5,649 chunks de 2,753 páginas, regex por artículo |
| 2. Limpieza headers | ✅ Completo | Eliminados "CÓDIGO LABORAL", números de página, footers BOE |
| 3. Metadatos capítulo | ✅ Completo | 91% match con TOC (TÍTULO > CAPÍTULO > SECCIÓN) |
| 4. Normalización texto | ✅ Completo | \n→espacios, § eliminado de títulos y preámbulos |
| 5. Enriquecimiento LLM | ✅ Completo | GPT-5 Nano: resumen, palabras_clave, preguntas. 5,648/5,648, 0 errores |
| 6. Build TF-IDF | 🔲 Pendiente | Generar sparse vectors + vocabulario IDF |
| 7. Upload a Qdrant | 🔲 Pendiente | Embeder + sparse + subir 5,648 chunks a colección `normativa` |
| 8. Función RAG | 🔲 Pendiente | Reescribir para Qdrant + query expansion + reranking |
| 9. Chat UI preset | ✅ Desplegado | "SS Expert (RAG)" en el frontend |
| 10. Azure AI Search | 🗑️ ELIMINADO | Recurso borrado para ahorrar. Migrado a Qdrant Cloud |

---

## Estructura de un chunk enriquecido (normativa_chunks_enriched.json)

```json
{
  "law": "Real Decreto Legislativo 2/2015, ... Estatuto de los Trabajadores.",
  "chapter": "TÍTULO I. ... > CAPÍTULO II. ... > Sección 5.ª Tiempo de trabajo",
  "section": "Artículo 38. Vacaciones anuales.",
  "text": "1. El período de vacaciones anuales retribuidas, no sustituible por compensación económica...",
  "resumen": "Regula las vacaciones anuales retribuidas de los trabajadores...",
  "palabras_clave": ["vacaciones anuales", "retribución", "convenio colectivo", ...],
  "preguntas": ["¿Cuántos días mínimos de vacaciones...", ...]
}
```

---

## Qdrant — Configuración de colecciones

### Colección `normativa` (activa)
- **Dense vectors:** `text-dense` — 1536 dims, cosine, HNSW (m=16, ef_construct=100)
- **Sparse vectors:** `text-sparse` — TF-IDF con IDF modifier
- **Payload fields indexados:** `law` (keyword), `chapter` (text), `section` (keyword)
- **Payload almacenado:** `law`, `chapter`, `section`, `text`, `resumen`, `palabras_clave`
- **Búsqueda:** Prefetch dense(top 20) + Prefetch sparse(top 20) → Fusion RRF → top 10

### Colección `sentencias` (futura)
- Mismo schema. Campo `law` → `tribunal`. Campo `section` → `num_sentencia`.

### Colección `criterios_inss` (futura)
- Mismo schema. Campo `law` → `materia`. Campo `section` → `criterio_id`.

### Capacidad estimada (tier free 1GB RAM)
| Escenario | Chunks | Storage estimado | % del 1GB |
|-----------|--------|-----------------|-----------|
| Solo normativa | 5,648 | ~80 MB | 8% |
| 3 colecciones (15K) | 15,000 | ~212 MB | 21% |
| 3 colecciones (20K) | 20,000 | ~282 MB | 28% |

---

## Variables de entorno

### En `.env` (local) y SWA App Settings (producción)
```
# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://javie-mku5l3k8-swedencentral.cognitiveservices.azure.com
AZURE_OPENAI_KEY=***
AZURE_OPENAI_READER_ENDPOINT=https://openai-reader-javi.cognitiveservices.azure.com
AZURE_OPENAI_READER_KEY=***

# Qdrant Cloud
QDRANT_URL=https://<cluster-id>.eu-central.aws.cloud.qdrant.io:6333
QDRANT_API_KEY=***
```

### Variables eliminadas (ya no se usan)
- ~~`AZURE_SEARCH_ENDPOINT`~~ — Azure AI Search eliminado
- ~~`AZURE_SEARCH_KEY`~~ — Azure AI Search eliminado
- ~~`AZURE_SEARCH_INDEX`~~ — Azure AI Search eliminado

---

## Notas técnicas importantes

- **GPT-5 Nano** no soporta `temperature`, solo `max_completion_tokens` (usar 4096)
- **Proxy corporativo** bloquea POST — por eso se usa Azure Functions como proxy intermedio
- **Qdrant Cloud free tier**: 1GB RAM, sin pausa por inactividad, "free forever"
- **TF-IDF vocabulary**: se genera offline con `build_tfidf.py`, se copia a `api/data/` para deploy
- **Sparse vectors en runtime**: la Azure Function tokeniza la query expandida y calcula TF-IDF usando el vocabulario precargado (~10 líneas JS)
- **RRF fusion**: $score(d) = \sum \frac{1}{k + rank_d}$ con k=2 (default Qdrant)
- **MODEL_PRESETS** en la UI: GPT-5.2 Codex, GPT-5.2, Kimi K2.5, SS Expert (RAG)

---

## Recursos Azure activos

| Recurso | Nombre | Resource Group | Región |
|---------|--------|----------------|--------|
| Azure OpenAI (principal) | `javie-mku5l3k8-swedencentral` | ebook-reader | Sweden Central |
| Azure OpenAI (reader) | `openai-reader-javi` | ebook-reader | Sweden Central |
| Static Web App | `chatbot-rag-javi` | rg-chatbot-rag | West Europe |

### Recursos eliminados
| Recurso | Motivo |
|---------|--------|
| ~~Azure AI Search (`ai-search-javi`)~~ | Free tier insuficiente (50MB). Migrado a Qdrant Cloud (1GB free) |
