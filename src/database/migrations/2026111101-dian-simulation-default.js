'use strict';

// Modo simulación DIAN por defecto (ver services/dian/dianSimulation.js):
//   1. Empresas que todavía NO pueden facturar electrónicamente (sin
//      certificado y en pruebas o sin ambiente) pasan a 'simulation'. Las que
//      tienen certificado o están en producción no se tocan.
//   2. Resoluciones de simulación (prefijos SIM*) para cada sede activa de las
//      empresas en simulación, por tipo de documento, si no las tienen.
// Corre en `public` y luego en cada schema de empresa (migrateAllTenantSchemas):
// el paso 1 apunta siempre a public.tenants y es idempotente; el paso 2 usa
// las tablas del schema en curso.
const SIM = [
  ['invoice', 'SIMF'],
  ['credit_note', 'SIMC'],
  ['debit_note', 'SIMD'],
  ['support_document', 'SIMS'],
  ['support_document_adjustment', 'SIMA'],
  ['payroll', 'SIMN'],
];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      UPDATE public.tenants
         SET dian_config = COALESCE(dian_config, '{}'::jsonb) || '{"environment":"simulation"}'::jsonb
       WHERE COALESCE(dian_config->>'environment', 'test') = 'test'
         AND COALESCE(dian_config->>'certificate_p12_base64', '') = ''
    `);

    const [[hasBranchId]] = await q(`
      SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'dian_resolutions' AND column_name = 'branch_id'
    `);
    const [[hasBranches]] = await q(`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'branches'
    `);
    if (!hasBranchId.n || !hasBranches.n) return;

    const values = SIM.map(([doc, prefix]) => `('${doc}', '${prefix}')`).join(', ');
    await q(`
      INSERT INTO dian_resolutions
        (tenant_id, branch_id, document_type, resolution_number, resolution_date, prefix,
         from_number, to_number, current_number, valid_from, valid_to, is_active, is_test, notes)
      SELECT b.tenant_id, b.id, d.doc, '00000000000', DATE '2020-01-01', d.prefix,
             1, 999999999, 1, DATE '2020-01-01', DATE '2099-12-31', true, true,
             'Resolución de SIMULACIÓN (demo): los documentos con este prefijo no se envían a la DIAN.'
        FROM branches b
        JOIN public.tenants t ON t.id = b.tenant_id AND t.dian_config->>'environment' = 'simulation'
       CROSS JOIN (VALUES ${values}) AS d(doc, prefix)
       WHERE b.is_active
         AND NOT EXISTS (
           SELECT 1 FROM dian_resolutions r
            WHERE r.tenant_id = b.tenant_id AND r.branch_id = b.id
              AND r.document_type = d.doc AND r.is_test AND r.is_active
         )
    `);
  },

  // Solo se quitan las resoluciones de simulación sin uso; el ambiente de
  // cada empresa queda como esté (puede haberlo cambiado a mano).
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM dian_resolutions
       WHERE prefix IN (${SIM.map(([, p]) => `'${p}'`).join(', ')}) AND is_test AND current_number = 1
    `);
  },
};
