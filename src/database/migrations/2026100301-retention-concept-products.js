'use strict';

// Concepto de retención en la fuente por producto y por categoría (id del
// catálogo tenant.tax_config.retention_concepts, ej. 'compras', 'servicios',
// 'honorarios'). NULL = heredar: producto → categoría → proveedor → tipo de
// producto (ver services/retentionEngine.service.js).

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS retention_concept VARCHAR(60)`);
    await q.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS retention_concept VARCHAR(60)`);
    console.log('[Migration] retention_concept en products y categories');
  },
  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE products DROP COLUMN IF EXISTS retention_concept`);
    await q.query(`ALTER TABLE categories DROP COLUMN IF EXISTS retention_concept`);
  },
};
