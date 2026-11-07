'use strict';

// Activos fijos, segunda parte (ver services/accounting/fixedAssetDepreciation.service.js
// y fixedAssetFiscal.service.js):
//
//   - Métodos: línea recta, saldos decrecientes (doble saldo con paso a línea
//     recta), unidades de producción (uso mensual en fixed_asset_usage),
//     menor cuantía (≤ 50 UVT: se deprecia todo en el mes de compra) y "no se
//     deprecia" (terrenos).
//   - Categorías nuevas: construcciones, terrenos y equipo de comunicación.
//   - project_id: la depreciación se carga al proyecto (dimensión de los
//     asientos, como el resto del módulo Proyectos).
//   - Deterioro (fixed_asset_impairments) con su asiento: gasto 519905 contra
//     deterioro acumulado 159905.
//   - Libro fiscal: fiscal_max_rate (tasa anual máxima del art. 137 E.T.) y
//     fiscal_opening_accumulated (depreciación fiscal que ya traía).
//   - Cuentas de activo que faltaban en el plan base: 1504 terrenos, 1516
//     construcciones, 1520 maquinaria y 1540 flota y equipo de transporte.

const ACCOUNTS = [
  { code: '1504', name: 'Terrenos', parent: '15', type: 'activo' },
  { code: '1516', name: 'Construcciones y Edificaciones', parent: '15', type: 'activo' },
  { code: '1520', name: 'Maquinaria y Equipo', parent: '15', type: 'activo' },
  { code: '1540', name: 'Flota y Equipo de Transporte', parent: '15', type: 'activo' },
  { code: '159905', name: 'Deterioro acumulado de propiedades, planta y equipo (CR)', parent: '15', type: 'activo' },
  { code: '519905', name: 'Deterioro de propiedades, planta y equipo', parent: '51', type: 'gasto' },
];
const MAPPINGS = { fixed_asset_impairment_expense: '519905', fixed_asset_impairment_accumulated: '159905' };
// Gasto de depreciación de las categorías nuevas: la misma cuenta que ya use "otro".
const NEW_CATEGORIES = ['construcciones', 'equipo_comunicacion'];

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
    try {
      const [[hasProjects]] = await q(`SELECT to_regclass('projects') IS NOT NULL AS ok`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS project_id UUID${hasProjects.ok ? ' REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE' : ''}`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS total_units DECIMAL(15, 2)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS unit_label VARCHAR(20)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS fiscal_max_rate DECIMAL(5, 2)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS fiscal_opening_accumulated DECIMAL(15, 2)`);

      await q(`
        CREATE TABLE IF NOT EXISTS fixed_asset_usage (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          fixed_asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
          period VARCHAR(7) NOT NULL,
          units DECIMAL(15, 2) NOT NULL,
          notes VARCHAR(255),
          created_by UUID,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (fixed_asset_id, period)
        )
      `);
      await q(`
        CREATE TABLE IF NOT EXISTS fixed_asset_impairments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          fixed_asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE ON UPDATE CASCADE,
          impairment_date DATE NOT NULL,
          amount DECIMAL(15, 2) NOT NULL,
          reason TEXT,
          journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL ON UPDATE CASCADE,
          created_by UUID,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS fixed_asset_impairments_asset_idx ON fixed_asset_impairments (fixed_asset_id)`);

      const [tenants] = await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);
      for (const { tenant_id: tenantId } of tenants) {
        const ids = {};
        for (const acc of ACCOUNTS) {
          const [[existing]] = await q(`SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code`, { tenantId, code: acc.code });
          if (existing) { ids[acc.code] = existing.id; continue; }
          const [[parent]] = await q(`SELECT id, level FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code`, { tenantId, code: acc.parent });
          // Plan de cuentas propio sin esa cuenta padre: no se le agrega nada;
          // el negocio asigna la cuenta en Mapeo de cuentas si usa la función.
          if (!parent) continue;
          const [[created]] = await q(
            `INSERT INTO chart_of_accounts
               (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
             VALUES (gen_random_uuid(), :tenantId, :code, :name, :type, :parentId, :level, true, true, NOW(), NOW())
             RETURNING id`,
            { tenantId, code: acc.code, name: acc.name, type: acc.type, parentId: parent?.id || null, level: parent ? Number(parent.level) + 1 : 3 },
          );
          ids[acc.code] = created.id;
        }
        for (const [event, code] of Object.entries(MAPPINGS)) {
          if (!ids[code]) continue;
          await q(
            `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
             SELECT gen_random_uuid(), :tenantId, :event, :accountId, NOW(), NOW()
              WHERE NOT EXISTS (SELECT 1 FROM account_mappings WHERE tenant_id = :tenantId AND event_type = :event)`,
            { tenantId, event, accountId: ids[code] },
          );
        }
        for (const cat of NEW_CATEGORIES) {
          await q(
            `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
             SELECT gen_random_uuid(), :tenantId, :event, m.account_id, NOW(), NOW()
               FROM account_mappings m
              WHERE m.tenant_id = :tenantId AND m.event_type = 'fixed_asset_depreciation_expense:otro'
                AND NOT EXISTS (SELECT 1 FROM account_mappings WHERE tenant_id = :tenantId AND event_type = :event)`,
            { tenantId, event: `fixed_asset_depreciation_expense:${cat}` },
          );
        }
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS fixed_asset_impairments');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS fixed_asset_usage');
    for (const col of ['fiscal_opening_accumulated', 'fiscal_max_rate', 'unit_label', 'total_units', 'project_id']) {
      await queryInterface.sequelize.query(`ALTER TABLE fixed_assets DROP COLUMN IF EXISTS ${col}`);
    }
  },
};
