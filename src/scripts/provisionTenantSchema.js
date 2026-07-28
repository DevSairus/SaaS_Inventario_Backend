// src/scripts/provisionTenantSchema.js
//
// Uso: node src/scripts/provisionTenantSchema.js <tenant_slug>
//
// 1. Crea el schema `tenant_<slug>` si no existe.
// 2. Corre las migraciones existentes DENTRO de ese schema (vía search_path),
//    sin modificar ni un archivo de src/database/migrations.
// 3. Dejar el schema listo con la estructura actual, VACÍO de datos
//    (el copiado de datos es un paso aparte -> migrateTenantData.js).

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { Umzug, SequelizeStorage } = require('umzug');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;
// OJO: usar la URL DIRECTA de Neon (no la "-pooler"), porque este script
// necesita SET search_path a nivel de sesión, y eso no es confiable a
// través de PgBouncer en modo transacción.

function schemaNameFor(slug) {
  return `tenant_${slug.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

async function provisionTenantSchema(slug) {
  const schemaName = schemaNameFor(slug);
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false,
  });

  try {
    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    console.log(`✅ Schema "${schemaName}" listo`);

    // Todas las conexiones de este pool usan el mismo search_path
    await sequelize.query(`SET search_path TO "${schemaName}", public`);

    const migrationsPath = path
      .join(__dirname, '..', 'database', 'migrations', '*.js')
      .split(path.sep)
      .join('/');

    const queryInterface = sequelize.getQueryInterface();
    const SequelizeLib = require('sequelize');

    const umzug = new Umzug({
      migrations: {
        glob: migrationsPath,
        resolve: ({ name, path: filePath }) => {
          const migration = require(filePath);
          if (typeof migration.up !== 'function') {
            return { name, up: async () => {}, down: async () => {} };
          }
          return {
            name,
            up: async () => migration.up(queryInterface, SequelizeLib),
            down: async () => migration.down(queryInterface, SequelizeLib),
          };
        },
      },
      context: queryInterface,
      // Tabla de control DE ESTE SCHEMA (queda dentro de tenant_<slug>
      // porque search_path ya está seteado)
      storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_migrations' }),
      logger: console,
    });

    const executed = await umzug.up();
    console.log(`✅ ${executed.length} migraciones aplicadas en "${schemaName}"`);
    return schemaName;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Uso: node provisionTenantSchema.js <tenant_slug>');
    process.exit(1);
  }
  provisionTenantSchema(slug)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error aprovisionando schema:', err);
      process.exit(1);
    });
}

module.exports = { provisionTenantSchema, schemaNameFor };