// test-db-connection.js
// Script de prueba con credenciales hardcodeadas
const { Sequelize } = require('sequelize');

console.log('🔍 Probando conexión a PostgreSQL...\n');

// Credenciales hardcodeadas para prueba
const sequelize = new Sequelize('inventario_db', 'inventario_user', 'Inventario2026', {
  host: 'localhost',
  port: 5433, // Tu puerto personalizado
  dialect: 'postgres',
  logging: false
});

async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ ¡Conexión exitosa a PostgreSQL!');
    console.log('📊 Datos de conexión:');
    console.log('   Host: localhost');
    console.log('   Puerto: 5433');
    console.log('   Base de datos: inventario_db');
    console.log('   Usuario: inventario_user');
    console.log('   Password: Inventario2026');
    console.log('\n✅ Las credenciales son correctas');
    
    // Probar consulta
    const [results] = await sequelize.query('SELECT current_database(), current_user');
    console.log('\n📌 Información de la base de datos:');
    console.log('   Base de datos actual:', results[0].current_database);
    console.log('   Usuario actual:', results[0].current_user);
    
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error al conectar:', error.message);
    console.error('\n💡 Posibles causas:');
    console.error('   1. PostgreSQL no está corriendo');
    console.error('   2. El usuario "inventario_user" no existe');
    console.error('   3. El password es incorrecto');
    console.error('   4. La base de datos "inventario_db" no existe');
    console.error('   5. El puerto 5433 es incorrecto');
    console.error('\nError completo:', error);
    process.exit(1);
  }
}

testConnection();