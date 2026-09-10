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

module.exports = { withAdvisoryLockBlocking, withAdvisoryLockTry };
