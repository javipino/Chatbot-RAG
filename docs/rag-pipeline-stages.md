# Pipeline RAG — Etapas, Modelos y Prompts

> **Código fuente:** `server/pipeline/` (expand.js, search.js, enrich.js, answer.js)
> **Orquestación:** `server/routes/rag.js`
> **Servicios:** `server/services/` (openai.js, qdrant.js, tfidf.js, http.js)

## Resumen del flujo

```
Query del usuario
  │
  ├─ Stage 1: Query Decomposition ─────── GPT-5 Nano (Reader)
  │     Output: 1-4 queries de keywords
  │
  ├─ [Carryover] fetch chunks previos ─── Qdrant (por IDs)
  │
  ├─ Para CADA query (en paralelo):
  │   ├─ Stage 2: Embedding ────────────── text-embedding-3-small (Reader)
  │   ├─ Stage 3: Sparse Vector ────────── TF-IDF/BM25 (local)
  │   └─ Stage 4: Hybrid Search ────────── Qdrant Cloud (dense + sparse, RRF)
  │         └─ 4b: Cross-collection ────── 3 colecciones en paralelo
  │
  ├─ Merge carryover + search results + dedup
  │
  ├─ Stage 5b: Reference Expansion ────── Qdrant (fetch por ID, filtrado direccional)
  │     └─ Refs heredan score del padre × 0.8, global cap 15 refs
  │
  ├─ Scoring & Cap ────────────────────── Normaliza scores, ordena, toma top 25
  │     ├─ Search results: weightedScore original
  │     ├─ Carryover: score fijo 0.5
  │     └─ Refs: score heredado del padre × 0.8
  │
  └─ Stage 5: Unified Answer + Eval ───── GPT-5.2 (Principal)
        ├─ Responde la pregunta
        ├─ Reporta USED + DROP indices
        └─ [NEED] → fetch artículos faltantes → retry una vez
```

---

## Modelos y Endpoints

| Modelo | Deployment | Endpoint | TPM | Rol |
|--------|-----------|----------|-----|-----|
| **GPT-5 Nano** | `gpt-5-nano` | Reader (`openai-reader-javi`) | 100K | Expansión de queries |
| **text-embedding-3-small** | `text-embedding-3-small` | Reader | 150K | Embeddings (1536 dims) |
| **GPT-5.2** | `gpt-5.2` | Principal (`javie-mku5l3k8-swedencentral`) | 50K | Respuesta + evaluación |

---

## Stage 1 — Query Decomposition (GPT-5 Nano)

**Objetivo:** Generar 1-4 búsquedas cortas de palabras clave (3-6 términos) para encontrar normativa relevante. Para preguntas de continuación con contexto previo (carryover), solo genera búsquedas para los conceptos **nuevos**.

**Modelo:** `gpt-5-nano` (Reader endpoint)
**Output:** JSON array de strings (1-4 queries de keywords)

### Ejemplo

| Pregunta | Queries generadas |
|----------|------------------|
| "¿Cuántos días de vacaciones tengo?" | 1 query: `"vacaciones anuales retribuidas días disfrute"` |
| "¿Qué diferencia hay entre despido objetivo y disciplinario?" | 2 queries: `"despido objetivo causas indemnización"`, `"despido disciplinario causas procedimiento"` |
| "¿Y si no me las dan?" (follow-up con carryover) | 1 query: `"sanción incumplimiento empresario vacaciones reclamación"` o `[]` si no hay conceptos nuevos |

### System Prompt (primera pregunta)

