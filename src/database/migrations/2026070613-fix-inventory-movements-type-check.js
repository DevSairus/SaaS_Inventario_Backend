'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // El CHECK original solo permitía un vocabulario "canónico":
      //   purchase, sale, customer_return, supplier_return, adjustment_in,
      //   adjustment_out, transfer_in, transfer_out, production, internal_use,
      //   obsolescence, sample, damage, initial_stock
      // Pero varios controllers usan nombres distintos para conceptos equivalentes
      // (purchase_receipt, transfer_send/transfer_receive, internal_consumption,
      // sale_reversal, taller_repuesto) porque createMovement() guarda
      // movement_reason directamente en la columna movement_type.
      // Se amplía a la UNIÓN de ambos vocabularios (no se quita nada existente).
      await queryInterface.sequelize.query(
        `ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check`,
        { transaction }
      );
      await queryInterface.sequelize.query(`
        ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
        CHECK (movement_type IN (
          'purchase', 'sale', 'customer_return', 'supplier_return',
          'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out',
          'production', 'internal_use', 'obsolescence', 'sample', 'damage',
          'initial_stock',
          'purchase_receipt', 'transfer_send', 'transfer_receive',
          'internal_consumption', 'sale_reversal', 'taller_repuesto',
          'movimiento'
        ))
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    // No se revierte: reducir el CHECK podría romper filas ya creadas con los nuevos valores.
  },
};
