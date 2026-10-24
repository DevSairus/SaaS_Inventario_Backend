'use strict';

// Prioridad híbrida del tablero CRM: el sistema sugiere negocios prioritarios
// (seguimiento vencido/hoy, cierre cercano, días sin mover) y el asesor puede
// fijar uno a mano con este flag (ver utils/crmLeadScore.js).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE IF EXISTS opportunities ADD COLUMN IF NOT EXISTS priority_pinned BOOLEAN NOT NULL DEFAULT FALSE`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE IF EXISTS opportunities DROP COLUMN IF EXISTS priority_pinned`
    );
  },
};
