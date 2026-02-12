# Plan: RAG de Seguridad Social con Azure (€50/mes)

**Objetivo:** Montar un chatbot experto en Seguridad Social española usando Azure AI Search Free (3 índices paralelos) + GPT-5.2, con pre-procesamiento de documentos en servidor local. Coste mensual ~$6-16 de €50 de crédito Azure.

---

## Paso 0 — Requisitos previos

1. **Cuenta Azure** con los €50/mes de crédito activos.
2. **Crear un Resource Group** en la región `West Europe` (Países Bajos) — la más cercana a España con todos los servicios disponibles.
3. **Crear los siguientes recursos** dentro del Resource Group:
   - Azure AI Search (tier Free)
   - Azure Storage Account (para Blob Storage — opcional, para PDFs originales)
4. **Recursos que ya tenemos** (no hay que crear):
   - Azure OpenAI Service → ya desplegado (`javie-mku5l3k8-swedencentral`)
   - Azure Function App → ya desplegado (`func-consultas-internas`), se añade una función `rag`
   - Frontend → ya existe la función `page` que sirve la UI del chat

---

## Paso 1 — Pre-procesamiento de documentos (en servidor local)

Este es el paso más importante para la calidad final. Se hace una sola vez (y después solo cuando se añada documentación nueva).

1. **Recopilar toda la documentación** en una carpeta local:
   - PDFs de normativa (LGSS, ET, LETA, reglamentos...)
   - Sentencias en PDF o Word
   - Circulares, criterios, tablas en cualquier formato

2. **Pipeline híbrido: Python (extracción) + LLM (enriquecimiento)**

   **Fase A — Extracción con Python** (determinista, gratis):
   - Extraer texto de los PDFs (con `pymupdf` o `pdfplumber`)
   - Trocear por unidades lógicas usando regex (artículo, sección, fundamento jurídico)
   - Los patrones legales están muy bien marcados: `Artículo \d+`, `Sección \d+ª`, `FUNDAMENTOS DE DERECHO`, `Primero.-`

   **Fase B — Enriquecimiento con GPT-5.2** (~$2 coste único):
   - Para cada chunk, llamar a GPT-5.2 pidiendo:
     - `tema` — clasificación temática ("jubilación contributiva", "IT por contingencias comunes"...)
     - `resumen` — una línea resumen del contenido
     - `palabras_clave` — 5-10 términos relevantes
     - `preguntas` — 3 preguntas que este chunk respondería
     - Limpieza de texto roto (tablas mal extraídas, saltos de página)
   - **Las preguntas generadas son el mayor boost de calidad**: cuando un usuario pregunte algo parecido, el embedding emparejará mucho mejor con el chunk correcto.

   **Salida — JSON por chunk:**
     ```json
     {
       "id": "lgss-art-205",
       "contenido": "Artículo 205. Concepto. 1. La prestación económica...",
       "ley": "LGSS RDL 8/2015",
       "articulo": "205",
       "capitulo": "Jubilación",
       "tema": "jubilación contributiva",
       "resumen": "Define el concepto de jubilación contributiva y sus requisitos generales",
       "palabras_clave": ["jubilación", "contributiva", "pensión", "edad", "cotización"],
       "preguntas": [
         "¿Qué es la jubilación contributiva?",
         "¿Cuáles son los requisitos para la jubilación?",
         "¿Qué artículo de la LGSS define la jubilación?"
       ],
       "fecha_vigencia": "2024-01-01",
       "tipo": "normativa"
     }
     ```
   - Generar 3 archivos JSON de salida (uno por índice): `normativa.json`, `jurisprudencia.json`, `resto.json`

3. **Validación manual**: revisar una muestra de chunks para confirmar que no hay artículos partidos, tablas rotas o contenido truncado. Verificar que los metadatos generados por el LLM son correctos.

**Herramientas para el script:**
- `pymupdf` / `pdfplumber` — extracción de texto de PDFs
- `python-docx` — extracción de Word
- `re` (regex) — detección de patrones de artículos
- `openai` SDK — para llamar a GPT-5.2 en la fase de enriquecimiento
- JSON estándar de Python para la salida

**Tiempo estimado:** 1-2 días para el script + revisión.

---

## Paso 2 — Configurar Azure OpenAI Service

1. **Desplegar dos modelos** en Azure AI Foundry:
   - `gpt-5.2` (deployment Global) — para generar respuestas
   - `text-embedding-3-small` — para vectorizar los chunks y las consultas

2. **Anotar:** endpoint, API key, y nombre de cada deployment.

---

## Paso 3 — Crear los 3 índices en Azure AI Search

1. **Crear el recurso Azure AI Search** tier Free en West Europe.

