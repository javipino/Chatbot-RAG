# RAG Seguridad Social - Contexto de sesión

## Qué es este proyecto

Sistema RAG (Retrieval-Augmented Generation) para consultar normativa laboral y de Seguridad Social española. Se integra como preset "SS Expert (RAG)" en un chat UI existente desplegado en Azure Functions (`func-consultas-internas`).

**Fuente de datos:** PDF del BOE "Código Laboral y de la Seguridad Social" — 36MB, 2,753 páginas, 132 leyes.

---

## Credenciales y endpoints

### Azure OpenAI (principal - GPT-5.2)
- **Endpoint:** `javie-mku5l3k8-swedencentral.cognitiveservices.azure.com`
- **API Key:** Ver `.env` (variable `AZURE_OPENAI_KEY`)
- **Deployments:** `gpt-5.2`, `gpt-5.2-codex`

### Azure OpenAI (reader - embeddings + nano)
- **Endpoint:** `openai-reader-javi.cognitiveservices.azure.com`
- **API Key:** Ver `.env` (variable `AZURE_OPENAI_READER_KEY`)
- **Deployments:** `text-embedding-3-small` (1536 dims nativo, soporta `dimensions=256`), `gpt-5-nano`

### Kimi K2.5 (Azure AI)
- **Endpoint:** `openai-reader-javi.services.ai.azure.com`
- **Path:** `/openai/v1/chat/completions`
- **API Key:** misma que reader

### Azure AI Search
- **Endpoint:** `ai-search-javi.search.windows.net`
- **Admin Key:** Ver `.env` (variable `AZURE_SEARCH_KEY`)
- **Index:** `normativa`
- **Tier:** Free (límite 50MB storage)

### Azure Function App
- **URL:** `https://func-consultas-internas.azurewebsites.net`
- **Runtime:** Node.js
- **Function Key:** Ver `.env` (variable `AZURE_FUNCTION_KEY`)
- **Funciones desplegadas:** `app` (GET, anonymous), `api` (POST, anonymous), `rag` (POST, function auth)
- **Nota:** El chat UI se sirve en `/api/app`, no `/api/page`

### Servidor doméstico (no accesible ahora)
- **Host:** `javier@192.168.1.135` (Debian 12)
- **Proyecto:** `/mnt/media/rag-ss/` (symlink `~/rag-ss`)
- **PDF original:** `~/rag-ss/pdfs/normativa/CODIGO_Laboral_y_SS_BOE.pdf`