```
Eres un asistente legal. Tu tarea es generar las PALABRAS CLAVE de búsqueda
necesarias para encontrar normativa relevante en una base de datos de legislación
laboral y de Seguridad Social española.

RESPONDE SOLO con un JSON array de strings. Cada string es una búsqueda de 3-6
palabras clave.

Reglas:
- Cada query debe ser CORTA: solo 3-6 palabras clave relevantes. NO escribas frases
  completas.
- NO incluyas números de artículo (ej: "artículo 48", "art. 250"). La búsqueda
  semántica no los necesita.
- Incluye el término técnico-legal Y el coloquial si son distintos.
- Si la pregunta es SIMPLE (un solo concepto), devuelve UN array con una sola query.
- Si es COMPLEJA (compara o involucra varios conceptos), devuelve VARIAS queries
  (una por concepto).
- Equivalencias coloquiales a términos legales:
  * "baja de maternidad" → "suspensión contrato nacimiento cuidado menor"
  * "despido" → "extinción contrato despido"
  * "paro" → "prestación desempleo"
  * "baja médica" → "incapacidad temporal prestación"
  * "pensión" → "jubilación prestación contributiva"
  * "finiquito" → "liquidación haberes extinción contrato"
- Máximo 4 queries. Agrupa conceptos cercanos si son más.

RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.
```

### System Prompt (follow-up con carryover)

```
Eres un asistente legal. El usuario hace una pregunta de CONTINUACIÓN sobre la
conversación previa. Ya tenemos el contexto normativo de la pregunta anterior
(se inyectará automáticamente).
Tu tarea es generar SOLO las búsquedas ADICIONALES necesarias para los conceptos
NUEVOS que aparecen en esta pregunta de continuación.

RESPONDE SOLO con un JSON array de strings (3-6 palabras clave cada una).
- Si la pregunta no introduce conceptos nuevos (ej: "¿puedes explicarlo mejor?"),
  devuelve un array vacío: []
- Si introduce conceptos nuevos, genera queries SOLO para esos conceptos nuevos.
- NO repitas búsquedas de conceptos que ya se trataron en la conversación anterior.
- Máximo 3 queries nuevas.

RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.
```

### Mensajes enviados

Primera pregunta: solo `[system, user]`.
Follow-up con carryover: `[system, ...últimos 4 mensajes truncados a 200 chars, user]`.

### Context Carryover

Cuando el frontend envía `previousChunkIds` (IDs de chunks usados en la respuesta anterior), el backend:
1. Los fetchea de Qdrant y los inyecta como contexto previo antes de S5b
2. S1 usa el prompt de follow-up que solo busca conceptos **nuevos**
3. Si S1 devuelve `[]`, se salta S2-S4 y se usa solo el contexto previo

**Output:** `["query1", "query2"]` (0-4 strings) — puede ser vacío en follow-ups
**Fallback:** Si el modelo no devuelve JSON válido, se usa el texto como query única.
**Parámetros:** Sin `temperature` (Nano no lo soporta). Sin `max_completion_tokens`.

---

## Stages 2-4 — Se ejecutan POR CADA query del Stage 1 (en paralelo)

Si Stage 1 devuelve N queries, los Stages 2-4 se ejecutan N veces en paralelo.
Los resultados se deduplican por ID (manteniendo el score más alto) y se toman los **top 30**.

---

## Stage 2 — Embedding (text-embedding-3-small)

**Objetivo:** Convertir cada query en un vector denso de 1536 dimensiones para búsqueda semántica.

**Modelo:** `text-embedding-3-small` (Reader endpoint)

### Request

```json
{
  "input": "<query expandida>"
}
```

**No hay prompt.** Se envía directamente el texto de la query.

---

## Stage 3 — Sparse Vector (TF-IDF / BM25 local)

**Objetivo:** Generar un vector disperso para búsqueda por palabras exactas (complementa la búsqueda semántica).

**No usa modelo.** Proceso local:
1. Tokenización: lowercase, normalización de acentos, eliminación de stopwords españolas
2. Stemming: sufijos españoles (amiento, aciones, mente, ción, etc.)
3. Cálculo BM25: `TF * IDF` usando vocabulario pre-computado (`tfidf_vocabulary.json`)
4. Output: `{ indices: [int], values: [float] }` — sparse vector para Qdrant

---

## Stage 4 — Hybrid Search (Qdrant Cloud)

**Objetivo:** Buscar fragmentos relevantes combinando búsqueda semántica (dense) y por palabras (sparse) con fusión RRF.

**No usa modelo.** Query a Qdrant:

### Request a cada colección

```json
{
  "limit": 10,
  "with_payload": true,
  "prefetch": [
    { "query": "<dense vector 1536d>", "using": "text-dense", "limit": 20 },
    { "query": { "indices": [...], "values": [...] }, "using": "text-sparse", "limit": 20 }
  ],
  "query": { "fusion": "rrf" }
}
```

