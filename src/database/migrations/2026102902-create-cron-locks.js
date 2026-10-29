'use strict';

// Leases de los jobs del scheduler (ver utils/advisoryLock.js#withLeaseTry).
// Reemplaza al advisory lock de transacción, que dejaba una transacción
// abierta -- y una conexión del pool ocupada -- durante todo el job.
//
// Siempre en public (calificado): migrateAllTenantSchemas corre esto también
// con el search_path de cada tenant, y el lock es uno solo para todas las
// réplicas, no por tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS public.cron_locks (
        name VARCHAR(100) PRIMARY KEY,
        locked_until TIMESTAMPTZ NOT NULL,
        locked_by VARCHAR(64),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS public.cron_locks`);
  },
};