### Entorno de trabajo
- **PC:** Windows 10, PowerShell 5.1, sin derechos de admin
- **Proxy corporativo:** `proxy-tmp.seg-social.es:8080` (bloquea POST, SSL transparente)
- **Local:** `C:\Repos\Training\RAG\`

---

## Estructura de archivos local

```
C:\Repos\Training\RAG\
├── chunks\
│   ├── normativa_chunks_enriched.json  (17MB) ← ARCHIVO PRINCIPAL: 5,648 chunks enriquecidos con resumen, keywords, preguntas
│   ├── normativa_chunks_v2.json        (11MB) ← chunks con metadatos de capítulo, sin enriquecimiento LLM
│   └── upload_progress.json            (91KB) ← IDs ya subidos al índice (2,575 de 5,648)
├── logs\
│   ├── enrich.log                      ← log del enriquecimiento (completado: 5648/5648, 0 errores)
│   └── upload.log                      ← log del upload (parcial: 2,576 ok, 3,072 err por quota)
├── scripts\
│   ├── extract_chunks.py               ← extrae texto del PDF, segmenta por artículo (PyMuPDF)
│   ├── clean_chunks_v2.py              ← limpia headers/footers del BOE
│   ├── enhance_chunks.py               ← añade jerarquía capítulo/título/sección desde TOC del PDF
│   ├── enrich_chunks.py                ← enriquece con GPT-5 Nano (resumen, keywords, preguntas) - async 5 concurrent
│   ├── create_index.py                 ← crea índice Azure AI Search (9 campos + vector + semantic)
│   ├── upload_to_search.py             ← embede + sube chunks al índice - NECESITA ACTUALIZACIÓN (256 dims)
│   └── (varios test_*.py, analyze_*.py, check_*.py)
├── azure-function\
│   ├── host.json
│   ├── api\                            ← proxy genérico Azure OpenAI (acepta _apikey, _host, _path en body)
│   │   ├── function.json
│   │   └── index.js
│   ├── app\                            ← chat UI v6 con multi-modelo dropdown + preset SS Expert (RAG)
│   │   ├── function.json (GET, anonymous)
│   │   └── index.js (1074 líneas - HTML+CSS+JS inline)
│   └── rag\                            ← función RAG: embed query → search → context → GPT-5.2
│       ├── function.json (POST, function auth)
│       └── index.js (257 líneas)
└── SESSION-CONTEXT.md                  ← este archivo
```

---

## Estado del pipeline de datos

| Paso | Estado | Descripción |
|------|--------|-------------|
| 1. Extracción PDF | ✅ Completo | 5,649 chunks de 2,753 páginas, regex por artículo |
| 2. Limpieza headers | ✅ Completo | Eliminados "CÓDIGO LABORAL", números de página, footers BOE |
| 3. Metadatos capítulo | ✅ Completo | 91% match con TOC (TÍTULO > CAPÍTULO > SECCIÓN) |
| 4. Normalización texto | ✅ Completo | \n→espacios, § eliminado de títulos y preámbulos |
| 5. Enriquecimiento LLM | ✅ Completo | GPT-5 Nano: resumen, palabras_clave (keyphrases), preguntas. 5,648/5,648, 0 errores |
| 6. Índice AI Search | ⚠️ Necesita recrear | Creado con 1536 dims, hay que recrear con 256 dims (quota Free 50MB) |
| 7. Upload datos | ❌ Parcial | 2,576/5,648 subidos. Falló por quota a mitad. Hay que borrar todo y resubir con 256 dims |
| 8. Función RAG | ✅ Desplegada | En el portal, auth level function. Necesita actualizar embedding a 256 dims |
| 9. Chat UI preset | ✅ Desplegada | "SS Expert (RAG)" añadido. El function key de RAG aún tiene placeholder |

---

## PLAN INMEDIATO - Lo que falta por hacer

### 1. Recrear índice con vectores de 256 dimensiones
El Free tier de AI Search tiene 50MB. Con 1536 dims, los vectores solos ocupan ~37MB para 5,648 chunks. Con 256 dims: ~6MB.

**Cambios necesarios en `create_index.py`:**
- Campo `text_vector`: cambiar `dimensions` de 1536 a 256

**Cambios necesarios en `upload_to_search.py`:**
- Añadir `dimensions=256` en la llamada a `client.embeddings.create()`
- Cambiar las rutas de archivo para que funcionen en local (actualmente apuntan a `/home/javier/...`)

**Cambios necesarios en `rag/index.js`:**
- En la función `embedQuery()`: añadir `dimensions: 256` al body del request de embedding

**Ejecución:**
```bash
# 1. Borrar índice actual (desde Azure Portal o con script)
# 2. python scripts/create_index.py  (con 256 dims)
# 3. python scripts/upload_to_search.py  (con 256 dims, rutas locales)
```

### 2. Actualizar función RAG en portal
Después de cambiar `rag/index.js` para usar 256 dims, pegar el código actualizado en el portal.

### 3. Configurar function key en la UI
- Portal → func-consultas-internas → Funciones → rag → Function Keys → copiar default
- En `app/index.js`, reemplazar `PEGA_AQUI_EL_FUNCTION_KEY_DE_RAG` con el valor real
- Actualizar la función `app` en el portal con el nuevo código
- Alternativamente: añadir un campo de configuración en la UI para que el usuario ponga el key (como con las API keys de OpenAI/Kimi)

### 4. Test end-to-end
Seleccionar "SS Expert (RAG)" en el dropdown → preguntar algo como "¿Cuántos días de vacaciones tengo por ley?" → verificar que busca, contextualiza y responde con citas.

---

## Schema del índice `normativa`

```
id              Edm.String          key, filterable
law             Edm.String          searchable, filterable, facetable
chapter         Edm.String          searchable
section         Edm.String          searchable, filterable
text            Edm.String          searchable
resumen         Edm.String          searchable
palabras_clave  Collection(Edm.String)  searchable, filterable, facetable
preguntas       Edm.String          searchable
text_vector     Collection(Edm.Single)  1536 dims → CAMBIAR A 256, HNSW cosine
```

Semantic config: `default-semantic`
- titleField: `section`
- contentFields: `text`, `resumen`, `preguntas`
- keywordsFields: `palabras_clave`

---

## Estructura de un chunk enriquecido (normativa_chunks_enriched.json)

```json
{
  "law": "Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores.",
  "chapter": "TÍTULO I. De la relación individual de trabajo > CAPÍTULO II. Contenido del contrato de trabajo > Sección 5.ª Tiempo de trabajo",
  "section": "Artículo 38. Vacaciones anuales.",
  "text": "1. El período de vacaciones anuales retribuidas, no sustituible por compensación económica, será el pactado en convenio colectivo o contrato individual...",
  "resumen": "Regula las vacaciones anuales retribuidas de los trabajadores...",
  "palabras_clave": ["vacaciones anuales", "retribución", "convenio colectivo", ...],
  "preguntas": ["¿Cuántos días mínimos de vacaciones...", ...]
}
```

---

## Flujo de la función RAG (`rag/index.js`)

1. **Recibe** POST con `{ messages: [{role, content}, ...] }`
2. **Extrae** último mensaje del usuario como query
3. **Embede** query con `text-embedding-3-small` (endpoint reader)
4. **Busca** en Azure AI Search: hybrid (vector + keyword + semantic reranking), top 8
5. **Construye** contexto con los fragmentos recuperados
6. **Llama** a GPT-5.2 con system prompt de experto legal + contexto + historial
7. **Devuelve** `{ choices: [{message: {role, content}}], sources: [{law, section, chapter}] }`

Parámetros GPT: `temperature: 0.1`, `reasoning_effort: 'high'`, `stream: true` (pero se recolecta y devuelve completo porque Azure Functions v3 no soporta streaming real).

---

## Notas técnicas importantes

- **GPT-5 Nano** no soporta `temperature`, solo `max_completion_tokens` (usar 4096, con 2048 da respuestas vacías en chunks largos)
- **Proxy corporativo** bloquea POST — por eso se usa Azure Functions como proxy intermedio
- **PowerShell** se come el carácter `§` en here-strings → usar SCP para subir scripts al servidor
- **Semantic config API**: los campos se llaman `prioritizedContentFields` y `prioritizedKeywordsFields` (no `contentFields`/`keywordsFields`)
- **El chat UI** está en `/api/app` (no `/api/page` que da 404)
- **MODEL_PRESETS** en la UI: GPT-5.2 Codex, GPT-5.2, Kimi K2.5, SS Expert (RAG)
- **localStorage keys** usados por la UI: `azure-chat-key`, `azure-chat-key-kimi`, `azure-chat-model`, `azure-chat-systemprompt`, `azure-chat-history`, `azure-chat-current`
