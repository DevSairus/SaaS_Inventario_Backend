// backend/src/utils/concurrency.js
//
// Reemplazo liviano de `p-limit` (sin agregar dependencia nueva) para
// evitar el patrón `for (const x of items) { await doSomething(x) }` en
// jobs/servicios que procesan colecciones potencialmente grandes contra la
// DB -- ese patrón es N+1 secuencial: con `items.length` = 200, son 200
// round-trips uno detrás del otro, sosteniendo tiempo de conexión del pool
// todo el rato.
//
// `mapWithConcurrencyLimit` corre `limit` tareas en simultáneo en vez de
// una por una. Preferir esto a `Promise.all(items.map(fn))` sin límite
// cuando `items` puede ser grande (ej. "todas las oportunidades abiertas
// de un tenant", "todos los tenants") -- lanzar todo sin límite puede
// saturar el pool de conexiones de golpe en vez de aliviarlo.
//
// Ver GUIA-RENDIMIENTO.md, sección "Loops que hacen queries", para cuándo
// usar esto vs. Promise.all sin límite vs. secuencial a propósito.

/**
 * @param {Array<T>} items
 * @param {number} limit - cuántas tareas corren en simultáneo
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<R>>} resultados en el mismo orden que `items`
 */
async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return results;
}

module.exports = { mapWithConcurrencyLimit };