### 4b — Cross-collection

Se busca en 3 colecciones en paralelo con pesos:

| Colección | Peso |
|-----------|------|
| `normativa` | 1.0 |
| `sentencias` | 0.8 |
| `criterios_inss` | 0.9 |

Los resultados se mezclan por `score × weight` y se toman los **top 20**.

---

## Stage 5b — Reference Expansion (Pre-computada, filtrada)

**Objetivo:** Traer chunks referenciados por los resultados de búsqueda, pero solo los que aporten valor real. Filtra para evitar inyectar ruido.

**No usa modelo.** Cada chunk tiene un campo `refs: [int]` con IDs de otros chunks que referencia (pre-computado offline por `add_refs.js`). Se hace fetch por ID a Qdrant y se aplican filtros.

### Reglas de filtrado

1. **Dirección ascendente:** Solo se siguen refs que apuntan a leyes de **igual o mayor rango** normativo. Un reglamento puede referenciar la LGSS o el ET, pero no al revés.

   | Rango | Ejemplos |
   |-------|----------|
   | 1 (Constitucional) | Constitución, LO Libertad Sindical |
   | 2 (Leyes/Estatutos) | ET, LGSS, LETA, LISOS, LRJS, LPRL |
   | 3 (Reglamentos Generales) | Reglamento de Cotización, Reglamento de Inscripción |
   | 4 (Reales Decretos) | RD Hogar, RD Maternidad |
   | 5 (Otros) | Órdenes, convenios |

   → Un chunk de rango 3 solo puede traer refs de rango 1, 2 o 3.

2. **Siblings siempre:** Si un artículo tiene varias partes (ej: Art. 308 parte 1, parte 2, parte 3), los siblings del **mismo artículo** siempre se incluyen, independientemente del rango.

3. **Cap por chunk:** Máximo 3 refs por chunk fuente.

4. **Score heredado:** Cada ref hereda `parentScore × 0.8` (REF_SCORE_FACTOR). Si un ref es referenciado por múltiples padres, toma el score más alto.

5. **Cap global:** Máximo 15 refs totales (MAX_TOTAL_REFS). Se ordenan por score heredado desc y se cortan las de menor score.

### Cap de chunks totales al modelo (MAX_CHUNKS_TO_MODEL = 25)

Después de S5b, todos los chunks (carryover + search + refs) se puntúan con `_score` normalizado:
- **Search results:** su `weightedScore` original (0-1)
- **Carryover:** score fijo 0.5 (fueron USED en el turno anterior)
- **Refs:** score heredado del padre × 0.8

Se ordenan por `_score` descendente y se toman los **top 25**. En retry NEED se permite hasta 30 (25+5).

---

## Stage 5 — Unified Answer + Evaluation (GPT-5.2)

**Objetivo:** Responder la pregunta del usuario Y evaluar qué fragmentos fueron útiles/inútiles en una sola llamada. Esto reemplaza las anteriores S5 (Rerank), S5c (Evaluación) y S6 (Respuesta), reduciendo de 3 llamadas LLM a 1.

**Modelo:** `gpt-5.2` (Principal endpoint)

### System Prompt

```
Eres un experto en legislación laboral y de Seguridad Social española.
Te proporcionamos fragmentos de normativa como contexto. Úsalos como base principal,
pero puedes razonar, conectar ideas entre fragmentos, y aplicar lógica jurídica
para dar respuestas completas y útiles.

Cita la ley y artículo cuando lo uses. Si algo no está cubierto por los fragmentos,
pide más información en NEED.
Responde en español, de forma clara y estructurada. Tono profesional pero cercano.

Si hay contradicción entre fuentes, prevalece la de mayor rango (Ley > Reglamento > Orden).
Las normas de rango inferior solo pueden mejorar los derechos del trabajador, nunca empeorarlos.
En caso de duda, aplica la interpretación más favorable al trabajador.
```

### Answer Wrapper (instrucciones de formato)

