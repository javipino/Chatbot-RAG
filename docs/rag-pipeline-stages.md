# Pipeline RAG — Etapas, Modelos y Prompts

## Resumen del flujo

```
Query del usuario
  │
  ├─ Stage 1: Query Decomposition ─────── GPT-5 Nano (Reader)
  │     Output: 1-4 queries independientes
  │
  ├─ Para CADA query (en paralelo):
  │   ├─ Stage 2: Embedding ────────────── text-embedding-3-small (Reader)
  │   ├─ Stage 3: Sparse Vector ────────── TF-IDF/BM25 (local)
  │   └─ Stage 4: Hybrid Search ────────── Qdrant Cloud (dense + sparse, RRF)
  │         └─ 4b: Cross-collection ────── 3 colecciones en paralelo
  │
  ├─ Merge + dedup (top 30 por score)
  │
  ├─ Stage 5: Reranking ────────────────── GPT-5 Nano (Reader)
  │
  ├─ Stage 5b: Reference Expansion ────── Qdrant (fetch por ID, sin modelo)
  │
  ├─ Stage 5c: Context Evaluation ──────── GPT-5.2 (Principal) — iterativo ×2
  │     └─ Fetch artículos faltantes ──── Qdrant (filter + semantic hybrid, con embedding)
  │
  └─ Stage 6: Respuesta final ─────────── GPT-5.2 (Principal)
```

---

## Modelos y Endpoints

| Modelo | Deployment | Endpoint | TPM | Rol |
|--------|-----------|----------|-----|-----|
| **GPT-5 Nano** | `gpt-5-nano` | Reader (`openai-reader-javi`) | 100K | Expansión, Reranking |
| **text-embedding-3-small** | `text-embedding-3-small` | Reader | 150K | Embeddings (1536 dims) |
| **GPT-5.2** | `gpt-5.2` | Principal (`javie-mku5l3k8-swedencentral`) | 50K | Evaluación, Respuesta final |

---

## Stage 1 — Query Decomposition (GPT-5 Nano)

**Objetivo:** Descomponer la pregunta del usuario en 1-4 búsquedas independientes. Para preguntas simples devuelve 1 query. Para preguntas complejas que involucran múltiples conceptos, devuelve una query por cada concepto.

**Modelo:** `gpt-5-nano` (Reader endpoint)  
**Output:** JSON array de strings (1-4 queries)

### Ejemplo

| Pregunta | Queries generadas |
|----------|------------------|
| "¿Cuántos días de vacaciones tengo?" | 1 query: vacaciones anuales Art.38 ET |
| "¿El trabajo de una empleada del hogar es pluriempleo o pluriactividad?" | 3 queries: pluriempleo, pluriactividad, régimen empleadas del hogar |
| "¿Y si no me las dan?" (follow-up) | 1 query: autocontenida basada en historial |

### System Prompt

```
Eres un asistente legal. Tu tarea es descomponer la pregunta del usuario en las
BÚSQUEDAS NECESARIAS para encontrar toda la normativa relevante en una base de
datos de legislación laboral y de Seguridad Social española.

RESPONDE SOLO con un JSON array de strings. Cada string es una búsqueda independiente.

Reglas:
- Si la pregunta es SIMPLE (un solo concepto), devuelve UN array con una sola query
  expandida.
  Ejemplo: "¿cuántos días de vacaciones tengo?" →
  ["vacaciones anuales retribuidas artículo 38 Estatuto de los Trabajadores derecho
   a vacaciones período de disfrute"]
- Si la pregunta es COMPLEJA (compara, relaciona o involucra varios conceptos),
  devuelve VARIAS queries, una por cada concepto que hay que buscar por separado.
  Ejemplo: "¿el trabajo de una empleada del hogar es pluriempleo o pluriactividad?" →
  ["pluriempleo Seguridad Social alta simultánea mismo régimen artículo 148 LGSS
    cotización",
   "pluriactividad Seguridad Social alta simultánea distintos regímenes artículo 149
    LGSS",
   "régimen especial empleadas del hogar Sistema Especial trabajadores del hogar
    artículo 250-251 LGSS"]
- Si la pregunta es una CONTINUACIÓN de la conversación, usa el historial para
  generar queries completas y autocontenidas.
- Máximo 4 queries. Si la pregunta necesita más, agrupa los conceptos más cercanos.
- Cada query debe ser autocontenida.
- Incluye siempre términos técnicos legales Y los coloquiales.
- Traduce los términos coloquiales a sus equivalentes legales:
  * "baja de maternidad/paternidad" → "suspensión del contrato por nacimiento y
    cuidado de menor, artículo 48 ET"
  * "despido" → "extinción del contrato de trabajo, artículo 49-56 ET"
  * "paro" → "prestación por desempleo, artículo 262-267 LGSS"
  * "baja médica" → "incapacidad temporal, artículo 169-176 LGSS"
  * "pensión" → "prestación contributiva de jubilación, artículo 204-215 LGSS"
  * "contrato temporal" → "contrato de duración determinada, artículo 15 ET"
  * "finiquito" → "liquidación de haberes, extinción del contrato"

RESPONDE SOLO con el JSON array. Sin explicaciones, sin markdown, sin backticks.
```

