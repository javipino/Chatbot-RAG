# Agent Mode — Arquitectura, Tools y Flujo

> **Implementación:** `server-dotnet/ChatbotRag.Api/Agent/` + `Endpoints/RagAgentEndpoints.cs`
> **Endpoint:** `POST /api/rag-agent` (SSE streaming)
> **Preset frontend:** `ss-expert-agent`
> **Tecnología:** Azure AI Foundry · Azure.AI.Agents.Persistent 1.1.0 · GPT-5.2

---

## Diferencias con el Pipeline RAG

| Aspecto | Pipeline (`/api/rag-pipeline`) | Agent (`/api/rag-agent`) |
|---------|-------------------------------|--------------------------|
| Búsqueda | Siempre: 1 ronda fija de expand→embed→search | Dinámica: el modelo decide qué buscar y cuántas veces |
| Contexto conversacional | Carryover manual de chunk IDs (`previousChunkIds`) | Thread persistente en Foundry (el modelo recuerda todo) |
| Control del flujo | Determinista (4 etapas predefinidas) | Agentico (el modelo razona qué herramienta llama y cuándo) |
| Request | `{ messages, previousChunkIds }` | `{ message, threadId? }` |
| Response (SSE `done`) | `{ contextChunkIds, sources }` | `{ threadId, sources }` |
| Complejidad | Baja latencia, predecible | Mayor latencia (múltiples rondas), más flexible |
| Requiere Foundry | No | Sí (`AZURE_AI_PROJECT_ENDPOINT` + Managed Identity) |

---

## Flujo de ejecución

```
POST /api/rag-agent { message, threadId? }
        │
        ├─ Auth (x-api-key)
        │
        ├─ AgentManager.GetAgentIdAsync()
        │     └─ CreateAgentAsync() si no existe aún (singleton, create-once)
        │
        ├─ Thread management
        │     ├─ threadId presente → GetThreadAsync() (retoma conversación)
        │     └─ threadId ausente  → CreateThreadAsync() (nueva conversación)
        │
        ├─ Messages.CreateMessageAsync(thread.Id, User, message)
        │
        ├─ Runs.CreateRunStreamingAsync(thread.Id, agentId)
        │
        │   ┌─ loop: await foreach update in stream ─────────────────────────┐
        │   │                                                                 │
        │   │  RunCreated      → log run.Id                                  │
        │   │                                                                 │
        │   │  RequiredActionUpdate  → el modelo quiere llamar una tool       │
        │   │    ├─ SSE: event: tool_status  { tool, args }                  │
        │   │    ├─ ToolExecutor.ExecuteAsync(actionUpdate)                  │
        │   │    │     └─ search_normativa / search_sentencias /             │
        │   │    │        get_article / get_related_chunks                   │
        │   │    ├─ CollectSources(result JSON)                              │
        │   │    └─ Runs.SubmitToolOutputsToStreamAsync(run, [ToolOutput])   │
        │   │         └─ stream = nuevo stream con la respuesta              │
        │   │                                                                 │
        │   │  MessageContentUpdate → token de respuesta del modelo          │
        │   │    └─ SSE: event: token  { text }                              │
        │   │                                                                 │
        │   │  RunFailed        → SSE: event: error, return                  │
        │   │                                                                 │
        │   └─────────────────────────────────────────────────────────────────┘
        │
        └─ SSE: event: done  { threadId, sources[] }
```

### Request / Response

**Request body:**
```json
{
  "message": "¿Cuántos días de baja por paternidad tenemos en 2025?",
  "threadId": "thread_abc123"   // opcional – omitir para nueva conversación
}
```

**SSE events emitidos:**
```
event: tool_status
data: {"tool":"search_normativa","args":{"query":"permiso nacimiento hijo días 2025"}}

event: tool_status
data: {"tool":"get_article","args":{"article_number":"48","law_name":"Estatuto de los Trabajadores"}}

event: token
data: {"text":"Desde el 1 de enero de 2021, "}

event: token
data: {"text":"el permiso por nacimiento..."}

event: done
data: {"threadId":"thread_abc123","sources":[{"id":1234,"law":"Estatuto de los Trabajadores","section":"Art. 48","chapter":"...","collection":"normativa"}]}
```

