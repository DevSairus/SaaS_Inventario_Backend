'use strict';

// Lote de mejoras de compras y caja (nov-20):
//
//   purchases.iva_to_cost         IVA de la compra al costo (no discriminado),
//                                 fijado al crearla según la configuración de
//                                 la empresa (features.purchase_iva_to_cost).
//                                 null = regla de siempre (responsable de IVA).
//   purchases.purchase_kind       'invoice' (de siempre) | 'order': orden de
//                                 compra que entra al inventario sin factura;
//                                 al recibirla se acredita la cuenta
//                                 transitoria 233595 y al registrar la factura
//                                 se traslada a proveedores (2205).
//   purchases.freight_supplier_id flete cobrado por otra empresa (transportadora):
//   purchases.freight_expense_id  se registra como gasto aparte ligado a la
//   expenses.purchase_id          compra, pero se capitaliza al inventario.
//   cash_sessions.shortage_*      faltante del cierre: pérdida (519599) o cuenta
//   cash_sessions.adjustments     por cobrar al cajero (136595), y las
//                                 correcciones posteriores (dinero encontrado,
//                                 empleado repone).
//
// Cuentas nuevas en tenants que ya tienen plan de cuentas (los nuevos las
// reciben del PUC estándar): 233595 y 136595, con su mapeo.

const NEW_ACCOUNTS = [
  { code: '233595', name: 'Mercancía Recibida por Facturar', type: 'pasivo', parent: '23', event: 'purchase_goods_received_not_invoiced' },
  { code: '136595', name: 'Cuentas por Cobrar a Trabajadores (faltantes de caja)', type: 'activo', parent: '13', event: 'cash_session_shortage_employee' },
];

module.exports = {
  up: async (queryInterface, Sequelize, context) => {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });

    await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS iva_to_cost BOOLEAN`);
    await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_kind VARCHAR(10) NOT NULL DEFAULT 'invoice'`);
    await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS freight_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS freight_expense_id UUID`);
    await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS invoice_date DATE`);
    await q(`CREATE INDEX IF NOT EXISTS purchases_kind_invoice ON purchases (tenant_id, purchase_kind, status)`);

    await q(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL`);
    await q(`CREATE INDEX IF NOT EXISTS expenses_purchase_id ON expenses (purchase_id) WHERE purchase_id IS NOT NULL`);

    await q(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS shortage_treatment VARCHAR(12)`);
    await q(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS shortage_user_id UUID`);
    await q(`ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS adjustments JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Bajo aprovisionamiento por schema, solo este tenant.
    const [tenants] = context?.tenantId
      ? await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts WHERE tenant_id = :tenantId`, { tenantId: context.tenantId })
      : await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);

    for (const { tenant_id } of tenants) {
      for (const acc of NEW_ACCOUNTS) {
        let [[account]] = await q(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code LIMIT 1`,
          { tenantId: tenant_id, code: acc.code }
        );
        if (!account) {
          const [[parent]] = await q(
            `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code LIMIT 1`,
            { tenantId: tenant_id, code: acc.parent }
          );
          if (!parent) continue; // plan de cuentas atípico: no forzar
          [[account]] = await q(
            `INSERT INTO chart_of_accounts
               (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
             VALUES (gen_random_uuid(), :tenantId, :code, :name, :type, :parentId, 4, true, true, NOW(), NOW())
             RETURNING id`,
            { tenantId: tenant_id, code: acc.code, name: acc.name, type: acc.type, parentId: parent.id }
          );
        }
        await q(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           VALUES (gen_random_uuid(), :tenantId, :event, :accountId, NOW(), NOW())
           ON CONFLICT (tenant_id, event_type) DO NOTHING`,
          { tenantId: tenant_id, event: acc.event, accountId: account.id }
        );
      }
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DELETE FROM account_mappings WHERE event_type IN ('purchase_goods_received_not_invoiced', 'cash_session_shortage_employee')`);
    await q(`ALTER TABLE cash_sessions DROP COLUMN IF EXISTS adjustments, DROP COLUMN IF EXISTS shortage_user_id, DROP COLUMN IF EXISTS shortage_treatment`);
    await q(`ALTER TABLE expenses DROP COLUMN IF EXISTS purchase_id`);
    await q(`ALTER TABLE purchases DROP COLUMN IF EXISTS invoice_date, DROP COLUMN IF EXISTS freight_expense_id, DROP COLUMN IF EXISTS freight_supplier_id, DROP COLUMN IF EXISTS purchase_kind, DROP COLUMN IF EXISTS iva_to_cost`);
  },
};
