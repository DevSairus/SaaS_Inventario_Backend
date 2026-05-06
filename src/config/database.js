const logger = require('./logger');
logger.debug('🔍 DEBUG - Variables de entorno:');
logger.debug('   NODE_ENV:', process.env.NODE_ENV);
logger.debug('   VERCEL:', process.env.VERCEL);
logger.debug('   POSTGRES_URL exists:', !!process.env.POSTGRES_URL);
logger.debug('   DATABASE_URL exists:', !!process.env.DATABASE_URL);
logger.debug('   POSTGRES_HOST:', process.env.POSTGRES_HOST);

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const { Sequelize } = require('sequelize');

// ============================================================================
// IMPORTANTE: Pre-cargar el módulo pg antes de usarlo con Sequelize
// Esto resuelve el problema "Please install pg package manually" en Vercel
// ============================================================================
let pg;
try {
  pg = require('pg');
  logger.debug('✅ Módulo pg cargado correctamente');
} catch (err) {
  logger.error('❌ Error cargando módulo pg:', err.message);
  // Intentar con pg-pool como fallback
  try {
    pg = require('pg-pool');
    logger.debug('✅ Módulo pg-pool cargado como fallback');
  } catch (err2) {
    logger.error('❌ Error crítico: no se pudo cargar pg ni pg-pool');
  }
}

let sequelize;

// ============================================================================
// DEBUG: Verificar variables de entorno (remover después de verificar)
// ============================================================================
logger.debug('🔍 DEBUG - Verificando conexión a DB:');
logger.debug('   NODE_ENV:', process.env.NODE_ENV);
logger.debug('   VERCEL:', process.env.VERCEL ? 'YES' : 'NO');
logger.debug('   POSTGRES_URL exists:', !!process.env.POSTGRES_URL);
logger.debug('   DATABASE_URL exists:', !!process.env.DATABASE_URL);

// ============================================================================
// CONFIGURACIÓN PARA VERCEL + NEON INTEGRATION
// ============================================================================
const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';

logger.debug('   Using DATABASE_URL:', !!DATABASE_URL);
if (DATABASE_URL) {
  logger.debug('   Connection string starts with:', DATABASE_URL.substring(0, 15) + '...');
}
logger.debug('============================================================================\n');

if (DATABASE_URL) {
  // ============================================================================
  // PRODUCCIÓN: Usando Neon (via Vercel o externo)
  // ============================================================================
  
  logger.debug('🔧 Conectando a Neon PostgreSQL');
  logger.debug('📍 Variable usada:', process.env.POSTGRES_URL ? 'POSTGRES_URL' : 'DATABASE_URL');
  
  // Configuración específica para Vercel
  const dialectOptions = {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  };

  // Si estamos en Vercel, configuración adicional
  if (process.env.VERCEL) {
    logger.debug('🔧 Modo Vercel detectado - Configuración optimizada');
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
  
  logger.debug('🔧 Conectando a PostgreSQL local (desarrollo)');
  logger.debug('⚠️  ADVERTENCIA: No se encontró POSTGRES_URL ni DATABASE_URL');
  logger.debug('   Usando configuración de desarrollo local');
  
  const dbConfig = {
    database: process.env.DB_NAME || 'inventario_db',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432
  };
  
  logger.debug(`   DB: ${dbConfig.database}@${dbConfig.host}:${dbConfig.port}`);
  
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
    logger.debug('✅ Conexión a PostgreSQL exitosa');
    logger.debug(`📍 Entorno: ${process.env.NODE_ENV || 'development'}`);
    
    // Información adicional solo en desarrollo
    if (!isProduction) {
      try {
        const [results] = await sequelize.query('SELECT version()');
        const version = results[0].version.split(' ').slice(0, 2).join(' ');
        logger.debug('📊 PostgreSQL Version:', version);
        
        // Mostrar tablas disponibles
        const [tables] = await sequelize.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          ORDER BY table_name
        `);
        
        if (tables.length > 0) {
          logger.debug(`📋 Tablas disponibles: ${tables.length}`);
          const tableNames = tables.slice(0, 5).map(t => t.table_name).join(', ');
          logger.debug('   ' + tableNames + (tables.length > 5 ? '...' : ''));
        } else {
          logger.debug('⚠️  No hay tablas. Ejecuta database-schema.sql');
        }
      } catch (err) {
        logger.debug('⚠️  No se pudo obtener información adicional');
      }
    }
    
    return true;
  } catch (error) {
    const detail = error.original?.message || error.message || String(error);
    logger.error('❌ Error conectando a PostgreSQL:');
    logger.error('   Detalle:', detail);
    
    // Ayuda de debugging
    if (!isProduction) {
      logger.error('\n💡 Verificaciones:');
      
      if (DATABASE_URL) {
        logger.error('   Modo: cadena (POSTGRES_URL / DATABASE_URL)');
        logger.error('   - ¿La URL es válida y el servidor acepta SSL si aplica?');
      } else {
        logger.error('   Modo: variables locales (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)');
        logger.error(`   - Destino: ${process.env.DB_NAME || 'inventario_db'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`);
        logger.error('   - ¿PostgreSQL está corriendo y escuchando en ese puerto?');
        logger.error('   - ¿Existe la base de datos y el usuario/contraseña son correctos?');
      }
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
    logger.debug('✅ Modelos sincronizados con la base de datos');
    
    return true;
  } catch (error) {
    logger.error('❌ Error sincronizando modelos:', error.message);
    return false;
  }
}

/**
 * Cerrar la conexión a la base de datos
 */
async function closeConnection() {
  try {
    await sequelize.close();
    logger.debug('✅ Conexión a PostgreSQL cerrada');
    return true;
  } catch (error) {
    logger.error('❌ Error cerrando conexión:', error.message);
    return false;
  }
}

module.exports = {
  sequelize,
  testConnection,
  syncDatabase,
  closeConnection
};