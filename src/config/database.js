require('dotenv').config();
const { Sequelize } = require('sequelize');

// ============================================================================
// IMPORTANTE: Pre-cargar el módulo pg antes de usarlo con Sequelize
// Esto resuelve el problema "Please install pg package manually" en Vercel
// ============================================================================
let pg;
try {
  pg = require('pg');
  console.log('✅ Módulo pg cargado correctamente');
} catch (err) {
  console.error('❌ Error cargando módulo pg:', err.message);
  // Intentar con pg-pool como fallback
  try {
    pg = require('pg-pool');
    console.log('✅ Módulo pg-pool cargado como fallback');
  } catch (err2) {
    console.error('❌ Error crítico: no se pudo cargar pg ni pg-pool');
  }
}

let sequelize;

// ============================================================================
// CONFIGURACIÓN PARA VERCEL + NEON INTEGRATION
// ============================================================================
const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';

if (DATABASE_URL) {
  // ============================================================================
  // PRODUCCIÓN: Usando Neon (via Vercel o externo)
  // ============================================================================
  
  console.log('🔧 Conectando a Neon PostgreSQL');
  console.log('📍 Variable usada:', process.env.POSTGRES_URL ? 'POSTGRES_URL' : 'DATABASE_URL');
  
  // Configuración específica para Vercel
  const dialectOptions = {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  };

  // Si estamos en Vercel, configuración adicional
  if (process.env.VERCEL) {
    console.log('🔧 Modo Vercel detectado - Configuración optimizada');
  }

  sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectModule: pg, // ← IMPORTANTE: Pasar explícitamente el módulo pg
    protocol: 'postgres',
    dialectOptions,
    
    // Logging
    logging: isProduction ? false : console.log,
    
    // Pool optimizado para Vercel Serverless
    pool: {
      max: 2,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    
    // Opciones de modelos
    define: {
      timestamps: true,
      underscored: false,
      freezeTableName: true
    }
  });
  
} else {
  // ============================================================================
  // DESARROLLO LOCAL: Usando PostgreSQL local
  // ============================================================================
  
  console.log('🔧 Conectando a PostgreSQL local (desarrollo)');
  
  const dbConfig = {
    database: process.env.DB_NAME || 'inventario_db',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432
  };
  
  sequelize = new Sequelize(
    dbConfig.database,
    dbConfig.username,
    dbConfig.password,
    {
      host: dbConfig.host,
      port: dbConfig.port,
      dialect: 'postgres',
      dialectModule: pg, // También en desarrollo
      logging: console.log,
      
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
      },
      
      define: {
        timestamps: true,
        underscored: false,
        freezeTableName: true
      }
    }
  );
}

/**
 * Probar la conexión a la base de datos
 */
async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ Conexión a PostgreSQL exitosa');
    console.log(`📍 Entorno: ${process.env.NODE_ENV || 'development'}`);
    
    // Información adicional solo en desarrollo
    if (!isProduction) {
      try {
        const [results] = await sequelize.query('SELECT version()');
        const version = results[0].version.split(' ').slice(0, 2).join(' ');
        console.log('📊 PostgreSQL Version:', version);
        
        // Mostrar tablas disponibles
        const [tables] = await sequelize.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          ORDER BY table_name
        `);
        
        if (tables.length > 0) {
          console.log(`📋 Tablas disponibles: ${tables.length}`);
          const tableNames = tables.slice(0, 5).map(t => t.table_name).join(', ');
          console.log('   ' + tableNames + (tables.length > 5 ? '...' : ''));
        } else {
          console.log('⚠️  No hay tablas. Ejecuta database-schema.sql');
        }
      } catch (err) {
        console.log('⚠️  No se pudo obtener información adicional');
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error conectando a PostgreSQL:');
    console.error('   Mensaje:', error.message);
    
    // Ayuda de debugging
    if (!isProduction) {
      console.error('\n💡 Verificaciones:');
      
      if (!DATABASE_URL) {
        console.error('   ❌ No se encontró POSTGRES_URL ni DATABASE_URL');
        console.error('   → Agrega la variable de entorno en Vercel');
      } else {
        console.error('   ✅ Variable de conexión encontrada');
      }
      
      console.error('   - ¿PostgreSQL está corriendo?');
      console.error('   - ¿Las credenciales son correctas?');
      console.error('   - ¿La base de datos existe?');
      console.error('   - ¿SSL está configurado correctamente?');
    }
    
    return false;
  }
}

/**
 * Sincronizar modelos con la base de datos
 * PRECAUCIÓN: Solo usar en desarrollo
 */
async function syncDatabase(options = {}) {
  try {
    const { force = false, alter = false } = options;
    
    if (isProduction) {
      console.warn('⚠️  No se debe usar sync() en producción');
      console.warn('   Usa migraciones SQL en su lugar');
      return false;
    }
    
    if (force) {
      console.warn('⚠️  ADVERTENCIA: force=true eliminará todas las tablas');
    }
    
    await sequelize.sync({ force, alter });
    console.log('✅ Modelos sincronizados con la base de datos');
    
    return true;
  } catch (error) {
    console.error('❌ Error sincronizando modelos:', error.message);
    return false;
  }
}

/**
 * Cerrar la conexión a la base de datos
 */
async function closeConnection() {
  try {
    await sequelize.close();
    console.log('✅ Conexión a PostgreSQL cerrada');
    return true;
  } catch (error) {
    console.error('❌ Error cerrando conexión:', error.message);
    return false;
  }
}

module.exports = {
  sequelize,
  testConnection,
  syncDatabase,
  closeConnection
};