2. **Definir 3 índices** con esquemas distintos:

   **Índice `normativa`:**
   - `id` (clave), `contenido` (searchable), `ley`, `articulo`, `capitulo`, `tema`, `fecha_vigencia`, `vector` (Collection Edm.Single, 1536 dimensiones)

   **Índice `jurisprudencia`:**
   - `id` (clave), `contenido` (searchable), `tribunal`, `sala`, `numero_sentencia`, `fecha`, `materia`, `fundamento`, `vector` (1536 dim)

   **Índice `resto`:**
   - `id` (clave), `contenido` (searchable), `tipo_documento`, `numero`, `fecha`, `organismo`, `asunto`, `vector` (1536 dim)

3. **Configurar la búsqueda híbrida** en cada índice: los campos de texto como `searchable` (para keyword search) y el campo `vector` como campo vectorial (para búsqueda semántica).

---

## Paso 4 — Indexar los documentos

1. **Escribir un script Python** que:
   - Lea cada JSON de chunks generado en el Paso 1.
   - Para cada chunk, llame a la API de embeddings (`text-embedding-3-small`) para generar el vector.
   - Suba el chunk + vector al índice correspondiente de AI Search vía REST API o SDK de Python (`azure-search-documents`).

2. **(Opcional)** Subir los documentos originales (PDFs) a un contenedor de Azure Blob Storage para referencia.

3. **Verificar** la indexación: hacer una búsqueda de prueba en cada índice desde el portal de Azure.

**Tiempo estimado:** unas horas (el script + ejecución).

---

## Paso 5 — Construir la función RAG (en el Function App existente)

1. **Añadir una nueva función `rag`** al Function App existente (`func-consultas-internas`), en Node.js como las otras funciones (`page`, `chat`).

2. **La función hace esto al recibir una pregunta:**

   - **a)** Generar el embedding de la pregunta (llamar a `text-embedding-3-small`).
   - **b)** Lanzar **3 búsquedas híbridas en paralelo** (una por índice), pidiendo top-K resultados de cada una (K configurable, sugerido 5-8).
   - **c)** Fusionar los resultados de los 3 índices y ordenar por score de relevancia.
   - **d)** Seleccionar los mejores N chunks totales (sugerido 8-15).
   - **e)** Construir el prompt:
     - **System prompt:** instrucciones al modelo (rol de experto, citar fuentes, no inventar...).
     - **Contexto:** los chunks seleccionados, cada uno con su fuente (ley+artículo o sentencia+número).
     - **Pregunta del usuario.**
   - **f)** Llamar a GPT-5.2 con el prompt completo.
   - **g)** Devolver la respuesta + las fuentes citadas.

3. **System prompt sugerido:**
   ```
   Eres un experto en Seguridad Social española. Responde basándote 
   EXCLUSIVAMENTE en la documentación proporcionada. Cita siempre la 
   fuente exacta (ley y artículo, o número de sentencia). Si la 
   información disponible no es suficiente para responder con certeza, 
   indícalo claramente. No inventes ni supongas información que no 
   esté en los documentos proporcionados.
   ```

4. **Parámetros configurables** (como variables de entorno):
   - `TOP_K_PER_INDEX` = 5 (chunks por índice)
   - `MAX_CHUNKS_TOTAL` = 12 (chunks máximos al modelo)
   - `MODEL_DEPLOYMENT` = "gpt-5.2"
   - `TEMPERATURE` = 0.1 (baja, para máxima precisión)

---

## Paso 6 — Integrar en el frontend existente

1. **Añadir un nuevo preset** en `MODEL_PRESETS` del `page/index.js`:
   ```javascript
   {
       id: "ss-expert",
       name: "SS Expert (RAG)",
       provider: "internal",
       format: "rag",
       host: "",  // no necesita — es misma Function App
       path: "/api/rag"  // llama directamente a la función rag
   }
   ```
2. **Adaptar `callAPI()`** para el formato `rag` — envía la pregunta directamente sin pasar por el proxy `chat`, ya que la función `rag` se encarga de todo (embedding + búsqueda + GPT).
3. **Adaptar `extractText()`** para parsear la respuesta del RAG (texto + fuentes citadas).
4. **Mostrar fuentes citadas** debajo de la respuesta del asistente (ley+artículo o número de sentencia).

---

## Paso 7 — Testing y ajuste

1. **Preparar 20-30 preguntas de test** con respuestas correctas conocidas:
   - Preguntas simples: "¿Cuál es la base mínima de cotización del Régimen General 2026?"
   - Preguntas de interpretación: "¿Una empleada del hogar en dos casas es pluriempleo o pluriactividad?"
   - Preguntas que cruzan normativas: "¿Cómo se calcula la base reguladora de IT de un trabajador a tiempo parcial?"

2. **Evaluar:**
   - ¿Recupera los chunks correctos? (problema de retrieval → ajustar chunking o top-K)
   - ¿La respuesta es correcta? (problema del modelo → ajustar prompt o subir temperatura)
   - ¿Cita las fuentes bien? (problema del prompt → refinar instrucciones)

3. **Iterar** sobre chunking, metadatos, top-K y prompt hasta alcanzar la calidad deseada.

