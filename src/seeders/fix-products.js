const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('inventario_db', 'inventario_user', 'Inventario2026', {
  host: 'localhost',
  port: 5433,
  dialect: 'postgres',
  logging: false
});

async function fix() {
  try {
    console.log('🗑️  ELIMINANDO productos antiguos...');
    await sequelize.query('DELETE FROM products');
    
    console.log('🗑️  ELIMINANDO categorías antiguas...');
    await sequelize.query('DELETE FROM categories');
    
    console.log('📦 Obteniendo tenant...');
    const [tenants] = await sequelize.query("SELECT id FROM tenants WHERE slug = 'demo-company' LIMIT 1");
    const tenantId = tenants[0].id;
    
    console.log(`✅ Tenant ID: ${tenantId}\n`);
    
    // Crear categorías
    console.log('📂 Creando categorías...');
    const categories = {
      'Electrónica': null,
      'Ropa': null,
      'Alimentos': null,
      'Hogar': null,
      'Deportes': null
    };
    
    for (const name of Object.keys(categories)) {
      const [result] = await sequelize.query(`
        INSERT INTO categories (tenant_id, name, is_active, created_at, updated_at)
        VALUES (:tenant_id, :name, TRUE, NOW(), NOW())
        RETURNING id
      `, { replacements: { tenant_id: tenantId, name } });
      categories[name] = result[0].id;
      console.log(`   ✓ ${name}`);
    }
    
    // Crear productos
    console.log('\n📦 Creando productos...');
    const products = [
      { sku: 'ELEC-001', name: 'Laptop Dell Inspiron 15', category: 'Electrónica', cost: 2500000, price: 3250000, stock: 15 },
      { sku: 'ELEC-002', name: 'Mouse Logitech MX Master 3', category: 'Electrónica', cost: 150000, price: 195000, stock: 50 },
      { sku: 'ELEC-003', name: 'Teclado Mecánico RGB', category: 'Electrónica', cost: 200000, price: 260000, stock: 30 },
      { sku: 'ROPA-001', name: 'Camiseta Básica Algodón', category: 'Ropa', cost: 25000, price: 45000, stock: 100 },
      { sku: 'ROPA-002', name: 'Jeans Clásicos', category: 'Ropa', cost: 60000, price: 120000, stock: 75 },
      { sku: 'ALIM-001', name: 'Café Premium 500g', category: 'Alimentos', cost: 18000, price: 27000, stock: 200 },
      { sku: 'ALIM-002', name: 'Chocolate Premium 100g', category: 'Alimentos', cost: 8000, price: 14000, stock: 150 },
      { sku: 'HOGA-001', name: 'Juego de Sábanas King', category: 'Hogar', cost: 80000, price: 144000, stock: 40 },
      { sku: 'HOGA-002', name: 'Lámpara LED de Escritorio', category: 'Hogar', cost: 35000, price: 52500, stock: 60 },
      { sku: 'DEPO-001', name: 'Balón de Fútbol Profesional', category: 'Deportes', cost: 50000, price: 85000, stock: 45 },
      { sku: 'DEPO-002', name: 'Pesas Ajustables 20kg', category: 'Deportes', cost: 120000, price: 180000, stock: 25 }
    ];
    
    for (const p of products) {
      await sequelize.query(`
        INSERT INTO products (
          tenant_id, category_id, sku, name, unit_of_measure,
          average_cost, sale_price, base_price, current_stock, min_stock,
          track_inventory, is_active, is_for_sale, is_for_purchase,
          created_at, updated_at
        ) VALUES (
          :tenant_id, :category_id, :sku, :name, 'unit',
          :cost, :price, :price, :stock, 10,
          TRUE, TRUE, TRUE, TRUE,
          NOW(), NOW()
        )
      `, {
        replacements: {
          tenant_id: tenantId,
          category_id: categories[p.category],
          sku: p.sku,
          name: p.name,
          cost: p.cost,
          price: p.price,
          stock: p.stock
        }
      });
      console.log(`   ✓ ${p.name}`);
    }
    
    console.log('\n✅ COMPLETADO - 11 productos creados para el tenant correcto\n');
    await sequelize.close();
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

fix();