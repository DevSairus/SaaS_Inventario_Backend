'use strict';

// Alertas de costo de compra (ver services/inventory/purchaseCost.service.js).
// Se generan al recibir una compra o confirmar una compra rápida cuando:
//   - el último costo de compra varía más del umbral del tenant
//     (business_config.cost_variation_alert_pct, 10% por defecto), o
//   - el precio de venta calculado con el margen quedó POR DEBAJO del actual:
//     el precio nunca baja solo, se conserva y queda aquí para revisión
//     (price_held), con el precio sugerido listo para aplicarse.
// Tabla propia y no stock_alerts: syncStockAlertsForTenants resuelve las
// alertas de stock de otro tipo al recalcular niveles, y cerraría estas.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public):
// migrateAllTenantSchemas corre esto con el search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS cost_alerts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,

          alert_type VARCHAR(20) NOT NULL
            CHECK (alert_type IN ('cost_increase', 'cost_decrease', 'price_held')),
          severity VARCHAR(20) NOT NULL DEFAULT 'warning'
            CHECK (severity IN ('info', 'warning', 'critical')),

          previous_cost DECIMAL(15,4),
          new_cost DECIMAL(15,4) NOT NULL,
          variation_pct DECIMAL(9,2),
          previous_price DECIMAL(15,2),
          suggested_price DECIMAL(15,2),
          price_held BOOLEAN NOT NULL DEFAULT FALSE,

          source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('purchase', 'adjustment')),
          source_id UUID,
          source_number VARCHAR(50),

          status VARCHAR(20) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'resolved', 'ignored')),
          alert_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          resolved_date TIMESTAMP WITH TIME ZONE,
          resolved_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          resolution_notes TEXT,
          price_applied BOOLEAN NOT NULL DEFAULT FALSE,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS cost_alerts_tenant_status_idx ON cost_alerts (tenant_id, status)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS cost_alerts_product_idx ON cost_alerts (tenant_id, product_id, status)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS cost_alerts`);
  },
};
