# Guía de rendimiento — backend Pitbox

Reglas que salieron de la auditoría de rendimiento del 23 ago 2026 (ver
`analisis-rendimiento-pitbox.md` del lado del proyecto de análisis). Cuatro
de los cinco hallazgos de esa auditoría eran variaciones del mismo error:
código escrito como si esto corriera en un serverless con instancias
efímeras, cuando en realidad **Pitbox corre en Railway como un proceso Node
persistente**, con un scheduler in-process (`src/jobs/scheduler.js`) que
comparte el mismo pool de conexiones que los requests HTTP.

Esto importa para toda funcionalidad nueva. Cuatro reglas:

## 1. El pool de conexiones es un recurso compartido y escaso

`src/config/database.js` tiene `max: 15` en producción (antes: 2, copiado de
una plantilla de Vercel serverless). **No lo bajes** pensando que "menos
conexiones es más seguro" — acá lo peligroso es lo contrario: un proceso
persistente con pocas conexiones hace que CUALQUIER trabajo pesado (un job,
un reporte, un import masivo) bloquee el resto del sitio para todos los
tenants durante el tiempo que dure.

Si agregás un job nuevo en `src/jobs/scheduler.js`, preguntate: *¿cuánto
tiempo va a sostener conexiones abiertas, y qué le pasa a un usuario que
entra al sitio mientras corre?*

## 2. Queries independientes van en `Promise.all`, no en cadena de `await`

Si estás armando un endpoint que junta varios KPIs/agregados que no dependen
entre sí (el caso típico: un dashboard), **no hagas esto**:

```js
const a = await Modelo.findOne(...);
const b = await Modelo.findOne(...);
const c = await Modelo.findAll(...);
```

Esto es la suma de los tres tiempos. Hacé esto en su lugar:

```js
const [a, b, c] = await Promise.all([
  Modelo.findOne(...),
  Modelo.findOne(...),
  Modelo.findAll(...),
]);
```

Esto pasa a ser el tiempo del más lento de los tres. Ver
`src/controllers/dashboard.controller.js` (`getKPIs`) como referencia ya
aplicada.

**Cuándo NO hacerlo:** si una query necesita el resultado de otra (ej.
armar un `where` con un id que devolvió la query anterior), tiene que seguir
siendo secuencial — eso no es el problema que esto resuelve.

## 3. Loops que hacen queries por cada elemento: usar `mapWithConcurrencyLimit`, no un `for` secuencial

Patrón prohibido salvo que el orden importe (ver excepción abajo):

```js
for (const item of items) {
  await hacerAlgoQueConsultaLaDB(item);   // N round-trips, uno detrás del otro
}
```

Con `items` grande (todas las oportunidades abiertas de un tenant, todos los
tenants, todos los productos...) esto sostiene el pool de conexiones todo
el tiempo que tarda en procesar la colección completa. Usar en su lugar
`src/utils/concurrency.js`:

```js
const { mapWithConcurrencyLimit } = require('../utils/concurrency');

await mapWithConcurrencyLimit(items, 5, async (item) => {
  await hacerAlgoQueConsultaLaDB(item);
});
```

El `5` es la concurrencia — cuántas tareas corren en simultáneo. Ajustar
según cuánto puede sostener el pool sin dejar sin conexiones al resto del
sitio (con `max: 15`, algo entre 3 y 8 suele ser razonable para un job de
background; para requests HTTP interactivos, preferir `Promise.all` sin
límite si la colección es chica y acotada por el usuario, ej. "los items de
esta factura").

**Excepción — cuándo SÍ dejarlo secuencial:** si cada iteración depende del
resultado o del estado que dejó la anterior (ej. una asignación round-robin
que necesita saber quién fue el último asignado), paralelizar rompe la
lógica, no solo el rendimiento. Ver `services/crmAutomationEngine.js` →
`applyRuleToOpportunities`, que deja `assign_round_robin` secuencial a
propósito y comenta por qué. Si tenés dudas sobre si tu loop tiene esta
dependencia oculta, dejalo secuencial y consultá antes de paralelizar.

## 4. Todo modelo nuevo: índice para lo que filtrás Y para lo que ordenás

Un índice en `{ tenant_id, campo_de_filtro }` no ayuda si además hacés
`order: [['otro_campo', 'DESC']]` y ese otro campo no está en ningún
índice — Postgres puede usar el índice para el `WHERE` pero igual termina
ordenando en memoria. Si tu endpoint nuevo tiene `where` + `order`, el
índice tiene que cubrir ambos (compuesto, en ese orden: primero lo que
filtra, después lo que ordena).

Checklist al agregar un modelo o un endpoint de listado nuevo:
- ¿Qué campos van en el `where` típico? → índice compuesto con `tenant_id`.
- ¿Hay un `order` fijo (no elegido dinámicamente por el usuario)? → ese
  campo va al final del mismo índice compuesto.
- No olvidar la migración (`addIndex`) además de declararlo en el modelo —
  el `indexes:` del modelo no crea nada solo en la DB real.

---

Si algo de esto no aplica a tu caso particular (por ejemplo, un job que
genuinamente necesita ser secuencial), dejá un comentario explicando por
qué — como en el caso de `assign_round_robin` — para que la próxima persona
no lo "optimice" por error.
