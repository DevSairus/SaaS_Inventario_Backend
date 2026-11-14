'use strict';

// AIU por proyecto (Fase 4, req. 1.6). Ver services/projects/projectAiu.js.
//
//   projects.aiu_*     AIU del proyecto: se carga al crearlo (de la cotización
//                      si es AIU) y se puede editar. Es el valor por defecto
//                      de cada corte.
//   project_cuts.aiu_* AIU de ese corte (copia editable del proyecto). Un
//                      concepto en 0 % no aplica; la Utilidad siempre > 0
//                      porque es la base del IVA.
//
// Relleno: los proyectos cuya cotización es AIU heredan sus porcentajes, y
// los cortes existentes con AIU toman los de la cotización (así se calculaban).
//
// Sin calificar con esquema.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      for (const table of ['projects', 'project_cuts']) {
        // eslint-disable-next-line no-await-in-loop
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS aiu_enabled BOOLEAN NOT NULL DEFAULT false`);
        for (const col of ['aiu_admin_pct', 'aiu_unforeseen_pct', 'aiu_profit_pct']) {
          // eslint-disable-next-line no-await-in-loop
          await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} DECIMAL(5, 2)`);
        }
      }

      await q(`
        UPDATE projects p
           SET aiu_enabled = true,
               aiu_admin_pct = s.aiu_admin_pct,
               aiu_unforeseen_pct = s.aiu_unforeseen_pct,
               aiu_profit_pct = s.aiu_profit_pct
          FROM sales s
         WHERE s.id = p.quote_id AND s.aiu_enabled = true AND p.aiu_enabled = false
      `);
      await q(`
        UPDATE project_cuts c
           SET aiu_enabled = true,
               aiu_admin_pct = p.aiu_admin_pct,
               aiu_unforeseen_pct = p.aiu_unforeseen_pct,
               aiu_profit_pct = p.aiu_profit_pct
          FROM projects p
         WHERE p.id = c.project_id AND p.aiu_enabled = true AND c.aiu_enabled = false AND c.aiu_amount > 0
      `);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const table of ['projects', 'project_cuts']) {
      for (const col of ['aiu_enabled', 'aiu_admin_pct', 'aiu_unforeseen_pct', 'aiu_profit_pct']) {
        // eslint-disable-next-line no-await-in-loop
        await q(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${col}`);
      }
    }
  },
};
