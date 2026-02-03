const bcrypt = require('bcryptjs');
const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('inventario_db', 'postgres', 'postgres', {
  host: 'localhost',
  port: 5433,
  dialect: 'postgres',
  logging: false
});

async function createTenantAdmin() {
  try {
    console.log('═══════════════════════════════════════');
    console.log('  CREAR ADMIN DE TENANT');
    console.log('═══════════════════════════════════════\n');

    await sequelize.authenticate();
    console.log('✅ Conexión establecida\n');

    // Obtener el tenant "Empresa Demo"
    const [tenants] = await sequelize.query(`
      SELECT id, company_name FROM tenants WHERE slug = 'demo-company' LIMIT 1
    `);

    if (tenants.length === 0) {
      console.error('❌ No se encontró el tenant "demo-company"');
      console.log('Ejecuta primero: node src/seeders/seed-inventory-data.js');
      process.exit(1);
    }

    const tenantId = tenants[0].id;
    console.log(`📦 Tenant encontrado: ${tenants[0].company_name}`);
    console.log(`   ID: ${tenantId}\n`);

    // Verificar si ya existe
    const [existing] = await sequelize.query(`
      SELECT email FROM users WHERE email = 'admin@empresademo.com'
    `);

    if (existing.length > 0) {
      console.log('⚠️  Ya existe un usuario con email: admin@empresademo.com\n');
      process.exit(0);
    }

    // Crear usuario admin del tenant
    const passwordHash = await bcrypt.hash('demo123', 10);

    await sequelize.query(`
      INSERT INTO users (
        tenant_id, email, password_hash, first_name, last_name, 
        role, is_active, created_at, updated_at
      )
      VALUES (
        :tenant_id, :email, :password_hash, :first_name, :last_name,
        :role, TRUE, NOW(), NOW()
      )
    `, {
      replacements: {
        tenant_id: tenantId,
        email: 'admin@empresademo.com',
        password_hash: passwordHash,
        first_name: 'Administrador',
        last_name: 'Empresa Demo',
        role: 'admin'
      }
    });

    console.log('✅ Usuario Admin creado exitosamente!\n');
    console.log('═══════════════════════════════════════');
    console.log('  CREDENCIALES DE ACCESO');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log('  🏢 Empresa: Empresa Demo');
    console.log('  📧 Email:   admin@empresademo.com');
    console.log('  🔑 Password: demo123');
    console.log('  👤 Rol:     admin (del tenant)');
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log('💡 Este usuario puede gestionar productos,');
    console.log('   categorías, inventario, etc.\n');

    await sequelize.close();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

createTenantAdmin();