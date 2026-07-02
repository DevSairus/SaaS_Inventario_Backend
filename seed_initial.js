/**
 * Seed inicial — Superadmin + Tenant + Config DIAN + Datos de prueba
 * Ejecutar: node seed_initial.js
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const {sequelize} = require('./src/config/database');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SEED INICIAL — Pitbox');
  console.log('═══════════════════════════════════════════════════════════\n');

  await sequelize.authenticate();

  // ═══════════════════════════════════════════════════════════
  // 1. TENANT
  // ═══════════════════════════════════════════════════════════
  const tenantNit = '901724902';
  const [existingTenant] = await sequelize.query(
    `SELECT id FROM tenants WHERE tax_id = '${tenantNit}'`
  );

  let tenantId;
  if (existingTenant.length) {
    tenantId = existingTenant[0].id;
    console.log('✅ Tenant ya existe:', tenantId);
  } else {
    // Cargar certificado P12
    const p12Path = path.join(__dirname, '901724902.p12');
    let certBase64 = '';
    if (fs.existsSync(p12Path)) {
      certBase64 = fs.readFileSync(p12Path).toString('base64');
    }

    const dianConfig = {
      nit: '901724902',
      dv: '4',
      company_name: 'THE CLASSIC MACHINES S.A.S',
      software_id: 'ba01684d-fab5-46de-adeb-91c13d3d0079',
      software_pin: '12345',
      software_provider_nit: '901724902',
      technical_key: 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c',
      test_set_id: '67b6fd40-91f9-47c8-86eb-886b2ee35b0b',
      environment: 'test',
      tax_level_code: 'O-13',
      regime_code: '48',
      city: 'Bogota',
      city_code: '11001',
      dept: 'Cundinamarca',
      address: 'AK 50 NO 39 A 94 SUR',
      phone: '3212924595',
      email: 'aguirre984@gmail.com',
      certificate_p12_base64: certBase64,
      certificate_password: 'sVEYguraLpHbdbav',
    };

    const [result] = await sequelize.query(`
      INSERT INTO tenants (
        id, company_name, slug, business_name, tax_id, email, phone, address,
        plan, subscription_status, max_users, max_clients, max_products,
        max_warehouses, max_invoices_per_month, is_active, dian_config,
        created_at, updated_at
      ) VALUES (
        gen_random_uuid(), 'THE CLASSIC MACHINES S.A.S', 'the-classic-machines',
        'THE CLASSIC MACHINES S.A.S', '${tenantNit}', 'aguirre984@gmail.com',
        '3212924595', 'AK 50 NO 39 A 94 SUR',
        'professional', 'active', 10, 1000, 1000,
        5, 10000, true, '${JSON.stringify(dianConfig)}'::jsonb,
        NOW(), NOW()
      ) RETURNING id
    `);
    tenantId = result[0].id;
    console.log('✅ Tenant creado:', tenantId);
  }

  // ═══════════════════════════════════════════════════════════
  // 2. SUPERADMIN (sin tenant — gestiona todo el sistema)
  // ═══════════════════════════════════════════════════════════
  const superadminEmail = 'superadmin@pitbox.com';
  const [existingSuper] = await sequelize.query(
    `SELECT id FROM users WHERE email = '${superadminEmail}'`
  );

  if (!existingSuper.length) {
    const passwordHash = await bcrypt.hash('SuperAdmin2026!', 10);
    await sequelize.query(`
      INSERT INTO users (
        id, tenant_id, email, password_hash, first_name, last_name,
        role, is_active, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), NULL, '${superadminEmail}', '${passwordHash}',
        'Sergio', 'Aguirre', 'super_admin', true, NOW(), NOW()
      )
    `);
    console.log('✅ Superadmin creado: superadmin@pitbox.com / SuperAdmin2026!');
  } else {
    console.log('✅ Superadmin ya existe:', superadminEmail);
  }

  // ═══════════════════════════════════════════════════════════
  // 3. ADMIN DEL TENANT
  // ═══════════════════════════════════════════════════════════
  const adminEmail = 'admin@pitbox.com';
  const [existingAdmin] = await sequelize.query(
    `SELECT id FROM users WHERE email = '${adminEmail}'`
  );

  if (!existingAdmin.length) {
    const passwordHash = await bcrypt.hash('Admin2026!', 10);
    await sequelize.query(`
      INSERT INTO users (
        id, tenant_id, email, password_hash, first_name, last_name,
        role, is_active, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), '${tenantId}', '${adminEmail}', '${passwordHash}',
        'Admin', 'Tenant', 'admin', true, NOW(), NOW()
      )
    `);
    console.log('✅ Admin tenant creado: admin@pitbox.com / Admin2026!');
  } else {
    console.log('✅ Admin tenant ya existe:', adminEmail);
  }

  // ═══════════════════════════════════════════════════════════
  // 3. RESOLUCIÓN DIAN
  // ═══════════════════════════════════════════════════════════
  const [existingRes] = await sequelize.query(`
    SELECT id FROM dian_resolutions 
    WHERE tenant_id = '${tenantId}' AND is_test = true AND is_active = true
  `);

  if (!existingRes.length) {
    await sequelize.query(`
      INSERT INTO dian_resolutions (
        id, tenant_id, resolution_number, resolution_date, prefix,
        from_number, to_number, current_number, valid_from, valid_to,
        document_type, is_active, is_test, notes, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), '${tenantId}', '18760000001', '2019-01-19', 'SETP',
        990000000, 995000000, 990000000, '2019-01-19', '2030-01-19',
        'invoice', true, true, 'Resolución oficial DIAN habilitación',
        NOW(), NOW()
      )
    `);
    console.log('✅ Resolución DIAN creada');
  } else {
    console.log('✅ Resolución DIAN ya existe');
  }

  // ═══════════════════════════════════════════════════════════
  // 4. CLIENTE DE PRUEBA
  // ═══════════════════════════════════════════════════════════
  const [existingCust] = await sequelize.query(`
    SELECT id FROM customers WHERE tenant_id = '${tenantId}' AND tax_id = '9017249024'
  `);

  if (!existingCust.length) {
    await sequelize.query(`
      INSERT INTO customers (
        id, tenant_id, customer_type, first_name, business_name, tax_id,
        email, phone, address, city, is_active, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), '${tenantId}', 'business', 'THE CLASSIC MACHINES',
        'THE CLASSIC MACHINES S.A.S', '9017249024',
        'aguirre984@gmail.com', '3212924595', 'AK 50 NO 39 A 94 SUR',
        'Bogota', true, NOW(), NOW()
      )
    `);
    console.log('✅ Cliente de prueba creado');
  } else {
    console.log('✅ Cliente de prueba ya existe');
  }

  // ═══════════════════════════════════════════════════════════
  // 5. PRODUCTO DE PRUEBA
  // ═══════════════════════════════════════════════════════════
  const [existingProd] = await sequelize.query(`
    SELECT id FROM products WHERE tenant_id = '${tenantId}' AND sku = 'SRV-001'
  `);

  if (!existingProd.length) {
    await sequelize.query(`
      INSERT INTO products (
        id, tenant_id, name, description, sale_price, tax_rate, sku,
        is_active, is_for_sale, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), '${tenantId}', 'Servicio de Consultoria',
        'Servicio de consultoria general con IVA 19%', 150000, 19, 'SRV-001',
        true, true, NOW(), NOW()
      )
    `);
    console.log('✅ Producto de prueba creado');
  } else {
    console.log('✅ Producto de prueba ya existe');
  }

  // ═══════════════════════════════════════════════════════════
  // RESUMEN
  // ═══════════════════════════════════════════════════════════
  const [summary] = await sequelize.query(`
    SELECT 
      (SELECT COUNT(*) FROM tenants WHERE tax_id = '${tenantNit}') as tenants,
      (SELECT COUNT(*) FROM users WHERE role = 'super_admin') as superadmins,
      (SELECT COUNT(*) FROM users WHERE tenant_id = '${tenantId}') as tenant_users,
      (SELECT COUNT(*) FROM dian_resolutions WHERE tenant_id = '${tenantId}' AND is_active = true) as resoluciones,
      (SELECT COUNT(*) FROM customers WHERE tenant_id = '${tenantId}') as clientes,
      (SELECT COUNT(*) FROM products WHERE tenant_id = '${tenantId}') as productos,
      (SELECT COUNT(*) FROM dian_events WHERE tenant_id = '${tenantId}' AND status = 'accepted') as docs_dian
  `);

  const s = summary[0];
  console.log('\n═══ RESUMEN ═══');
  console.log(`Tenants:          ${s.tenants}`);
  console.log(`Superadmins:      ${s.superadmins}`);
  console.log(`Usuarios tenant:  ${s.tenant_users}`);
  console.log(`Resoluciones:     ${s.resoluciones}`);
  console.log(`Clientes:         ${s.clientes}`);
  console.log(`Productos:        ${s.productos}`);
  console.log(`Docs DIAN:        ${s.docs_dian}`);
  console.log('\n✅ Seed inicial completado.');
  console.log('\n═══ CREDENCIALES ═══');
  console.log('');
  console.log('  Superadmin (gestiona todo el sistema):');
  console.log('    Email:    superadmin@pitbox.com');
  console.log('    Password: SuperAdmin2026!');
  console.log('');
  console.log('  Admin Tenant (gestiona su negocio):');
  console.log('    Email:    admin@pitbox.com');
  console.log('    Password: Admin2026!');
  console.log('    NIT:      901724902-4');

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
