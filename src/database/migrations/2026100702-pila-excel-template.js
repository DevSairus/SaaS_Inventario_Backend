'use strict';

// Plantilla del Excel de la PILA aprendida de una muestra de la empresa
// (columnas, filas, tipos) -- ver services/payroll/pila/pilaExcel.service.js.
// NULL = plantilla estándar (data/pila-excel-default-template.json).

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS pila_excel_template JSONB`);
    console.log('[Migration] payroll_settings.pila_excel_template');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE payroll_settings DROP COLUMN IF EXISTS pila_excel_template`);
  },
};
