const { Sequelize } = require('sequelize');

// USAR POSTGRES (superusuario) para bypassear RLS
const sequelize = new Sequelize('inventario_db', 'postgres', 'postgres', {
  host: 'localhost',
  port: 5433,
  dialect: 'postgres',
  logging: false
});

async function seedData() {
  try {
    console.log('═══════════════════════════════════════');
    console.log('  SEED DE DATOS DE INVENTARIO');
    console.log('═══════════════════════════════════════\n');

    await sequelize.authenticate();
    console.log('✅ Conexión establecida\n');

    // 0. PLANES DE SUSCRIPCIÓN (deben existir antes que los tenants)
    console.log('📋 Paso 0/6: Creando planes de suscripción...');

    const subscriptionPlans = [
      {
        name: 'Free',
        slug: 'free',
        description: 'Plan gratuito con funcionalidad básica',
        monthly_price: 0,
        yearly_price: 0,
        max_users: 2,
        max_clients: 20,
        max_invoices_per_month: 10,
        max_storage_mb: 50,
        features: { basic_reports: true, advanced_reports: false, barcode_scanner: false, multi_warehouse: false, api_access: false },
        is_active: true,
        is_popular: false,
        sort_order: 0,
        trial_days: 0
      },
      {
        name: 'Basic',
        slug: 'basic',
        description: 'Plan básico para empresas pequeñas',
        monthly_price: 99000,
        yearly_price: 990000,
        max_users: 5,
        max_clients: 100,
        max_invoices_per_month: 100,
        max_storage_mb: 500,
        features: { basic_reports: true, advanced_reports: false, barcode_scanner: true, multi_warehouse: false, api_access: false },
        is_active: true,
        is_popular: false,
        sort_order: 1,
        trial_days: 14
      },
      {
        name: 'Premium',
        slug: 'premium',
        description: 'Plan premium con funcionalidades avanzadas',
        monthly_price: 249000,
        yearly_price: 2490000,
        max_users: 15,
        max_clients: 500,
        max_invoices_per_month: 500,
        max_storage_mb: 2000,
        features: { basic_reports: true, advanced_reports: true, barcode_scanner: true, multi_warehouse: true, api_access: false },
        is_active: true,
        is_popular: true,
        sort_order: 2,
        trial_days: 14
      },
      {
        name: 'Enterprise',
        slug: 'enterprise',
        description: 'Plan enterprise para grandes empresas',
        monthly_price: 599000,
        yearly_price: 5990000,
        max_users: 100,
        max_clients: 5000,
        max_invoices_per_month: 2000,
        max_storage_mb: 10000,
        features: { basic_reports: true, advanced_reports: true, barcode_scanner: true, multi_warehouse: true, api_access: true },
        is_active: true,
        is_popular: false,
        sort_order: 3,
        trial_days: 30
      }
    ];

    const planIds = {};

    for (const plan of subscriptionPlans) {
      const [existing] = await sequelize.query(`
        SELECT id FROM subscription_plans WHERE slug = :slug
      `, { replacements: { slug: plan.slug } });

      if (existing.length === 0) {
        const [result] = await sequelize.query(`
          INSERT INTO subscription_plans (
            name, slug, description, monthly_price, yearly_price,
            max_users, max_clients, max_invoices_per_month, max_storage_mb,
            features, is_active, is_popular, sort_order, trial_days,
            created_at, updated_at
          )
          VALUES (
            :name, :slug, :description, :monthly_price, :yearly_price,
            :max_users, :max_clients, :max_invoices_per_month, :max_storage_mb,
            :features, :is_active, :is_popular, :sort_order, :trial_days,
            NOW(), NOW()
          )
          RETURNING id
        `, {
          replacements: {
            ...plan,
            features: JSON.stringify(plan.features)
          }
        });
        planIds[plan.slug] = result[0].id;
        console.log(`   ✓ Plan ${plan.name} (COP ${plan.monthly_price.toLocaleString()}/mes)`);
      } else {
        planIds[plan.slug] = existing[0].id;
        console.log(`   - Plan ${plan.name} (ya existe)`);
      }
    }

    // 1. OBTENER O CREAR TENANT
    console.log('\n📦 Paso 1/6: Verificando tenant...');
    
    let [tenants] = await sequelize.query(`
      SELECT id, company_name FROM tenants WHERE slug = 'demo-company' LIMIT 1
    `);

    let tenantId;

    if (tenants.length === 0) {
      const [result] = await sequelize.query(`
        INSERT INTO tenants (
          company_name, slug, business_name, email, phone, is_active, 
          plan, subscription_status, created_at, updated_at
        )
        VALUES (
          'Empresa Demo', 'demo-company', 'Empresa Demo S.A.S.', 
          'admin@empresademo.com', '3001234567', TRUE,
          'basic', 'active', NOW(), NOW()
        )
        RETURNING id
      `);
      tenantId = result[0].id;
      console.log('   ✓ Tenant creado: Empresa Demo');
    } else {
      tenantId = tenants[0].id;
      console.log(`   ✓ Tenant existe: ${tenants[0].company_name}`);
    }

    // 1b. CREAR SUSCRIPCIÓN DEL TENANT
    const basicPlanId = planIds['basic'];
    if (basicPlanId) {
      const [existingSub] = await sequelize.query(`
        SELECT id FROM tenant_subscriptions WHERE tenant_id = :tenant_id
      `, { replacements: { tenant_id: tenantId } });

      if (existingSub.length === 0) {
        await sequelize.query(`
          INSERT INTO tenant_subscriptions (
            tenant_id, plan_id, status, billing_cycle, amount, currency,
            starts_at, current_period_start, current_period_end,
            next_billing_date, auto_renew,
            created_at, updated_at
          )
          VALUES (
            :tenant_id, :plan_id, 'active', 'monthly', 99000, 'COP',
            NOW(), NOW(), NOW() + INTERVAL '1 month',
            NOW() + INTERVAL '1 month', TRUE,
            NOW(), NOW()
          )
        `, { replacements: { tenant_id: tenantId, plan_id: basicPlanId } });
        console.log('   ✓ Suscripción creada (Basic - activa)');
      } else {
        console.log('   - Suscripción ya existe');
      }
    }

    // 2. CATEGORÍAS
    console.log('\n📂 Paso 2/6: Creando categorías...');
    
    const categories = [
      { name: 'Electrónica', description: 'Productos electrónicos y tecnología' },
      { name: 'Ropa', description: 'Prendas de vestir y accesorios' },
      { name: 'Alimentos', description: 'Productos alimenticios' },
      { name: 'Hogar', description: 'Artículos para el hogar' },
      { name: 'Deportes', description: 'Equipos y accesorios deportivos' }
    ];

    const categoryIds = {};

    for (const cat of categories) {
      const [existing] = await sequelize.query(`
        SELECT id, name FROM categories 
        WHERE tenant_id = :tenant_id AND name = :name
      `, {
        replacements: { tenant_id: tenantId, name: cat.name }
      });

      if (existing.length === 0) {
        const [result] = await sequelize.query(`
          INSERT INTO categories (tenant_id, name, description, is_active, created_at, updated_at)
          VALUES (:tenant_id, :name, :description, TRUE, NOW(), NOW())
          RETURNING id
        `, {
          replacements: { tenant_id: tenantId, ...cat }
        });
        categoryIds[cat.name] = result[0].id;
        console.log(`   ✓ ${cat.name}`);
      } else {
        categoryIds[cat.name] = existing[0].id;
        console.log(`   - ${cat.name} (ya existe)`);
      }
    }

    // 3. BODEGAS
    console.log('\n🏢 Paso 3/6: Creando bodegas...');
    
    const warehouses = [
      { code: 'BOD-001', name: 'Bodega Principal', city: 'Medellín', is_main: true },
      { code: 'BOD-002', name: 'Bodega Norte', city: 'Bello', is_main: false },
      { code: 'BOD-003', name: 'Bodega Sur', city: 'Envigado', is_main: false }
    ];

    for (const wh of warehouses) {
      const [existing] = await sequelize.query(`
        SELECT id FROM warehouses WHERE tenant_id = :tenant_id AND code = :code
      `, {
        replacements: { tenant_id: tenantId, code: wh.code }
      });

      if (existing.length === 0) {
        await sequelize.query(`
          INSERT INTO warehouses (tenant_id, code, name, city, is_main, is_active, created_at, updated_at)
          VALUES (:tenant_id, :code, :name, :city, :is_main, TRUE, NOW(), NOW())
        `, {
          replacements: { tenant_id: tenantId, ...wh }
        });
        console.log(`   ✓ ${wh.name}`);
      } else {
        console.log(`   - ${wh.name} (ya existe)`);
      }
    }

    // 4. PROVEEDORES
    console.log('\n🏭 Paso 4/6: Creando proveedores...');
    
    const suppliers = [
      { 
        business_name: 'Tech Supply S.A.S.', 
        trade_name: 'Tech Supply',
        email: 'ventas@techsupply.com', 
        phone: '3001234567',
        contact_name: 'Juan Pérez',
        payment_terms: 30
      },
      { 
        business_name: 'Distribuidora Central', 
        trade_name: 'Dist Central',
        email: 'info@distcentral.com', 
        phone: '3007654321',
        contact_name: 'María García',
        payment_terms: 15
      },
      { 
        business_name: 'Importaciones Global', 
        trade_name: 'Global Import',
        email: 'contacto@global.com', 
        phone: '3009876543',
        contact_name: 'Carlos López',
        payment_terms: 45
      }
    ];

    for (const sup of suppliers) {
      const [existing] = await sequelize.query(`
        SELECT id FROM suppliers WHERE tenant_id = :tenant_id AND business_name = :business_name
      `, {
        replacements: { tenant_id: tenantId, business_name: sup.business_name }
      });

      if (existing.length === 0) {
        await sequelize.query(`
          INSERT INTO suppliers (
            tenant_id, business_name, trade_name, email, phone, 
            contact_name, payment_terms, is_active, created_at, updated_at
          )
          VALUES (
            :tenant_id, :business_name, :trade_name, :email, :phone,
            :contact_name, :payment_terms, TRUE, NOW(), NOW()
          )
        `, {
          replacements: { tenant_id: tenantId, ...sup }
        });
        console.log(`   ✓ ${sup.business_name}`);
      } else {
        console.log(`   - ${sup.business_name} (ya existe)`);
      }
    }

    // 5. PRODUCTOS
    console.log('\n📦 Paso 5/6: Creando productos...');
    
    const products = [
      { sku: 'ELEC-001', barcode: '7501234567890', name: 'Laptop Dell Inspiron 15', description: 'Laptop Dell con procesador Intel i5', category: 'Electrónica', cost: 2500000, price: 3250000, margin: 30, stock: 15 },
      { sku: 'ELEC-002', barcode: '7501234567891', name: 'Mouse Logitech MX Master 3', description: 'Mouse inalámbrico ergonómico', category: 'Electrónica', cost: 150000, price: 195000, margin: 30, stock: 50 },
      { sku: 'ELEC-003', barcode: '7501234567892', name: 'Teclado Mecánico RGB', description: 'Teclado mecánico con iluminación RGB', category: 'Electrónica', cost: 200000, price: 260000, margin: 30, stock: 30 },
      { sku: 'ROPA-001', barcode: '7502234567890', name: 'Camiseta Básica Algodón', description: 'Camiseta de algodón 100%', category: 'Ropa', cost: 25000, price: 45000, margin: 80, stock: 100 },
      { sku: 'ROPA-002', barcode: '7502234567891', name: 'Jeans Clásicos', description: 'Jeans de mezclilla azul', category: 'Ropa', cost: 60000, price: 120000, margin: 100, stock: 75 },
      { sku: 'ALIM-001', barcode: '7503234567890', name: 'Café Premium 500g', description: 'Café colombiano de exportación', category: 'Alimentos', cost: 18000, price: 27000, margin: 50, stock: 200 },
      { sku: 'ALIM-002', barcode: '7503234567891', name: 'Chocolate Premium 100g', description: 'Chocolate oscuro 70% cacao', category: 'Alimentos', cost: 8000, price: 14000, margin: 75, stock: 150 },
      { sku: 'HOGA-001', barcode: '7504234567890', name: 'Juego de Sábanas King', description: 'Sábanas de algodón egipcio', category: 'Hogar', cost: 80000, price: 144000, margin: 80, stock: 40 },
      { sku: 'HOGA-002', barcode: '7504234567891', name: 'Lámpara LED de Escritorio', description: 'Lámpara LED regulable', category: 'Hogar', cost: 35000, price: 52500, margin: 50, stock: 60 },
      { sku: 'DEPO-001', barcode: '7505234567890', name: 'Balón de Fútbol Profesional', description: 'Balón de fútbol tamaño oficial', category: 'Deportes', cost: 50000, price: 85000, margin: 70, stock: 45 },
      { sku: 'DEPO-002', barcode: '7505234567891', name: 'Pesas Ajustables 20kg', description: 'Set de pesas ajustables', category: 'Deportes', cost: 120000, price: 180000, margin: 50, stock: 25 }
    ];

    let created = 0;
    let existing = 0;

    for (const prod of products) {
      const catId = categoryIds[prod.category];
      
      const [check] = await sequelize.query(`
        SELECT id FROM products WHERE tenant_id = :tenant_id AND sku = :sku
      `, {
        replacements: { tenant_id: tenantId, sku: prod.sku }
      });

      if (check.length === 0) {
        await sequelize.query(`
          INSERT INTO products (
            tenant_id, category_id, sku, barcode, name, description,
            unit_of_measure, average_cost, sale_price, base_price,
            profit_margin_percentage, current_stock, min_stock, 
            track_inventory, is_active, is_for_sale, is_for_purchase,
            created_at, updated_at
          )
          VALUES (
            :tenant_id, :category_id, :sku, :barcode, :name, :description,
            'unit', :cost, :price, :price,
            :margin, :stock, 10,
            TRUE, TRUE, TRUE, TRUE,
            NOW(), NOW()
          )
        `, {
          replacements: {
            tenant_id: tenantId,
            category_id: catId,
            sku: prod.sku,
            barcode: prod.barcode,
            name: prod.name,
            description: prod.description,
            cost: prod.cost,
            price: prod.price,
            margin: prod.margin,
            stock: prod.stock
          }
        });
        console.log(`   ✓ ${prod.name}`);
        created++;
      } else {
        console.log(`   - ${prod.name} (ya existe)`);
        existing++;
      }
    }

    console.log('\n═══════════════════════════════════════');
    console.log('  RESUMEN');
    console.log('═══════════════════════════════════════');
    console.log(`✅ Planes de suscripción: ${subscriptionPlans.length}`);
    console.log(`✅ Tenant: Empresa Demo (con suscripción Basic)`);
    console.log(`✅ Categorías: ${categories.length}`);
    console.log(`✅ Bodegas: ${warehouses.length}`);
    console.log(`✅ Proveedores: ${suppliers.length}`);
    console.log(`✅ Productos creados: ${created}`);
    if (existing > 0) {
      console.log(`ℹ️  Productos existentes: ${existing}`);
    }
    console.log('═══════════════════════════════════════\n');

    await sequelize.close();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

seedData();