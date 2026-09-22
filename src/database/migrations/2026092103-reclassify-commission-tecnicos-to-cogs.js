'use strict';

// Reclasifica la comisión de técnicos de gasto operativo (510510) a costo de
// servicio (615595, la misma cuenta que sale_cogs_service) -- es costo de la
// mano de obra vendida en Taller, no un gasto administrativo. Dejarla en
// 510510 inflaba la Utilidad Bruta del Estado de Resultados formal, aunque
// el reporte gerencial de rentabilidad (getProfitabilityReport) ya la trataba
// como costo por su cuenta, calculado directo de las tablas fuente.
//
// Solo actualiza el account_mappings existente (event_type
// 'expense_category:comisiones_tecnicos') para que apunte a 615595 -- no
// toca los Expense/JournalEntry ya contabilizados con la cuenta vieja, eso
// requeriría reclasificar movimientos históricos y queda fuera de una
// migración de mapeo.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      UPDATE account_mappings m
      SET account_id = a615595.id, updated_at = NOW()
      FROM chart_of_accounts a615595
      WHERE m.event_type = 'expense_category:comisiones_tecnicos'
        AND a615595.tenant_id = m.tenant_id
        AND a615595.code = '615595';
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      UPDATE account_mappings m
      SET account_id = a510510.id, updated_at = NOW()
      FROM chart_of_accounts a510510
      WHERE m.event_type = 'expense_category:comisiones_tecnicos'
        AND a510510.tenant_id = m.tenant_id
        AND a510510.code = '510510';
    `);
  },
};
