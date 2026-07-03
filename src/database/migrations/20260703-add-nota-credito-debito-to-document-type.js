'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Columnas que pueden faltar en la tabla sales (modelos vs BD)
    const columns = [
      // DIAN
      { name: 'dian_status', type: 'VARCHAR(30)' },
      { name: 'dian_invoice_number', type: 'VARCHAR(50)' },
      { name: 'cufe', type: 'VARCHAR(255)' },
      { name: 'dian_response', type: 'JSONB' },
      { name: 'dian_sent_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { name: 'dian_accepted_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { name: 'dian_error_message', type: 'TEXT' },
      // Vehículo
      { name: 'vehicle_brand', type: 'VARCHAR(100)' },
      { name: 'vehicle_model', type: 'VARCHAR(100)' },
      { name: 'vehicle_year', type: 'INTEGER' },
      { name: 'vehicle_color', type: 'VARCHAR(50)' },
      // Liquidaciones
      { name: 'product_settled_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { name: 'product_settlement_id', type: 'UUID' },
      { name: 'labor_settled_at', type: 'TIMESTAMP WITH TIME ZONE' },
      { name: 'labor_settlement_id', type: 'UUID' },
      // Técnico
      { name: 'technician_id', type: 'UUID' },
      { name: 'technician_name', type: 'VARCHAR(255)' },
    ];

    for (const col of columns) {
      try {
        await queryInterface.sequelize.query(`
          ALTER TABLE sales ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}
        `);
        console.log(`[Migration] Columna ${col.name} OK`);
      } catch (e) {
        if (e.message.includes('already exists')) {
          console.log(`[Migration] ${col.name} ya existe`);
        } else {
          throw e;
        }
      }
    }

    // Default para dian_status
    try {
      await queryInterface.sequelize.query(`
        ALTER TABLE sales ALTER COLUMN dian_status SET DEFAULT 'not_applicable'
      `);
    } catch (e) { /* ignorar si ya existe */ }

    // Índice para búsquedas por dian_status
    try {
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_sales_dian_status ON sales (tenant_id, dian_status)
      `);
      console.log('[Migration] Índice idx_sales_dian_status OK');
    } catch (e) { /* ignorar */ }

    // Actualizar CHECK constraint de document_type para incluir nota_credito y nota_debito
    try {
      // Eliminar constraint existente si existe
      const [constraints] = await queryInterface.sequelize.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'sales'::regclass AND contype = 'c'
        AND conname LIKE '%document_type%'
      `);
      for (const c of constraints) {
        await queryInterface.sequelize.query(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS "${c.conname}"`);
      }
      // Crear nuevo constraint con todos los valores válidos
      await queryInterface.sequelize.query(`
        ALTER TABLE sales ADD CONSTRAINT sales_document_type_check
        CHECK (document_type IN ('remision', 'factura', 'cotizacion', 'nota_credito', 'nota_debito'))
      `);
      console.log('[Migration] CHECK constraint document_type actualizado');
    } catch (e) {
      console.log('[Migration] CHECK constraint:', e.message);
    }

    // Agregar technician_id a sale_items si falta
    try {
      await queryInterface.sequelize.query(`
        ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS "technician_id" UUID
      `);
      console.log('[Migration] sale_items.technician_id OK');
    } catch (e) { /* ignorar */ }
  },

  async down(queryInterface, Sequelize) {
    // Restaurar CHECK constraint original
    try {
      await queryInterface.sequelize.query(`ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_document_type_check`);
      await queryInterface.sequelize.query(`
        ALTER TABLE sales ADD CONSTRAINT sales_document_type_check
        CHECK (document_type IN ('remision', 'factura', 'cotizacion'))
      `);
    } catch (e) { /* ignorar */ }

    // Remover columnas agregadas
    const columns = [
      'dian_status', 'dian_invoice_number', 'cufe', 'dian_response',
      'dian_sent_at', 'dian_accepted_at', 'dian_error_message',
      'vehicle_brand', 'vehicle_model', 'vehicle_year', 'vehicle_color',
      'product_settled_at', 'product_settlement_id',
      'labor_settled_at', 'labor_settlement_id',
      'technician_id', 'technician_name',
    ];
    for (const col of columns) {
      await queryInterface.sequelize.query(`ALTER TABLE sales DROP COLUMN IF EXISTS "${col}"`);
    }
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_sales_dian_status`);
    await queryInterface.sequelize.query(`ALTER TABLE sale_items DROP COLUMN IF EXISTS "technician_id"`);
  }
};
