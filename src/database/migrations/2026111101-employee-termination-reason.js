'use strict';

// 6.2 — Motivo del retiro.
//  - employees.termination_reason / termination_notes: causa del retiro y observaciones.
//  - payroll_periods.termination_reason: copia (snapshot) de la causa al emitir la
//    liquidación definitiva, para que el período conserve lo que se liquidó aunque
//    la ficha del empleado cambie después.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.

const REASONS = [
  'renuncia', 'mutuo_acuerdo', 'justa_causa', 'sin_justa_causa', 'vencimiento_contrato',
  'terminacion_obra', 'periodo_prueba', 'pension', 'fallecimiento', 'otro',
];
const list = REASONS.map((r) => `'${r}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_reason VARCHAR(30)`);
      await q(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_notes TEXT`);
      await q(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_termination_reason_check`);
      await q(`ALTER TABLE employees ADD CONSTRAINT employees_termination_reason_check CHECK (termination_reason IS NULL OR termination_reason IN (${list}))`);
      await q(`ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS termination_reason VARCHAR(30)`);
      await q(`ALTER TABLE payroll_periods DROP CONSTRAINT IF EXISTS payroll_periods_termination_reason_check`);
      await q(`ALTER TABLE payroll_periods ADD CONSTRAINT payroll_periods_termination_reason_check CHECK (termination_reason IS NULL OR termination_reason IN (${list}))`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`ALTER TABLE payroll_periods DROP CONSTRAINT IF EXISTS payroll_periods_termination_reason_check`);
      await q(`ALTER TABLE payroll_periods DROP COLUMN IF EXISTS termination_reason`);
      await q(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_termination_reason_check`);
      await q(`ALTER TABLE employees DROP COLUMN IF EXISTS termination_notes`);
      await q(`ALTER TABLE employees DROP COLUMN IF EXISTS termination_reason`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
};
