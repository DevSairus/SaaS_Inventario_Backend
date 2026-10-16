'use strict';

// El CHECK de inventory_movements.movement_type (2026070613) no incluye los
// motivos que se agregaron después: createMovement() guarda movement_reason
// directamente en movement_type, así que «Reversar devolución» (cliente y
// proveedor, services/returns/returnReversal.js) fallaba con violación de
// CHECK, y la cancelación de una transferencia ya enviada
// (transfers.controller.js cancelTransfer, 'transfer_cancel') también.
// Igual que 2026070613: se amplía la lista, no se quita nada.
const ALLOWED = [
  'purchase', 'sale', 'customer_return', 'supplier_return',
  'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out',
  'production', 'internal_use', 'obsolescence', 'sample', 'damage',
  'initial_stock',
  'purchase_receipt', 'transfer_send', 'transfer_receive',
  'internal_consumption', 'sale_reversal', 'taller_repuesto',
  'movimiento',
  'customer_return_reversal', 'supplier_return_reversal', 'transfer_cancel',
];

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check`,
        { transaction }
      );
      await queryInterface.sequelize.query(`
        ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
        CHECK (movement_type IN (${ALLOWED.map((v) => `'${v}'`).join(', ')}))
      `, { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async () => {
    // No se revierte: reducir el CHECK podría romper filas ya creadas con los nuevos valores.
  },
};
