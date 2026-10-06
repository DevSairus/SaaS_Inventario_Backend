'use strict';

// Proveedores que son entidades de nómina (EPS, pensión, cesantías, ARL, caja
// de compensación, SENA, ICBF). Un mismo proveedor puede tener varios tipos
// (p.ej. Porvenir es fondo de pensión y de cesantías). Los selectores de
// fondos de nómina solo muestran los proveedores marcados con el tipo
// correspondiente. Ver data/payroll-funds-colombia.js.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payroll_fund_types JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Proveedores que ya están asignados como fondo en empleados o en la
    // configuración de nómina quedan marcados, para que no desaparezcan de
    // los selectores al aplicar el filtro.
    const tag = async (type, sql) => q.query(`
      UPDATE suppliers s SET payroll_fund_types = s.payroll_fund_types || '["${type}"]'::jsonb
      WHERE s.id IN (${sql}) AND NOT (s.payroll_fund_types ? '${type}')
    `);
    await tag('eps', 'SELECT eps_supplier_id FROM employees WHERE eps_supplier_id IS NOT NULL');
    await tag('afp', 'SELECT pension_fund_supplier_id FROM employees WHERE pension_fund_supplier_id IS NOT NULL');
    await tag('cesantias', 'SELECT severance_fund_supplier_id FROM employees WHERE severance_fund_supplier_id IS NOT NULL');
    await tag('arl', 'SELECT arl_supplier_id FROM payroll_settings WHERE arl_supplier_id IS NOT NULL');
    await tag('ccf', 'SELECT ccf_supplier_id FROM payroll_settings WHERE ccf_supplier_id IS NOT NULL');
    await tag('sena', 'SELECT sena_supplier_id FROM payroll_settings WHERE sena_supplier_id IS NOT NULL');
    await tag('icbf', 'SELECT icbf_supplier_id FROM payroll_settings WHERE icbf_supplier_id IS NOT NULL');
    console.log('[Migration] suppliers.payroll_fund_types');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE suppliers DROP COLUMN IF EXISTS payroll_fund_types`);
  },
};
