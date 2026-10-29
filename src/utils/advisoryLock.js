// backend/src/utils/advisoryLock.js
//
// Con múltiples réplicas del mismo servicio en Railway, cada proceso Node
// arranca de forma independiente y no sabe nada de los demás -- migraciones
// al boot y jobs de cron corrían N veces (uno por réplica) sin coordinación.
// Los advisory locks de Postgres son la forma más simple de coordinarlas sin
// agregar infraestructura nueva (Redis, etc.): son locks a nivel de sesión/
// transacción que YA vive en la base de datos que todas las réplicas
// comparten.
//
// Se usa la variante `_xact_` (ligada a la transacción, no a la conexión):
// el lock se libera solo con COMMIT/ROLLBACK, así que no hay riesgo de que
// el pool de conexiones de Sequelize devuelva la conexión al pool con el
// lock todavía sostenido (lo que pasaría con pg_advisory_lock/unlock "sueltos"
// si el unlock termina corriendo en una conexión distinta a la del lock).
//
// hashtext(key) convierte el nombre del lock (string legible) en el bigint
// que pg_advisory_xact_lock espera, para no tener que inventar y mantener
// números mágicos únicos a mano por cada lock.
const { sequelize } = require('../config/database');

/**
 * Espera hasta obtener el lock (bloqueante) y corre fn() con el lock
 * sostenido durante toda la transacción. Usar para trabajo que TODAS las
 * réplicas deben esperar a que termine antes de seguir (ej. migraciones de
 * esquema) -- no para trabajo que simplemente se debe saltar si otra réplica
 * ya lo está hitting.
 */
async function withAdvisoryLockBlocking(lockName, fn) {
  return sequelize.transaction(async (t) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: lockName },
      transaction: t,
    });
    return fn();
  });
}

/**
 * Intenta tomar el lock sin esperar. Si otra réplica ya lo tiene, no corre
 * fn() y devuelve { acquired: false } -- pensado para jobs de cron: si el
 * job ya está corriendo en otra réplica en este mismo instante, esta réplica
 * simplemente se salta la ejecución en vez de esperar y correrlo de nuevo.
 */
async function withAdvisoryLockTry(lockName, fn) {
  return sequelize.transaction(async (t) => {
    const [[{ locked }]] = await sequelize.query('SELECT pg_try_advisory_xact_lock(hashtext(:key)) AS locked', {
      replacements: { key: lockName },
      transaction: t,
    });
    if (!locked) return { acquired: false };
    const result = await fn();
    return { acquired: true, result };
  });
}

/**
 * Igual que withAdvisoryLockTry, pero con un lease en public.cron_locks en vez
 * de un advisory lock de transacción: tomar y soltar el lease son dos queries
 * cortas, y mientras corre fn() no queda ninguna transacción abierta ni
 * conexión del pool retenida (con el advisory lock, cada job sostenía una
 * conexión "idle in transaction" durante minutos -- Neon llegó a cortar una
 * de 40 min).
 *
 * El lease vence solo a los ttlMs: si el proceso muere a mitad del job, otra
 * réplica puede tomarlo después. Por eso ttlMs tiene que ser mayor que lo que
 * puede durar el job; si lo supera, otra réplica podría arrancarlo en paralelo.
 */
async function withLeaseTry(lockName, ttlMs, fn) {
  const owner = require('crypto').randomUUID();
  const [rows] = await sequelize.query(`
    INSERT INTO public.cron_locks (name, locked_until, locked_by, updated_at)
    VALUES (:name, NOW() + (:ttlMs * INTERVAL '1 millisecond'), :owner, NOW())
    ON CONFLICT (name) DO UPDATE
      SET locked_until = EXCLUDED.locked_until, locked_by = EXCLUDED.locked_by, updated_at = NOW()
      WHERE public.cron_locks.locked_until < NOW()
    RETURNING name
  `, { replacements: { name: lockName, ttlMs, owner } });
  if (rows.length === 0) return { acquired: false };

  const startedAt = new Date();
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    // Se suelta, pero nunca antes de 55 s desde que empezó: las réplicas
    // disparan el mismo cron con unos ms/segundos de diferencia, y un job que
    // termina rápido no debe dejar que otra lo repita en ese mismo disparo.
    await sequelize.query(
      `UPDATE public.cron_locks SET locked_until = GREATEST(NOW(), :startedAt::timestamptz + INTERVAL '55 seconds'), updated_at = NOW()
        WHERE name = :name AND locked_by = :owner`,
      { replacements: { name: lockName, owner, startedAt } }
    ).catch(() => { /* si falla, el lease vence solo */ });
  }
}

module.exports = { withAdvisoryLockBlocking, withAdvisoryLockTry, withLeaseTry };
