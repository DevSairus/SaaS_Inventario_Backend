'use strict';

// Activos fijos: saldo inicial, cambios de estimación y baja/venta con asiento.
// Ver services/accounting/fixedAssetDepreciation.service.js.
//
//   opening_accumulated_depreciation / opening_period: depreciación que el
//     activo ya traía (de otro sistema) hasta el mes `opening_period`
//     inclusive. Pitbox deprecia desde el mes siguiente, sin regenerar el
//     pasado en periodos ya cerrados.
//   basis_period / basis_amount / basis_months: desde `basis_period` la
//     cuota mensual es basis_amount / basis_months (saldo por depreciar
//     repartido en la vida restante). Lo usan el saldo inicial y los cambios
//     de vida útil o valor residual, que la norma aplica hacia adelante.
//   estimate_changes: historial de esos cambios.
//   disposal_type / sale_amount / sale_account_id / disposal_journal_entry_id:
//     baja por retiro o venta, con su asiento (activo, depreciación
//     acumulada y utilidad o pérdida).
//
// Cuentas nuevas en el plan base: 424505 utilidad y 531015 pérdida en venta
// y retiro de propiedades, planta y equipo, con sus mapeos.

const ACCOUNTS = [
  { code: '424505', name: 'Utilidad en venta de propiedades, planta y equipo', parent: '42', type: 'ingreso' },
  { code: '531015', name: 'Pérdida en venta y retiro de propiedades, planta y equipo', parent: '53', type: 'gasto' },
];
const MAPPINGS = { fixed_asset_disposal_gain: '424505', fixed_asset_disposal_loss: '531015' };

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
    try {
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS opening_accumulated_depreciation DECIMAL(15, 2)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS opening_period VARCHAR(7)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS basis_period VARCHAR(7)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS basis_amount DECIMAL(15, 2)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS basis_months INTEGER`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS estimate_changes JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS disposal_type VARCHAR(10)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS sale_amount DECIMAL(15, 2)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS sale_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS disposal_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL ON UPDATE CASCADE`);

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
            { tenantId, code: acc.code, name: acc.name, type: acc.type, parentId: parent?.id || null, level: parent ? Number(parent.level) + 1 : 4 },
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
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    for (const col of ['disposal_journal_entry_id', 'sale_account_id', 'sale_amount', 'disposal_type', 'estimate_changes', 'basis_months', 'basis_amount', 'basis_period', 'opening_period', 'opening_accumulated_depreciation']) {
      await queryInterface.sequelize.query(`ALTER TABLE fixed_assets DROP COLUMN IF EXISTS ${col}`);
    }
  },
};
