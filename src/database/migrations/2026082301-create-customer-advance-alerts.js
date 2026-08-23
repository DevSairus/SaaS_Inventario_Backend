'use strict';

// Alertas de antigüedad de Anticipos de Clientes — Fase 4, punto 2 del plan
// (Anticipos-Clientes-Analisis-y-Plan.md §10). Un anticipo no tiene
// vencimiento (decisión de negocio, §11.2), pero uno que lleva mucho tiempo
// sin aplicarse es una señal operativa: el cliente puede haberlo olvidado,
// o el negocio debería contactarlo para aplicarlo a algo. Mismo patrón
// estructural que payable_alerts / stock_alerts (alert_type, severity,
// status active/resolved/ignored).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS customer_advance_alerts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          advance_id UUID NOT NULL REFERENCES customer_advances(id) ON DELETE CASCADE ON UPDATE CASCADE,
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE,

          alert_type VARCHAR(20) NOT NULL DEFAULT 'stale'
            CHECK (alert_type IN ('stale', 'very_stale')),
          severity VARCHAR(20) NOT NULL DEFAULT 'warning'
            CHECK (severity IN ('info', 'warning', 'critical')),

          balance DECIMAL(15,2) NOT NULL,
          days_since_received INTEGER NOT NULL DEFAULT 0,

          status VARCHAR(20) NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'resolved', 'ignored')),

          alert_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          resolved_date TIMESTAMP WITH TIME ZONE,
          resolved_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          resolution_notes TEXT,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_alerts_tenant_idx ON customer_advance_alerts (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_alerts_tenant_status_idx ON customer_advance_alerts (tenant_id, status)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_alerts_advance_idx ON customer_advance_alerts (advance_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_alerts_customer_idx ON customer_advance_alerts (tenant_id, customer_id)`,
        { transaction }
      );
      // Una alerta activa por anticipo — misma idea que payable_alerts_unique_active_lookup.
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS customer_advance_alerts_unique_active_lookup ON customer_advance_alerts (tenant_id, advance_id, status)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS customer_advance_alerts`);
  },
};
