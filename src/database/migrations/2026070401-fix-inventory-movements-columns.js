'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = queryInterface.sequelize;

    // Agregar columnas faltantes a inventory_movements
    const columns = [
      { name: 'direction', type: "VARCHAR(20) DEFAULT 'in'" },
      { name: 'reason', type: 'VARCHAR(100)' },
      { name: 'source_warehouse_id', type: 'UUID' },
      { name: 'destination_warehouse_id', type: 'UUID' },
      { name: 'reference_number', type: 'VARCHAR(100)' },
      { name: 'stock_before', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'stock_after', type: 'DECIMAL(15,2) DEFAULT 0' },
      { name: 'average_cost_before', type: 'DECIMAL(15,4) DEFAULT 0' },
      { name: 'average_cost_after', type: 'DECIMAL(15,4) DEFAULT 0' },
      { name: 'batch_number', type: 'VARCHAR(100)' },
      { name: 'serial_number', type: 'VARCHAR(100)' },
      { name: 'expiration_date', type: 'DATE' },
      { name: 'status', type: "VARCHAR(20) DEFAULT 'completed'" },
      { name: 'created_by', type: 'UUID' },
      { name: 'approved_by', type: 'UUID' },
      { name: 'approved_at', type: 'TIMESTAMP WITH TIME ZONE' },
    ];

    for (const col of columns) {
      try {
        await q.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`);
        console.log(`[Migration] inventory_movements.${col.name} OK`);
      } catch (e) {
        if (e.message.includes('already exists')) {
          console.log(`[Migration] ${col.name} ya existe`);
        } else {
          console.log(`[Migration] ${col.name} error:`, e.message);
        }
      }
    }

    // Migrar datos de previous_stock/new_stock a stock_before/stock_after si existen
    try {
      await q.query(`
        UPDATE inventory_movements 
        SET stock_before = previous_stock, stock_after = new_stock 
        WHERE stock_before = 0 AND previous_stock IS NOT NULL AND previous_stock != 0
      `);
      console.log('[Migration] Datos migrados a stock_before/stock_after');
    } catch (e) { /* ignorar */ }

    // Migrar user_id a created_by si existe
    try {
      await q.query(`
        UPDATE inventory_movements 
        SET created_by = user_id 
        WHERE created_by IS NULL AND user_id IS NOT NULL
      `);
      console.log('[Migration] Datos migrados a created_by');
    } catch (e) { /* ignorar */ }

    // Migrar movement_reason a reason
    try {
      await q.query(`
        UPDATE inventory_movements 
        SET reason = movement_reason 
        WHERE reason IS NULL AND movement_reason IS NOT NULL
      `);
      console.log('[Migration] Datos migrados a reason');
    } catch (e) { /* ignorar */ }

    // Migrar movement_type a direction
    try {
      await q.query(`
        UPDATE inventory_movements 
        SET direction = CASE 
          WHEN movement_type IN ('entrada', 'in') THEN 'in'
          WHEN movement_type IN ('salida', 'out') THEN 'out'
          ELSE 'none'
        END
        WHERE direction IS NULL OR direction = 'in'
      `);
      console.log('[Migration] Datos migrados a direction');
    } catch (e) { /* ignorar */ }

    console.log('[Migration] inventory_movements actualizado');
  },

  async down(queryInterface, Sequelize) {
    const columns = [
      'direction', 'reason', 'source_warehouse_id', 'destination_warehouse_id',
      'reference_number', 'stock_before', 'stock_after', 'average_cost_before',
      'average_cost_after', 'batch_number', 'serial_number', 'expiration_date',
      'status', 'created_by', 'approved_by', 'approved_at'
    ];
    for (const col of columns) {
      await queryInterface.sequelize.query(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS "${col}"`);
    }
  }
};
