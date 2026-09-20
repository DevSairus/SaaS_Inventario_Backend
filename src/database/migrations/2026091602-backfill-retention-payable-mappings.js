'use strict';

// Fase 0 de Declaraciones Periódicas / Formulario 350 — ver
// Contabilidad-Declaraciones-Periodicas-Analisis-y-Plan.md §2.5 y §3.2.
//
// generatePurchaseEntry/generateExpenseEntry (autoEntries.service.js) hasta
// ahora acreditaban el total_amount completo a la cuenta por pagar/caja,
// ignorando retefuente/reteiva/reteica -- el valor retenido no se le paga
// al proveedor, se le debe a la DIAN. El PUC estándar ya traía las cuentas
// de pasivo (236505/236710/236805) desde antes, solo sin mapear a ningún
// evento -- por eso este backfill NO necesita crear cuentas nuevas en el
// caso normal (createIfMissing en ensureRetentionPayableMappings las crea
// solo como red de seguridad si un tenant las hubiera perdido).
//
// Mismo patrón que 2026091502-backfill-fixed-asset-depreciation-mapping.js:
// backfill inmediato en el deploy + ensureRetentionPayableMappings corriendo
// también en cada arranque del servidor (ver accountingSeed.service.js /
// scripts/reconcileAccountingSeed.js) como red de seguridad para tenants que
// esta migración no alcance a cubrir.
//
// Esta migración SOLO agrega el mapeo (configuración) -- NO corrige
// asientos ya contabilizados con la lógica anterior. Para eso ver
// scripts/backfillRetentionCorrectionEntries.js (dry-run por defecto,
// requiere --apply explícito).

const RETENTION_MAPPINGS = [
  { event: 'purchase_retefuente_payable', code: '236505', name: 'Retención en la Fuente por Pagar' },
  { event: 'purchase_reteiva_payable', code: '236710', name: 'IVA Retenido por Pagar' },
  { event: 'purchase_reteica_payable', code: '236805', name: 'Retención de ICA por Pagar' },
  { event: 'expense_retefuente_payable', code: '236505', name: 'Retención en la Fuente por Pagar' },
  { event: 'expense_reteiva_payable', code: '236710', name: 'IVA Retenido por Pagar' },
  { event: 'expense_reteica_payable', code: '236805', name: 'Retención de ICA por Pagar' },
];

module.exports = {
  up: async (queryInterface) => {
    const [tenantsWithChartOfAccounts] = await queryInterface.sequelize.query(`
      SELECT DISTINCT tenant_id FROM chart_of_accounts
    `);

    for (const { tenant_id } of tenantsWithChartOfAccounts) {
      const [parent23Rows] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '23'`,
        { replacements: { tenantId: tenant_id } }
      );
      const parent23 = parent23Rows[0];

      for (const m of RETENTION_MAPPINGS) {
        let [accountRows] = await queryInterface.sequelize.query(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code`,
          { replacements: { tenantId: tenant_id, code: m.code } }
        );
        let account = accountRows[0];

        if (!account) {
          // Red de seguridad: no debería pasar (el PUC estándar ya trae
          // estas cuentas), pero si un tenant las hubiera perdido por lo
          // que sea, no se deja el mapeo a medias.
          [[account]] = await queryInterface.sequelize.query(
            `INSERT INTO chart_of_accounts
               (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
             VALUES
               (gen_random_uuid(), :tenantId, :code, :name, 'pasivo', :parentId, 3, true, true, NOW(), NOW())
             RETURNING id`,
            { replacements: { tenantId: tenant_id, code: m.code, name: m.name, parentId: parent23?.id || null } }
          );
        }

        await queryInterface.sequelize.query(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           VALUES (gen_random_uuid(), :tenantId, :eventType, :accountId, NOW(), NOW())
           ON CONFLICT (tenant_id, event_type) DO NOTHING`,
          { replacements: { tenantId: tenant_id, eventType: m.event, accountId: account.id } }
        );
      }
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type IN (
        'purchase_retefuente_payable', 'purchase_reteiva_payable', 'purchase_reteica_payable',
        'expense_retefuente_payable', 'expense_reteiva_payable', 'expense_reteica_payable'
      );
    `);
  },
};
