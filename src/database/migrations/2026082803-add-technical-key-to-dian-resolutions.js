'use strict';

// Hoy `technical_key` (y `test_set_id`) viven SOLO en `tenant.dian_config`,
// un único valor global para todo el tenant sin importar el tipo de
// documento. Eso es correcto mientras solo existe facturación de venta, pero
// deja de serlo con Documento Soporte: la DIAN exige una habilitación
// (set de pruebas) SEPARADA por tipo de documento, y esa habilitación entrega
// su propia clave técnica — la misma que ya se usa para facturación de venta
// NO sirve para Documento Soporte (ver Documento-Soporte-Analisis-y-Plan.md,
// §6 "Habilitación DIAN separada").
//
// En vez de convertir `dian_config` en un objeto anidado por tipo de
// documento, se agrega `technical_key`/`test_set_id` directamente en
// `dian_resolutions` — que ya es la entidad que naturalmente representa "una
// numeración/habilitación para un tipo de documento en una sede". Si la
// resolución no trae su propia clave técnica, el sistema sigue cayendo al
// valor global de `dian_config.technical_key` (ver dianKitAdapter.js), así
// que esto es 100% retrocompatible con las resoluciones de factura ya
// creadas.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE dian_resolutions
        ADD COLUMN IF NOT EXISTS technical_key VARCHAR(255),
        ADD COLUMN IF NOT EXISTS test_set_id VARCHAR(100)
    `);
    console.log('[Migration] dian_resolutions.technical_key / test_set_id agregadas');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE dian_resolutions
        DROP COLUMN IF EXISTS technical_key,
        DROP COLUMN IF EXISTS test_set_id
    `);
  },
};
