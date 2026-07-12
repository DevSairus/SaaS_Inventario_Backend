'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Una fila por cada "envío" de cotización al cliente — permite tener
      // varias rondas en la misma OT, cada una bloqueada de forma independiente.
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS work_order_quote_requests (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          work_order_id UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'enviada' CHECK (status IN ('enviada', 'respondida')),
          sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          responded_at TIMESTAMP WITH TIME ZONE,
          approved_by_name VARCHAR(150),
          approved_by_document VARCHAR(30),
          approved_ip VARCHAR(45),
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS work_order_quote_requests_wo_idx
        ON work_order_quote_requests (work_order_id);
      `, { transaction });

      await queryInterface.sequelize.query(`
        ALTER TABLE work_order_items
          ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'aprobado',
          ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(255),
          ADD COLUMN IF NOT EXISTS quote_request_id UUID REFERENCES work_order_quote_requests(id) ON DELETE SET NULL;
      `, { transaction });

      // Constraint condicional: algunos entornos ya podrían tener la columna
      // (y su check) de una corrida parcial anterior — evita fallar la migración.
      await queryInterface.sequelize.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'work_order_items_approval_status_check'
          ) THEN
            ALTER TABLE work_order_items
              ADD CONSTRAINT work_order_items_approval_status_check
              CHECK (approval_status IN ('pendiente', 'aprobado', 'rechazado'));
          END IF;
        END $$;
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS work_order_items_quote_request_idx
        ON work_order_items (quote_request_id);
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE work_order_items DROP CONSTRAINT IF EXISTS work_order_items_approval_status_check;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS work_order_items_quote_request_idx;`);
    await queryInterface.removeColumn('work_order_items', 'quote_request_id');
    await queryInterface.removeColumn('work_order_items', 'rejection_reason');
    await queryInterface.removeColumn('work_order_items', 'approval_status');
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS work_order_quote_requests_wo_idx;`);
    await queryInterface.dropTable('work_order_quote_requests');
  },
};
