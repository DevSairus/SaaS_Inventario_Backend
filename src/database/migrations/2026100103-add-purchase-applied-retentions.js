'use strict';

// Retenciones por concepto en compras.
//
// Un proveedor puede tener varios conceptos/tarifas del mismo tipo de
// retención (ReteFuente 2.5% compras, 4% servicios, 11% honorarios...) en
// supplier.retention_config.retentions. La compra guarda aquí las líneas que
// realmente se practicaron ([{ retention_id, code, concept, rate, base,
// amount, account_id }]); las columnas agregadas retefuente_amount /
// reteiva_amount / reteica_amount siguen siendo la suma por tipo, así
// Exógena y los reportes existentes no cambian.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS applied_retentions JSONB DEFAULT '[]'`);
    // reteica_rate era DECIMAL(5,4) (máx 9.9999‰): tarifas ICA reales como
    // 11.04‰ o 13.8‰ (o la tarifa ponderada de varios conceptos) desbordaban
    // la columna y tumbaban el INSERT de la compra.
    await q.query(`ALTER TABLE purchases ALTER COLUMN reteica_rate TYPE DECIMAL(7,4)`);
    console.log('[Migration] purchases.applied_retentions agregada; reteica_rate ampliada a DECIMAL(7,4)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS applied_retentions`);
  }
};
