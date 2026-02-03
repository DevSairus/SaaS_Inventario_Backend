const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: false,
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    dialectOptions: {
      decimalNumbers: true
    }
  }
);

const testConnection = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Conexión a PostgreSQL establecida');
    return true;
  } catch (error) {
    console.error('❌ Error al conectar a PostgreSQL:');
    console.error('   Mensaje:', error.message);
    console.error('   Host:', process.env.DB_HOST);
    console.error('   Puerto:', process.env.DB_PORT);
    console.error('   Base de datos:', process.env.DB_NAME);
    console.error('   Usuario:', process.env.DB_USER);
    console.error('');
    console.error('   Error completo:', error);
    return false;
  }
};

module.exports = {
  sequelize,
  testConnection
};