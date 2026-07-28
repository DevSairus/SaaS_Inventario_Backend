'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // ── product_commission_settlements ──────────────────────────────────
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS product_commission_settlements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
          settlement_number VARCHAR(50) NOT NULL,
          user_id UUID NOT NULL REFERENCES users(id),
          date_from DATE,
          date_to DATE,
          commission_percentage DECIMAL(5,2) NOT NULL,
          base_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          commission_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          notes TEXT,
          created_by UUID NOT NULL REFERENCES users(id),
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS product_commission_settlements_tenant_id_idx ON product_commission_settlements (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS product_commission_settlements_user_id_idx ON product_commission_settlements (user_id)`,
        { transaction }
      );

      // ── product_commission_settlement_items ─────────────────────────────
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS product_commission_settlement_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          settlement_id UUID NOT NULL REFERENCES product_commission_settlements(id) ON DELETE CASCADE,
          work_order_id UUID,
          order_number VARCHAR(50),
          sale_id UUID,
          sale_number VARCHAR(50),
          product_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          product_name VARCHAR(255),
          product_sku VARCHAR(50),
          quantity DECIMAL(10,3),
          unit_price DECIMAL(15,2),
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS pcsi_settlement_id_idx ON product_commission_settlement_items (settlement_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS pcsi_work_order_id_idx ON product_commission_settlement_items (work_order_id)`,
        { transaction }
      );

      // ── superadmin_mercadopago_config ────────────────────────────────────
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS superadmin_mercadopago_config (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          access_token TEXT,
          public_key VARCHAR(255),
          webhook_secret VARCHAR(255),
          test_mode BOOLEAN DEFAULT true,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // ── tenant_mercadopago_config ────────────────────────────────────────
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS tenant_mercadopago_config (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
          access_token TEXT NOT NULL,
          public_key VARCHAR(255) NOT NULL,
          test_mode BOOLEAN DEFAULT true,
          is_active BOOLEAN DEFAULT true,
          custom_success_url TEXT,
          custom_failure_url TEXT,
          custom_pending_url TEXT,
          custom_notification_url TEXT,
          binary_mode BOOLEAN DEFAULT false,
          auto_return VARCHAR(50) DEFAULT 'approved',
          statement_descriptor VARCHAR(50),
          metadata JSONB,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('tenant_mercadopago_config');
    await queryInterface.dropTable('superadmin_mercadopago_config');
    await queryInterface.dropTable('product_commission_settlement_items');
    await queryInterface.dropTable('product_commission_settlements');
  },
};