### Mensajes enviados

```json
[
  { "role": "system", "content": "<system prompt arriba>" },
  // Últimos 4 mensajes del historial (truncados a 300 chars cada uno)
  { "role": "user",      "content": "<mensaje previo 1>" },
  { "role": "assistant", "content": "<respuesta previa 1>" },
  // ...
  { "role": "user", "content": "<pregunta actual del usuario>" }
]
```

**Output:** `["query1", "query2", "query3"]` (1-4 strings)  
**Fallback:** Si el modelo no devuelve JSON válido, se usa el texto como query única.  
**Parámetros:** Sin `temperature` (Nano no lo soporta). Sin `max_completion_tokens`.

---

## Stages 2-4 — Se ejecutan POR CADA query del Stage 1 (en paralelo)

Si Stage 1 devuelve N queries, los Stages 2-4 se ejecutan N veces en paralelo.  
Los resultados se deduplican por ID (manteniendo el score más alto) y se toman los **top 30** antes del reranking.

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

## Stage 5 — Reranking (GPT-5 Nano)

**Objetivo:** Reordenar los 20 resultados por relevancia real y quedarse con los top 8.

**Modelo:** `gpt-5-nano` (Reader endpoint)

### System Prompt

```
Evalúa la relevancia de cada fragmento para responder la pregunta del usuario.
Devuelve SOLO un JSON array con los índices ordenados de más a menos relevante.
Ejemplo: [3, 0, 5, 1]
Incluye solo los fragmentos relevantes (máximo 8). Si un fragmento no es relevante,
no lo incluyas.
Criterios de prioridad:
- Prioriza leyes principales (Estatuto de los Trabajadores, LGSS, LETA) sobre
  reglamentos de desarrollo.
- Prioriza artículos vigentes sobre disposiciones transitorias con fechas pasadas.
- Prioriza texto sustantivo sobre referencias procedimentales.
```

### User Prompt

```
Pregunta: <query original del usuario>

Fragmentos:
[0] (normativa) Artículo 48 del ET: <texto truncado a 300 chars>

[1] (normativa) Sección 2ª: <texto truncado a 300 chars>

...
```

**Output esperado:** JSON array de índices, ej: `[3, 0, 5, 1, 7, 2]`

---

## Stage 5b — Reference Expansion (Pre-computada)

**Objetivo:** Traer chunks referenciados por los resultados del reranking (ej: un artículo menciona otro artículo que no apareció en la búsqueda).

**No usa modelo.** Cada chunk tiene un campo `refs: [int]` con IDs de otros chunks que referencia. Se hace fetch por ID a Qdrant.

---

## Stage 5c — Context Evaluation (GPT-5.2) — Iterativa

**Objetivo:** Evaluar si el contexto recopilado es suficiente para responder. Si faltan artículos críticos, pedirlos. Si hay fragmentos irrelevantes, descartarlos.

**Modelo:** `gpt-5.2` (Principal endpoint)  
**Iteraciones máximas:** 2 (`MAX_ITERATIONS`)

### System Prompt

```
Eres un evaluador de contexto legal. Tu tarea es decidir si los fragmentos
proporcionados son SUFICIENTES para responder la pregunta del usuario sobre
legislación laboral española.

IMPORTANTE: Puedes usar tu conocimiento preentrenado para IDENTIFICAR qué artículos
o leyes faltan (líneas NEED), pero NO para evaluar si el contenido de los fragmentos
es correcto o completo — solo evalúa lo que ves en el texto proporcionado.

RESPONDE con EXACTAMENTE uno de estos formatos:

OPCIÓN A — Si el contexto es SUFICIENTE para responder:
READY

OPCIÓN B — Si FALTA información crítica:
NEED|número_artículo|nombre_ley
DROP|índices_irrelevantes

Reglas para NEED:
- Solo pide artículos que sean IMPRESCINDIBLES para responder correctamente
- Máximo 3 líneas NEED
- Usa el nombre corto de la ley (ej: "Estatuto Trabajadores", "LGSS")

Reglas para DROP:
- Lista los índices [N] de fragmentos que NO aportan nada a la respuesta
- Separados por comas en UNA sola línea
- Si todos son relevantes, no incluyas línea DROP

Regla especial:
- Si la pregunta involucra derechos del trabajador, asegura que tienes los artículos
  base del Estatuto de los Trabajadores (ET). Si no los ves en los fragmentos,
  pídelos con NEED.

Ejemplo de respuesta B:
NEED|48|Estatuto Trabajadores
NEED|177|LGSS
DROP|0,3,7
```

### User Prompt

```
Pregunta: <query original>

Fragmentos disponibles:
[0] Estatuto de los Trabajadores > Artículo 38
<texto truncado a 200 chars>

[1] LGSS > Artículo 170
<texto truncado a 200 chars>

...
```

### Lógica iterativa