---

## Agent system prompt

El agente se crea con `CreateAgentAsync()` y recibe las instrucciones en el campo `instructions`. Son la combinación de **AppConfig.SystemPrompt** (experto en SS español) más las instrucciones de uso de tools:

```
<AppConfig.SystemPrompt>
(Eres un experto en legislación laboral y de Seguridad Social española.
Te proporcionamos fragmentos de normativa como contexto. Úsalos como base
principal, pero puedes razonar, conectar ideas entre fragmentos, y aplicar
lógica jurídica para dar respuestas completas y útiles.

Cita la ley y artículo cuando lo uses. [...]
Comprueba que toda la respuesta es coherente entre sí y con los fragmentos
antes de concluir. [...]
)

## Instrucciones para el uso de tools

Tienes acceso a una base de datos de normativa laboral y de Seguridad Social española.
Debes usar las tools para buscar información ANTES de responder.

### Estrategia de búsqueda
1. Usa search_normativa para buscar por palabras clave concisas (3-6 palabras técnico-legales).
2. Si la pregunta involucra múltiples conceptos, haz varias búsquedas, una por concepto.
3. Si conoces el artículo exacto, usa get_article para obtenerlo directamente.
4. Si un chunk tiene referencias relevantes, usa get_related_chunks para expandirlas.
5. Si los resultados son insuficientes, reformula con sinónimos o términos más específicos.

### Cuándo re-buscar
- Si los fragmentos obtenidos no responden completamente la pregunta, busca más.
- Máximo 6 rondas de tool calls por pregunta.

### Equivalencias coloquiales → términos legales
- "baja de maternidad" → "suspensión contrato nacimiento cuidado menor"
- "despido"            → "extinción contrato"
- "paro"              → "prestación desempleo"
- "baja médica"       → "incapacidad temporal"
- "pensión"           → "jubilación prestación contributiva"
- "finiquito"         → "liquidación haberes extinción contrato"
```

---

## Tools disponibles

### `search_normativa`
**Propósito:** Búsqueda híbrida (semántica + TF-IDF) sobre la colección `normativa` y las demás colecciones del Qdrant (cross-collection). Es la herramienta principal para encontrar artículos relevantes.

**Parámetros:**
| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `query` | string | ✅ | Palabras clave técnico-legales (3-6 términos) |
| `top_k` | integer | ❌ | Nº de resultados (default 8, max 15) |

**Implementación:** `embed(query)` → `buildSparseVector(query)` → `SearchAllCollectionsAsync()` (todas las colecciones, ponderadas)

**Resultado:** JSON array de `ChunkToolResult`:
```json
[
  {
    "id": 1234,
    "law": "Estatuto de los Trabajadores",
    "section": "Artículo 48. Suspensión con reserva de puesto de trabajo",
    "chapter": "Capítulo III. Suspensión del contrato",
    "resumen": "...",
    "text": "...",
    "score": 0.87,
    "collection": "normativa"
  }
]
```

---

### `search_sentencias`
**Propósito:** Búsqueda en la colección `sentencias` (jurisprudencia Tribunal Supremo). Útil para precedentes judiciales o interpretaciones de tribunales.

**Parámetros:**
| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `query` | string | ✅ | Palabras clave de búsqueda jurisprudencial |
| `top_k` | integer | ❌ | Nº de resultados (default 5, max 10) |

**Implementación:** `embed(query)` → `buildSparseVector(query)` → `SearchCollectionAsync("sentencias", ...)`

> ⚠️ La colección `sentencias` está pendiente de poblar. Devuelve 0 resultados hasta que se suba jurisprudencia.

---

### `get_article`
**Propósito:** Recuperar un artículo concreto por número de artículo y nombre de ley, sin necesidad de búsqueda semántica. Útil cuando el modelo ya sabe qué artículo necesita.

**Parámetros:**
| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `article_number` | string | ✅ | Nº de artículo. Ej: `"48"`, `"205.1"` |
| `law_name` | string | ✅ | Nombre de la ley. Ej: `"Estatuto de los Trabajadores"`, `"LGSS"` |

**Implementación:** `FetchByArticleFilterAsync()` en `QdrantService` — filtra por metadata `article_number` + `law_name` en Qdrant, con fallback a búsqueda semántica si el filtro no encuentra resultados.