```
INSTRUCCIONES DE FORMATO DE RESPUESTA:

Responde a la pregunta del usuario usando los fragmentos de normativa proporcionados.

Tu respuesta DEBE tener EXACTAMENTE estas dos secciones, separadas por el delimitador:

1. Primero tu respuesta completa al usuario.

===META===

2. Después del delimitador, metadata en formato estructurado:

USED|índices de los fragmentos que has USADO (separados por comas)
DROP|índices de fragmentos que NO aportan nada (separados por comas)
NEED|... (solo si FALTA información CRÍTICA, máximo 2 líneas)

Formatos de NEED (elige el apropiado):
- Si sabes el artículo exacto: NEED|número_artículo|nombre_ley (la ley es OBLIGATORIA)
- Si necesitas información pero no sabes el artículo: NEED|palabras clave de búsqueda

Reglas para META:
- USED y DROP son OBLIGATORIOS. Si todos fueron útiles, pon DROP|ninguno
- NEED es OPCIONAL. Solo si realmente falta algo imprescindible.
```

### Mensajes enviados

```json
[
  { "role": "system", "content": "<system prompt>" },
  { "role": "system", "content": "CONTEXTO DE NORMATIVA:\n\n<contexto numerado>" },
  { "role": "system", "content": "<answer wrapper>" },
  // Últimos 6 mensajes del historial
  { "role": "user",      "content": "..." },
  { "role": "assistant", "content": "..." },
  { "role": "user",      "content": "<pregunta actual>" }
]
```

### Formato del contexto inyectado

```
[0] Estatuto de los Trabajadores > Artículo 38. Vacaciones anuales
Capítulo: Capítulo II — Contenido del contrato de trabajo
Resumen: Regulación del derecho a vacaciones...
Texto: <contenido completo del chunk>

---

[1] LGSS > Artículo 170. Prestación por nacimiento
...
```

### Parseo de respuesta

El backend separa por `===META===`:
- **Antes:** texto de respuesta para el usuario
- **Después:** líneas USED, DROP, NEED

### Lógica NEED (retry)

Si GPT-5.2 incluye líneas NEED, hay dos modos:
- **`NEED|art|ley`** (artículo específico): fetch por filtro de metadatos + embedding semántico fallback
- **`NEED|query`** (búsqueda libre): ejecuta el pipeline de búsqueda completo (S2-S4) con esa query

En ambos casos, si se obtienen chunks nuevos, se puntúan, se añaden al contexto, se re-ordena por score y se aplica un soft-cap de MAX_CHUNKS_TO_MODEL + 5 (30). Se re-llama a GPT-5.2 (máximo 1 retry).

### Lógica DROP (carryover)

Los índices DROP se excluyen de `contextChunkIds` devueltos al frontend, así **no se arrastran** en preguntas de continuación. Solo los chunks USED sobreviven al carryover.

**Parámetros:** Sin `temperature`, sin `max_completion_tokens` (GPT-5.2 es reasoning model).

---

## Resumen de llamadas a modelos por query

| Stage | Modelo | Endpoint | Llamadas | Propósito |
|-------|--------|----------|----------|-----------|
| 1 | GPT-5 Nano | Reader | 1 | Descomponer en N queries |
| 2 | E3S | Reader | N (1-4) | Embedding por query |
| 5 | GPT-5.2 | Principal | 1-2 | Respuesta + evaluación (+ retry si NEED) |
| 5 fetch | E3S | Reader | 0-2 | Embedding de NEED articles (si retry) |
| **Total** | | | **3-8** | |

**Caso simple (1 query, sin NEED):** 3 llamadas (Nano + E3S + GPT-5.2)
**Caso complejo (3 queries + NEED retry):** 8 llamadas
**Las queries de Stage 2-4 se ejecutan en paralelo**, por lo que el tiempo adicional es mínimo.

---

## Stages eliminados (histórico)

- **~~Stage 5 Rerank (GPT-5 Nano)~~** — Eliminado. GPT-5.2 evalúa directamente en su respuesta.
- **~~Stage 5c Context Evaluation (GPT-5.2)~~** — Fusionado con Stage 5 (respuesta unificada).
- **~~Stage 6 Respuesta Final (GPT-5.2)~~** — Fusionado con Stage 5.
