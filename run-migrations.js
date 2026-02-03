require('dotenv').config();
const { sequelize } = require('./src/config/database');

async function runMigrations() {
  try {
    console.log('🔄 Conectando a la base de datos...');
    console.log(`   Host: ${process.env.DB_HOST}`);
    console.log(`   DB: ${process.env.DB_NAME}`);
    console.log(`   User: ${process.env.DB_USER}`);
    console.log('');
    
    await sequelize.authenticate();
    console.log('✅ Conexión establecida');
    console.log('');

    console.log('🔄 Creando tablas de movimientos avanzados...');
    
    // 1. Customer Returns
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS customer_returns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        return_number VARCHAR(50) UNIQUE NOT NULL,
        sale_id UUID NOT NULL REFERENCES sales(id),
        customer_id UUID NOT NULL REFERENCES customers(id),
        return_date TIMESTAMP NOT NULL DEFAULT NOW(),
        reason VARCHAR(50) NOT NULL,
        notes TEXT,
        subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
        tax DECIMAL(15,2) NOT NULL DEFAULT 0,
        total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_by UUID REFERENCES users(id),
        approved_by UUID REFERENCES users(id),
        approved_at TIMESTAMP,
        rejected_by UUID REFERENCES users(id),
        rejected_at TIMESTAMP,
        rejection_reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS customer_return_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        return_id UUID NOT NULL REFERENCES customer_returns(id) ON DELETE CASCADE,
        sale_item_id UUID NOT NULL REFERENCES sale_items(id),
        product_id UUID NOT NULL REFERENCES products(id),
        quantity DECIMAL(15,2) NOT NULL,
        unit_price DECIMAL(15,2) NOT NULL,
        unit_cost DECIMAL(15,2) NOT NULL,
        condition VARCHAR(20) NOT NULL DEFAULT 'used',
        destination VARCHAR(20) NOT NULL DEFAULT 'inventory',
        subtotal DECIMAL(15,2) NOT NULL,
        tax DECIMAL(15,2) NOT NULL DEFAULT 0,
        total DECIMAL(15,2) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    console.log('   ✅ customer_returns');
    console.log('   ✅ customer_return_items');

    // 2. Supplier Returns
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS supplier_returns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        return_number VARCHAR(50) UNIQUE NOT NULL,
        purchase_id UUID NOT NULL REFERENCES purchases(id),
        supplier_id UUID NOT NULL REFERENCES suppliers(id),
        return_date TIMESTAMP NOT NULL DEFAULT NOW(),
        reason VARCHAR(50) NOT NULL,
        notes TEXT,
        subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
        tax DECIMAL(15,2) NOT NULL DEFAULT 0,
        total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        credit_note_number VARCHAR(50),
        created_by UUID REFERENCES users(id),
        approved_by UUID REFERENCES users(id),
        approved_at TIMESTAMP,
        rejected_by UUID REFERENCES users(id),
        rejected_at TIMESTAMP,
        rejection_reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS supplier_return_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        return_id UUID NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
        purchase_item_id UUID NOT NULL REFERENCES purchase_items(id),
        product_id UUID NOT NULL REFERENCES products(id),
        quantity DECIMAL(15,2) NOT NULL,
        unit_cost DECIMAL(15,2) NOT NULL,
        subtotal DECIMAL(15,2) NOT NULL,
        tax DECIMAL(15,2) NOT NULL DEFAULT 0,
        total DECIMAL(15,2) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    console.log('   ✅ supplier_returns');
    console.log('   ✅ supplier_return_items');

    // 3. Transfers
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        transfer_number VARCHAR(50) UNIQUE NOT NULL,
        from_warehouse_id UUID NOT NULL REFERENCES warehouses(id),
        to_warehouse_id UUID NOT NULL REFERENCES warehouses(id),
        transfer_date TIMESTAMP NOT NULL DEFAULT NOW(),
        sent_date TIMESTAMP,
        received_date TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        shipping_method VARCHAR(50),
        tracking_number VARCHAR(100),
        notes TEXT,
        shipping_notes TEXT,
        receiving_notes TEXT,
        created_by UUID REFERENCES users(id),
        sent_by UUID REFERENCES users(id),
        received_by UUID REFERENCES users(id),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS transfer_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transfer_id UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id),
        quantity_sent DECIMAL(15,2) NOT NULL,
        quantity_received DECIMAL(15,2),
        unit_cost DECIMAL(15,2) NOT NULL,
        condition VARCHAR(20),
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    console.log('   ✅ transfers');
    console.log('   ✅ transfer_items');

    // 4. Internal Consumptions
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS internal_consumptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        consumption_number VARCHAR(50) UNIQUE NOT NULL,
        warehouse_id UUID NOT NULL REFERENCES warehouses(id),
        department VARCHAR(100) NOT NULL,
        consumption_date TIMESTAMP NOT NULL DEFAULT NOW(),
        purpose VARCHAR(100),
        notes TEXT,
        total_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        requested_by UUID REFERENCES users(id),
        approved_by UUID REFERENCES users(id),
        approved_at TIMESTAMP,
        rejected_by UUID REFERENCES users(id),
        rejected_at TIMESTAMP,
        rejection_reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS internal_consumption_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        consumption_id UUID NOT NULL REFERENCES internal_consumptions(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id),
        quantity DECIMAL(15,2) NOT NULL,
        unit_cost DECIMAL(15,2) NOT NULL,
        total_cost DECIMAL(15,2) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    console.log('   ✅ internal_consumptions');
    console.log('   ✅ internal_consumption_items');

    // Crear índices UNO POR UNO
    console.log('');
    console.log('🔄 Creando índices...');

    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_customer_returns_tenant ON customer_returns(tenant_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_customer_returns_sale ON customer_returns(sale_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_supplier_returns_tenant ON supplier_returns(tenant_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_supplier_returns_purchase ON supplier_returns(purchase_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_transfers_tenant ON transfers(tenant_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_warehouse_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_warehouse_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_consumptions_tenant ON internal_consumptions(tenant_id);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_consumptions_warehouse ON internal_consumptions(warehouse_id);`);

    console.log('   ✅ Índices creados');
    console.log('');
    console.log('🎉 ¡Migración completada exitosamente!');
    console.log('');
    console.log('✅ Ahora puedes iniciar el servidor: npm run dev');

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('');
    console.error('Detalles:', error);
    process.exit(1);
  }
}

runMigrations();