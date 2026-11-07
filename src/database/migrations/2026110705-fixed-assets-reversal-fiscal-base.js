'use strict';

// Activos fijos, tercera parte:
//   - fiscal_cost / fiscal_salvage_value: base fiscal cuando difiere de la
//     contable (costo fiscal distinto, o sin valor residual fiscal). Vacíos =
//     los contables. Ver services/accounting/fixedAssetFiscal.service.js.
//   - Reversión de deterioro: se guarda en fixed_asset_impairments con monto
//     negativo; su asiento acredita 425050 Recuperación de deterioro (mapeo
//     fixed_asset_impairment_recovery).

const ACCOUNT = { code: '425050', name: 'Recuperación de deterioro de propiedades, planta y equipo', parent: '42', type: 'ingreso' };
const MAPPING = 'fixed_asset_impairment_recovery';

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
    try {
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS fiscal_cost DECIMAL(15, 2)`);
      await q(`ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS fiscal_salvage_value DECIMAL(15, 2)`);
      const [tenants] = await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);
      for (const { tenant_id: tenantId } of tenants) {
        let [[acc]] = await q(`SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code`, { tenantId, code: ACCOUNT.code });
        if (!acc) {
          const [[parent]] = await q(`SELECT id, level FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code`, { tenantId, code: ACCOUNT.parent });
          // Plan de cuentas propio sin la cuenta padre: no se agrega nada.
          if (!parent) continue;
          [[acc]] = await q(
            `INSERT INTO chart_of_accounts
               (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
             VALUES (gen_random_uuid(), :tenantId, :code, :name, :type, :parentId, :level, true, true, NOW(), NOW())
             RETURNING id`,
            { tenantId, code: ACCOUNT.code, name: ACCOUNT.name, type: ACCOUNT.type, parentId: parent?.id || null, level: parent ? Number(parent.level) + 1 : 3 },
          );
        }
        await q(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           SELECT gen_random_uuid(), :tenantId, :event, :accountId, NOW(), NOW()
            WHERE NOT EXISTS (SELECT 1 FROM account_mappings WHERE tenant_id = :tenantId AND event_type = :event)`,
          { tenantId, event: MAPPING, accountId: acc.id },
        );
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE fixed_assets DROP COLUMN IF EXISTS fiscal_salvage_value');
    await queryInterface.sequelize.query('ALTER TABLE fixed_assets DROP COLUMN IF EXISTS fiscal_cost');
  },
};
