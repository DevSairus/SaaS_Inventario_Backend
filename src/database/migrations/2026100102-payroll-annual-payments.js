'use strict';

// Consignación anual de cesantías al fondo (payrollAccountingService.js#
// consignarCesantias): es un desembolso de nómina que no pertenece a un
// periodo sino a un año -- payroll_period_id pasa a ser opcional y se
// agrega fiscal_year. payment_type no tiene CHECK en la base (lo valida el
// modelo), así que 'severance_fund' no necesita cambio de esquema.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE payroll_payments ALTER COLUMN payroll_period_id DROP NOT NULL`);
    await q.query(`ALTER TABLE payroll_payments ADD COLUMN IF NOT EXISTS fiscal_year SMALLINT`);
    await q.query(`CREATE INDEX IF NOT EXISTS payroll_payments_year_idx ON payroll_payments (tenant_id, payment_type, fiscal_year)`);
    console.log('[Migration] payroll_payments: consignación anual de cesantías (fiscal_year, periodo opcional)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`DROP INDEX IF EXISTS payroll_payments_year_idx`);
    await q.query(`ALTER TABLE payroll_payments DROP COLUMN IF EXISTS fiscal_year`);
    await q.query(`DELETE FROM payroll_payments WHERE payroll_period_id IS NULL`);
    await q.query(`ALTER TABLE payroll_payments ALTER COLUMN payroll_period_id SET NOT NULL`);
  },
};
