// backend/src/seeders/create-superadmin-v2.js
const bcrypt = require('bcryptjs');
const { Sequelize, DataTypes } = require('sequelize');
const path = require('path');

// Cargar dotenv
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

console.log('═══════════════════════════════════════');
console.log('  CREAR SUPER ADMIN - Sistema Inventario');
console.log('═══════════════════════════════════════\n');

// Mostrar configuración (debug)
console.log('📋 Configuración detectada:');
console.log('   DB_HOST:', process.env.DB_HOST);
console.log('   DB_PORT:', process.env.DB_PORT);
console.log('   DB_NAME:', process.env.DB_NAME);
console.log('   DB_USER:', process.env.DB_USER);
console.log('   DB_PASSWORD:', process.env.DB_PASSWORD ? '✓ (longitud: ' + process.env.DB_PASSWORD.length + ')' : '✗ NO CONFIGURADO');
console.log('');

// Verificar que el password sea válido
if (!process.env.DB_PASSWORD || typeof process.env.DB_PASSWORD !== 'string') {
  console.error('❌ ERROR: DB_PASSWORD no está configurado correctamente en .env\n');
  console.error('El archivo .env debe contener:');
  console.error('DB_PASSWORD=Inventario2026\n');
  console.error('(Sin comillas, sin espacios)\n');
  process.exit(1);
}

// Crear conexión con Sequelize
const sequelize = new Sequelize(
  process.env.DB_NAME || 'inventario_db',
  process.env.DB_USER || 'inventario_user',
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5433', 10),
    dialect: 'postgres',
    logging: false // Desactivar logs de SQL
  }
);

// Definir modelo User
const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  password_hash: {
    type: DataTypes.STRING,
    allowNull: false
  },
  first_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  last_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  role: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'user'
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  last_login: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'users',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

async function createSuperAdmin() {
  try {
    // Paso 1: Probar conexión
    console.log('🔄 Paso 1/4: Probando conexión a PostgreSQL...');
    await sequelize.authenticate();
    console.log('✅ Conexión establecida\n');

    // Paso 2: Sincronizar modelo
    console.log('🔄 Paso 2/4: Sincronizando modelo User...');
    await User.sync();
    console.log('✅ Modelo sincronizado\n');

    // Paso 3: Verificar si ya existe
    console.log('🔄 Paso 3/4: Verificando usuarios existentes...');
    const existingSuperAdmin = await User.findOne({
      where: { 
        email: 'admin@inventario.com'
      }
    });

    if (existingSuperAdmin) {
      console.log('⚠️  Ya existe un usuario con email: admin@inventario.com');
      console.log('   Nombre:', existingSuperAdmin.first_name, existingSuperAdmin.last_name);
      console.log('   Rol:', existingSuperAdmin.role);
      console.log('\n💡 Si deseas crear otro admin, usa un email diferente\n');
      await sequelize.close();
      process.exit(0);
    }

    console.log('✅ No hay usuarios con ese email\n');

    // Paso 4: Crear super admin
    console.log('🔄 Paso 4/4: Creando Super Admin...');
    
    const passwordHash = await bcrypt.hash('admin123', 10);
    
    const superAdmin = await User.create({
      email: 'admin@inventario.com',
      password_hash: passwordHash,
      first_name: 'Super',
      last_name: 'Admin',
      role: 'super_admin',
      is_active: true,
      tenant_id: null
    });

    console.log('✅ Super Admin creado exitosamente!\n');
    console.log('═══════════════════════════════════════');
    console.log('  CREDENCIALES DE ACCESO');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log('  📧 Email:    admin@inventario.com');
    console.log('  🔑 Password: admin123');
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log('⚠️  IMPORTANTE: Cambiar el password después del primer login\n');

    await sequelize.close();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    
    if (error.name === 'SequelizeConnectionError') {
      console.error('\n🔍 Error de conexión. Verifica:');
      console.error('   1. PostgreSQL está corriendo');
      console.error('   2. El puerto 5433 es correcto');
      console.error('   3. El usuario "inventario_user" existe');
      console.error('   4. El password es correcto');
      console.error('   5. La base de datos "inventario_db" existe\n');
    }
    
    if (error.message.includes('password')) {
      console.error('\n🔍 Problema con el password:');
      console.error('   Verifica que en .env esté sin comillas:');
      console.error('   DB_PASSWORD=Inventario2026\n');
    }

    if (error.name === 'SequelizeUniqueConstraintError') {
      console.error('\n🔍 El email ya existe en la base de datos\n');
    }
    
    console.error('\nError completo para debugging:');
    console.error(error);
    
    await sequelize.close();
    process.exit(1);
  }
}

// Ejecutar
createSuperAdmin();