```
for iter = 0 to MAX_ITERATIONS-1:
    evaluation = evaluateContext(query, results)
    if evaluation.ready → break
    else:
        DROP: eliminar fragmentos irrelevantes por índice
        NEED: buscar artículos faltantes con doble estrategia:
              1. Filter: match exacto en metadatos (section + law) — rápido
              2. Semantic fallback: embed "Artículo X Ley Y", búsqueda
                 híbrida (dense + sparse + RRF) con filtro laxo por ley
              Se deduplicican resultados y se añaden al contexto.
```

**Coste extra por iteración:** Hasta 3 NEEDs × (1 embedding + 1 Qdrant query) = 3 llamadas extra a E3S + 3 queries Qdrant.

---

## Stage 6 — Respuesta Final (GPT-5.2)

**Objetivo:** Generar la respuesta al usuario basándose exclusivamente en los fragmentos de normativa recuperados.

**Modelo:** `gpt-5.2` (Principal endpoint)

### System Prompt

```
Eres un experto en legislación laboral y de Seguridad Social española.
Respondes preguntas basándote EXCLUSIVAMENTE en los fragmentos de normativa que se
te proporcionan como contexto.
NO uses tu conocimiento preentrenado para responder. Solo puedes citar lo que aparece
en los fragmentos.

Reglas:
- Cita siempre la ley, capítulo y artículo específico en tu respuesta.
- Si el contexto proporcionado no contiene información suficiente para responder,
  dilo claramente. NO inventes ni completes con conocimiento propio.
- Responde en español, de forma clara y estructurada.
- Si hay varias normas relevantes, menciona todas.
- Usa un tono profesional pero accesible.

Jerarquía normativa (CRÍTICO - aplica siempre):
- Cuando haya CONTRADICCIÓN entre fuentes, prevalece la norma de mayor rango:
  1. Leyes orgánicas y Estatutos (ET, LGSS, LETA, etc.)
  2. Reales Decretos-ley
  3. Reales Decretos y Reglamentos (como RD 295/2009)
  4. Órdenes ministeriales
  5. Disposiciones transitorias (pueden estar superadas por la regulación definitiva)
- Si un reglamento dice una cosa y la ley dice otra, LA LEY PREVALECE SIEMPRE.
- Las disposiciones transitorias con fechas pasadas pueden estar derogadas
  implícitamente por la regulación actual.
- Ejemplo: si el Art. 48 del Estatuto de los Trabajadores fija una duración de
  suspensión diferente a la que indica un reglamento de desarrollo, prevalece el
  Estatuto.
- Cuando respondas, indica la fuente de mayor rango y, si detectas contradicción
  con otra fuente de menor rango, señálalo brevemente.

Principio pro operario y norma más favorable:
- Las normas de rango inferior solo pueden MEJORAR los derechos del trabajador
  respecto a las de rango superior, NUNCA restringirlos ni empeorarlos.
- Si un convenio colectivo, reglamento o acuerdo establece condiciones PEORES que la
  ley, esas condiciones son NULAS por vulnerar el principio de norma mínima.
- Si un convenio o reglamento establece condiciones MEJORES que la ley (más días de
  permiso, mayor indemnización, etc.), prevalece la norma más favorable al trabajador.
- En caso de duda interpretativa sobre el alcance de una norma, aplica la
  interpretación más favorable al trabajador (in dubio pro operario).
- Señala siempre cuándo una norma de desarrollo mejora los mínimos legales.
```

### Mensajes enviados

```json
[
  { "role": "system", "content": "<system prompt arriba>" },
  { "role": "system", "content": "CONTEXTO DE NORMATIVA VIGENTE:\n\n<contexto construido>" },
  // Últimos 6 mensajes del historial de conversación
  { "role": "user",      "content": "..." },
  { "role": "assistant", "content": "..." },
  { "role": "user",      "content": "<pregunta actual>" }
]
```

### Formato del contexto inyectado

```
[Fuente 1 — normativa]
Ley: Estatuto de los Trabajadores
Capítulo: Capítulo II - Contenido del contrato de trabajo
Sección: Artículo 38. Vacaciones anuales
Resumen: Regulación del derecho a vacaciones...
Texto: <contenido completo del chunk>

---

[Fuente 2 — normativa]
Ley: LGSS
...
```

**Parámetros:** Sin `temperature`, sin `max_completion_tokens` (GPT-5.2 es reasoning model, gestiona su propio budget).

---

## Resumen de llamadas a modelos por query

| Stage | Modelo | Endpoint | Llamadas | Propósito |
|-------|--------|----------|----------|-----------|
| 1 | GPT-5 Nano | Reader | 1 | Descomponer en N queries |
| 2 | E3S | Reader | N (1-4) | Embedding por query |
| 5 | GPT-5 Nano | Reader | 1 | Reranking |
| 5c | GPT-5.2 | Principal | 1-2 | Evaluar contexto |
| 5c fetch | E3S | Reader | 0-3 | Embedding de refs faltantes |
| 6 | GPT-5.2 | Principal | 1 | Respuesta final |
| **Total** | | | **5-10** | |

**Caso simple (1 query):** 5-6 llamadas (igual que antes)  
**Caso complejo (3 queries):** 8-10 llamadas  
**Las queries de Stage 2-4 se ejecutan en paralelo**, por lo que el tiempo adicional es mínimo.