---

### `get_related_chunks`
**Propósito:** Obtener los chunks referenciados por un chunk dado (artículos citados, disposiciones relacionadas). Sigue las referencias pre-computadas en el campo `refs[]` del chunk.

**Parámetros:**
| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `chunk_id` | string \| integer | ✅ | ID del chunk del que obtener referencias |

**Implementación:** `FetchChunksByIdsAsync([chunkId])` → leer `refs[]` del chunk → `FetchChunksByIdsAsync(refs.Take(5))`

---

## Gestión de threads (conversación)

El agente usa **threads persistentes** de Azure AI Foundry. Cada thread mantiene el historial completo de la conversación en el servidor de Foundry — no es necesario enviar mensajes anteriores desde el cliente.

```
Primera pregunta:               { message: "¿Cuántos días de vacaciones?" }
  → response done: { threadId: "thread_abc" }

Segunda pregunta (continuación): { message: "¿Y si soy autónomo?", threadId: "thread_abc" }
  → el agente recuerda la pregunta anterior sin que el cliente la reenvíe
```

El `threadId` se devuelve en el evento `done` y el frontend lo almacena en `chat.threadId` para reutilizarlo en el siguiente turno.

---

## Gestión del agente (singleton)

`AgentManager` se registra como **singleton** en DI (`AddSingleton<AgentManager>()`). El agente se crea una sola vez en el primer request y se reutiliza en todas las peticiones posteriores.

El agente se registra bajo el nombre `"ss-expert"` en Azure AI Foundry con el modelo `gpt-5.2`. Si la app se reinicia, se crea un nuevo agente (el anterior queda huérfano en Foundry hasta limpieza manual).

**Auth:** `DefaultAzureCredential` (Azure.Identity). En producción el App Service necesita:
1. **System-Assigned Managed Identity** habilitada en el App Service
2. Rol **Azure AI Developer** asignado a esa identidad en el proyecto Foundry `javie-mku5l3k8-swedencentral_project`

En desarrollo local usa la credencial de `az login` automáticamente.

---

## SSE Protocol (desde el cliente)

El frontend usa `api.js → callStreaming()` para consumir el stream. Los eventos son:

| Evento SSE | Payload | Acción en UI |
|------------|---------|--------------|
| `tool_status` | `{ tool, args }` | Muestra pill de actividad (ej. "Buscando normativa...") |
| `token` | `{ text }` | Appends al mensaje en curso |
| `done` | `{ threadId, sources[] }` | Oculta pills, marca mensaje como completo, guarda `threadId` |
| `error` | `{ message }` | Muestra mensaje de error |

---

## Archivos clave

| Archivo | Responsabilidad |
|---------|----------------|
| `Agent/AgentManager.cs` | Lifecycle del agente: crear, reutilizar, threads |
| `Agent/ToolDefinitions.cs` | Definiciones de las 4 function tools (esquemas JSON) |
| `Agent/ToolExecutor.cs` | Ejecuta las tool calls: llama a OpenAI/Qdrant/TfIdf |
| `Endpoints/RagAgentEndpoints.cs` | Orquesta el streaming run, SSE, thread management |
| `Endpoints/SseHelper.cs` | Escritura de eventos SSE al response |
| `Models/ApiModels.cs` | `RagAgentRequest` (`message`, `threadId?`) |

---

## Limitaciones conocidas

- **`search_sentencias` y `search_criterios_inss`:** Las colecciones `sentencias` y `criterios_inss` están pendientes de datos. Las búsquedas devuelven vacío hasta que se suban documentos con `upload_to_qdrant.js`.
- **Managed Identity en producción:** Sin la MSI configurada, el agente falla con `AuthenticationFailedException` al arrancar. El pipeline RAG no se ve afectado.
- **Latencia:** Cada ronda de tool calls añade ~1-3s. Preguntas complejas pueden requerir 3-4 rondas → 5-10s antes del primer token.
- **Huérfanos en Foundry:** Si la app se reinicia sin que `DisposeAsync()` se ejecute (force-stop), el agente anterior queda registrado en Foundry. Limpiar manualmente desde Azure AI Studio si es necesario.
