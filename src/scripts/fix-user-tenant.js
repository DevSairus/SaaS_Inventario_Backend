/**
 * Script para asignar tenant_id a usuarios existentes sin tenant
 * Versión mejorada con SQL directo
 */

const { Pool } = require('pg');

// Configuración de la base de datos
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'inventario_db',
  password: 'postgres',
  port: 5433,
});

async function fixUsersTenants() {
  const client = await pool.connect();
  
  try {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  SCRIPT: Asignar tenant_id a usuarios');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('🔍 Conectando a la base de datos...');
    console.log('✅ Conexión exitosa\n');

    // 1. Verificar estructura de la tabla tenants
    console.log('📊 Verificando estructura de la tabla tenants...');
    const columnsResult = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tenants'
      ORDER BY ordinal_position;
    `);
    
    console.log('Columnas en la tabla tenants:');
    columnsResult.rows.forEach(col => {
      console.log(`   - ${col.column_name} (${col.data_type}) ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });
    console.log('');

    // 2. Verificar si existe la columna 'name'
    const hasNameColumn = columnsResult.rows.some(col => col.column_name === 'name');
    
    if (!hasNameColumn) {
      console.log('⚠️  La columna "name" no existe en la tabla tenants');
      console.log('📝 Agregando columna "name"...');
      
      await client.query(`
        ALTER TABLE tenants ADD COLUMN name VARCHAR(255);
      `);
      
      console.log('✅ Columna "name" agregada\n');
    }

    // 3. Buscar usuarios sin tenant_id
    const usersResult = await client.query(`
      SELECT id, email, first_name, last_name, tenant_id
      FROM users
      WHERE tenant_id IS NULL;
    `);

    if (usersResult.rows.length === 0) {
      console.log('✅ Todos los usuarios ya tienen tenant_id asignado');
      return;
    }

    console.log(`📊 Encontrados ${usersResult.rows.length} usuarios sin tenant_id:`);
    usersResult.rows.forEach(user => {
      console.log(`   - ${user.email} (${user.first_name} ${user.last_name})`);
    });
    console.log('');

    // 4. Buscar o crear tenant por defecto
    let tenantsResult = await client.query(`
      SELECT id, slug, is_active FROM tenants LIMIT 1;
    `);

    let defaultTenantId;

    if (tenantsResult.rows.length === 0) {
      console.log('📝 No existe ningún tenant, creando uno...');
      
      const createResult = await client.query(`
        INSERT INTO tenants (id, name, slug, is_active, created_at, updated_at)
        VALUES (
          gen_random_uuid(),
          'Empresa Principal',
          'empresa-principal',
          true,
          NOW(),
          NOW()
        )
        RETURNING id, name, slug;
      `);
      
      defaultTenantId = createResult.rows[0].id;
      console.log(`✅ Tenant creado: ${createResult.rows[0].name || createResult.rows[0].slug} (ID: ${defaultTenantId})\n`);
    } else {
      defaultTenantId = tenantsResult.rows[0].id;
      
      // Actualizar el nombre si no existe
      if (!hasNameColumn) {
        await client.query(`
          UPDATE tenants 
          SET name = 'Empresa Principal'
          WHERE id = $1 AND (name IS NULL OR name = '');
        `, [defaultTenantId]);
      }
      
      console.log(`✅ Usando tenant existente (ID: ${defaultTenantId})\n`);
    }

    // 5. Asignar tenant_id a usuarios
    console.log('🔧 Asignando tenant_id a usuarios...');
    let updated = 0;

    for (const user of usersResult.rows) {
      await client.query(`
        UPDATE users
        SET tenant_id = $1, updated_at = NOW()
        WHERE id = $2;
      `, [defaultTenantId, user.id]);
      
      console.log(`   ✓ ${user.email} → tenant_id asignado`);
      updated++;
    }

    console.log(`\n✅ Proceso completado: ${updated} usuarios actualizados`);
    console.log(`\n📋 Resumen:`);
    console.log(`   - Tenant ID: ${defaultTenantId}`);
    console.log(`   - Usuarios actualizados: ${updated}`);
    console.log('\n⚠️  IMPORTANTE: Debes cerrar sesión y volver a iniciar sesión');
    console.log('   para que el nuevo tenant_id se refleje en el token JWT\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    client.release();
    await pool.end();
  }
}

// Ejecutar el script
fixUsersTenants().then(() => {
  console.log('═══════════════════════════════════════════════════════');
  process.exit(0);
}).catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});