---

## Verificación

| Check | Cómo verificar |
|---|---|
| Índices creados correctamente | Portal Azure → AI Search → ver 3 índices con documentos |
| Búsqueda funciona | Hacer query de prueba en el portal, verificar resultados relevantes |
| Embeddings correctos | Buscar "jubilación" y ver que devuelve artículos sobre jubilación |
| Búsqueda híbrida activa | Buscar tanto por término exacto ("art. 205") como por significado ("retiro laboral") |
| GPT-5.2 responde con contexto | Verificar que cita artículos reales, no inventa |
| Coste dentro de presupuesto | Azure Cost Management → verificar <€50/mes |

---

## Orden de implementación

| # | Paso | Qué hacer | Dónde |
|---|---|---|---|
| 1 | **Verificar Python** | `python --version` | Servidor local |
| 2 | **Crear AI Search Free** | Recurso en West Europe | Portal Azure |
| 3 | **Desplegar embedding model** | `text-embedding-3-small` | Azure AI Foundry |
| 4 | **Recopilar PDFs** | Juntar normativa en una carpeta | Servidor local |
| 5 | **Script de extracción** | Python: PDF → chunks crudos | Servidor local |
| 6 | **Script de enriquecimiento** | GPT-5.2: chunks → metadatos + preguntas | Servidor local |
| 7 | **Crear índices** | 3 índices con esquema en AI Search | Portal Azure / script |
| 8 | **Script de indexación** | Embeddings + upload a AI Search | Servidor local |
| 9 | **Función `rag`** | Backend RAG en Node.js | Function App |
| 10 | **Preset en frontend** | Añadir "SS Expert" al dropdown | `page/index.js` |
| 11 | **Testing** | 20-30 preguntas de prueba | Manual |
| 12 | **Despliegue** | Subir funciones al portal | Portal Azure |

---

## Decisiones tomadas

- **AI Search Free** (3 índices, $0) en vez de Basic ($74/mes) — cabe toda la documentación core (50MB, 10K docs por índice)
- **GPT-5.2** como modelo principal — presupuesto lo permite, mejor calidad de razonamiento
- **Pre-procesamiento híbrido** — Python para extraer/trocear + GPT-5.2 para enriquecer metadatos y generar preguntas (~$2 coste único)
- **Reutilizar infraestructura existente** — mismo Function App (`func-consultas-internas`), misma UI (`page`), solo se añade función `rag` + preset
- **No Static Web App** — ya tenemos la función `page` sirviendo la UI del chat
- **La función `rag` es independiente** del proxy `chat` — es un backend completo (embedding → búsqueda → prompt → GPT)
- **Top-K configurable** (5-8 por índice) — ajustable según resultados de testing

---

## Arquitectura

```
Frontend (page/index.js - ya existente)
        │
        │  preset "SS Expert (RAG)"
        │  POST /api/rag
        ▼
┌─────────────────────────────────────────────────┐
│  Función RAG (rag/index.js) - NUEVA             │
│  func-consultas-internas.azurewebsites.net      │
│                                                 │
│  1. Recibe pregunta                             │
│  2. Genera embedding (text-embedding-3-small)   │
│  3. 3 búsquedas híbridas en paralelo:           │
│     ┌──────────┬──────────┬──────────┐          │
│     │NORMATIVA │JURISPRUD.│  RESTO   │          │
│     │ • LGSS   │ • TS     │ • Circ.  │          │
│     │ • ET     │ • TSJ    │ • Tablas │          │
│     │ • LETA   │ • Doctr. │ • Guías  │          │
│     └────┬─────┴────┬─────┴────┬─────┘          │
│          └──────────┼──────────┘                │
│  4. Fusionar + re-rankear (top N)               │
│  5. Construir prompt (system + chunks + query)  │
│  6. Llamar a GPT-5.2                            │
│  7. Devolver respuesta + fuentes                │
└─────────────────────────────────────────────────┘

Funciones existentes (sin cambios):
  • page/index.js  → sirve la UI (GET)
  • chat/index.js  → proxy genérico a Azure OpenAI / Kimi (POST)
```

## Coste estimado

**Coste ÚNICO (pre-procesamiento):**

| Componente | Coste |
|---|---|
| GPT-5.2 enriquecimiento de ~500 chunks | ~$2 |
| Embeddings iniciales de ~500 chunks | ~$0.10 |
| **Total único** | **~$2** |

**Coste MENSUAL (uso):**

| Componente | Coste |
|---|---|
| Azure AI Search Free (3 índices) | $0 |
| Azure Blob Storage (opcional) | ~$0.50 |
| Embeddings de consultas (~30/día) | ~$0.50 |
| GPT-5.2 RAG (~30 consultas/día) | ~$5-15 |
| Azure Functions (Consumption) — ya existente | $0 |
| Frontend — ya existente (`page`) | $0 |
| **Total mensual** | **~$6-16/mes** |
