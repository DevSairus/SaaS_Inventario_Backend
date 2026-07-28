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

  // Paso 1: crear el schema con una conexión aparte y de un solo uso,
  // usando search_path por defecto (public) — no depende de nada.
  const bootstrapSequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false,
    pool: { max: 1, min: 0 },
  });
  try {
    await bootstrapSequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    console.log(`✅ Schema "${schemaName}" listo`);
  } finally {
    await bootstrapSequelize.close();
  }

  // Paso 2: nueva conexión donde el search_path se fija como PARÁMETRO
  // DE ARRANQUE de la conexión Postgres (no como un `SET` posterior).
  // Así, sin importar qué pieza interna de Sequelize/Umzug dispare cada
  // query, o si el pool abre más de una conexión física, TODAS nacen ya
  // con este search_path -> no hay forma de que una query "se escape"
  // hacia public por accidente.
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: { require: true, rejectUnauthorized: false },
      options: `-c search_path="${schemaName}",public`,
    },
    logging: false,
    pool: { max: 1, min: 1, idle: 10000 },
  });

  try {
    // Diagnóstico: confirmar que ESTA conexión efectivamente ve el search_path esperado
    const [[{ current_search_path }]] = await sequelize.query(
      "SELECT current_setting('search_path') AS current_search_path"
    );
    console.log(`ℹ️  search_path efectivo de la conexión: ${current_search_path}`);

    const migrationsPath = path
      .join(__dirname, '..', 'database', 'migrations', '*.js')
      .split(path.sep)
      .join('/');
    console.log(`ℹ️  Buscando migraciones en: ${migrationsPath}`);

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
      storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_migrations' }),
      logger: console,
    });

    const allMigrations = await umzug.migrations();
    console.log(`ℹ️  Archivos de migración encontrados en total: ${allMigrations.length}`);
    if (allMigrations.length === 0) {
      throw new Error(
        `No se encontró NINGÚN archivo de migración en "${migrationsPath}". ` +
        `Esto es un problema de path/glob, no de search_path. Revisa que la ` +
        `carpeta exista con ese nombre exacto dentro del contenedor.`
      );
    }

    const pending = await umzug.pending();
    console.log(`ℹ️  Migraciones pendientes para "${schemaName}": ${pending.length}`);

    const executed = await umzug.up();
    console.log(`✅ ${executed.length} migraciones aplicadas en "${schemaName}"`);

    const [[{ count: tableCount }]] = await sequelize.query(`
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = '${schemaName}' AND table_type = 'BASE TABLE'
    `);
    if (Number(tableCount) === 0) {
      throw new Error(
        `El schema "${schemaName}" quedó sin tablas después de correr migraciones. ` +
        `search_path efectivo era: ${current_search_path}. Revisa el log de arriba.`
      );
    }
    console.log(`✅ Verificado: ${tableCount} tablas existen en "${schemaName}"`);

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