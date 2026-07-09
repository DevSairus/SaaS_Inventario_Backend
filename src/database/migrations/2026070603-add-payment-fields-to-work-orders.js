'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(15,2) DEFAULT 0`
    );

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_work_orders_payment_status') THEN
          CREATE TYPE enum_work_orders_payment_status AS ENUM ('pending', 'partial', 'paid');
        END IF;
      END
      $$;
    `);

    await queryInterface.sequelize.query(
      `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS payment_status enum_work_orders_payment_status DEFAULT 'pending'`
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS payment_history JSONB DEFAULT '[]'::jsonb`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE work_orders DROP COLUMN IF EXISTS paid_amount`);
    await queryInterface.sequelize.query(`ALTER TABLE work_orders DROP COLUMN IF EXISTS payment_status`);
    await queryInterface.sequelize.query(`ALTER TABLE work_orders DROP COLUMN IF EXISTS payment_history`);
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_work_orders_payment_status`);
  },
};
