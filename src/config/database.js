require('dotenv').config();
const { Sequelize } = require('sequelize');

let sequelize;

// ============================================================================
// CONFIGURACIÓN PARA VERCEL + NEON INTEGRATION
// ============================================================================
// Vercel con Neon crea automáticamente POSTGRES_URL
// Si usas Neon fuera de Vercel, usa DATABASE_URL

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';

if (DATABASE_URL) {
  // ============================================================================
  // PRODUCCIÓN: Usando Neon (via Vercel o externo)
  // ============================================================================
  
  console.log('🔧 Conectando a Neon PostgreSQL');
  console.log('📍 Variable usada:', process.env.POSTGRES_URL ? 'POSTGRES_URL' : 'DATABASE_URL');
  
  sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    protocol: 'postgres',
    
    // SSL es obligatorio para Neon
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false  // Necesario para Neon
      }
    },
    
    // Logging
    logging: isProduction ? false : console.log,
    
    // Pool optimizado para Vercel Serverless
    pool: {
      max: 2,           // Máximo 2 conexiones (límite serverless)
      min: 0,           // Cerrar cuando no se use
      acquire: 30000,   // 30s timeout para adquirir conexión
      idle: 10000       // Cerrar conexiones inactivas después de 10s
    },
    
    // Opciones de modelos
    define: {
      timestamps: true,
      underscored: false,
      freezeTableName: true
    },
    
    // Importante para Neon
    dialectOptions: {
      ...this?.dialectOptions,
      ssl: {
        require: true,
        rejectUnauthorized: false
      },
      // Configuración adicional para Neon
      statement_timeout: 30000,  // 30s timeout por query
      idle_in_transaction_session_timeout: 30000
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
        console.log('📊 PostgreSQL Version:', results[0].version.split(' ')[0] + ' ' + results[0].version.split(' ')[1]);
        
        // Mostrar tablas disponibles
        const [tables] = await sequelize.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          ORDER BY table_name
        `);
        
        if (tables.length > 0) {
          console.log(`📋 Tablas disponibles: ${tables.length}`);
          console.log('   ' + tables.slice(0, 5).map(t => t.table_name).join(', ') + 
                     (tables.length > 5 ? '...' : ''));
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
        
        if (!DATABASE_URL.includes('sslmode=require')) {
          console.error('   ⚠️  Falta ?sslmode=require al final de la URL');
        }
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

/**
 * Ejecutar query SQL directamente
 * Útil para migraciones o consultas específicas
 */
async function executeQuery(sql, options = {}) {
  try {
    const [results, metadata] = await sequelize.query(sql, options);
    return { success: true, results, metadata };
  } catch (error) {
    console.error('❌ Error ejecutando query:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Verificar que las tablas principales existen
 */
async function checkTables() {
  try {
    const requiredTables = [
      'tenants',
      'users',
      'permissions',
      'categories',
      'products',
      'warehouses',
      'suppliers'
    ];
    
    const [tables] = await sequelize.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = ANY($1)
    `, {
      bind: [requiredTables]
    });
    
    const existingTables = tables.map(t => t.table_name);
    const missingTables = requiredTables.filter(t => !existingTables.includes(t));
    
    if (missingTables.length > 0) {
      console.warn('⚠️  Faltan tablas importantes:');
      missingTables.forEach(t => console.warn(`   - ${t}`));
      console.warn('   → Ejecuta database-schema.sql');
      return { success: false, missingTables };
    }
    
    console.log('✅ Todas las tablas principales existen');
    return { success: true, tables: existingTables };
    
  } catch (error) {
    console.error('❌ Error verificando tablas:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sequelize,
  testConnection,
  syncDatabase,
  closeConnection,
  executeQuery,
  checkTables
};