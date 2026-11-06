// src/scripts/_schemaMigrations.js
//
// Corre el set completo de migraciones DENTRO de un schema dado (vía
// search_path), con su propia tabla `sequelize_migrations` por schema.
// Idempotente: sobre un schema que ya existe solo aplica lo que le falte.
//
// Antes vivía dentro de provisionTenantSchema.js; se separó para que la
// plantilla de schemas (tenantTemplate.js) use exactamente la misma lógica.

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { Umzug, SequelizeStorage } = require('umzug');
const path = require('path');
const fs = require('fs');
const { directDbDialectOptions } = require('./_directDbSsl');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;
// OJO: usar la URL DIRECTA de Neon (no la "-pooler"), porque esto necesita
// search_path a nivel de sesión, y eso no es confiable a través de PgBouncer
// en modo transacción.

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

// Los dos archivos que antes necesitaban una corrección de orden
// ("0260202120100-create-supplier-returns.js" y
// "YYYYMMDDHHMMSS-create-customer-returns.js") ya fueron renombrados a
// timestamps cronológicos reales -- ver
// 20260202120100-create-supplier-returns.js y
// 20260103000000-create-customer-returns.js. El orden alfabético simple
// ya coincide con el orden de dependencias, así que ya no hace falta
// ningún override manual acá. IMPORTANTE: este rename requiere renombrar
// también la fila correspondiente en `sequelize_migrations` (en public Y
// en cada schema de tenant ya provisionado) antes de desplegar -- ver
// src/database/migrations/RENAME-sequelize-migrations-rows.sql -- si no,
// el migrator los va a tratar como pendientes y va a intentar correrlos
// de nuevo.
function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

/**
 * @param {string} schemaName
 * @param {object} context  3er argumento de cada migración: { tenantId, schemaName, slug }
 * @returns {Promise<string[]>} nombres de las migraciones aplicadas en esta corrida
 */
async function runMigrationsInSchema(schemaName, context) {
  // Conexión donde el search_path se fija como PARÁMETRO DE ARRANQUE de la
  // conexión Postgres (no como un `SET` posterior). Así, sin importar qué
  // pieza interna de Sequelize/Umzug dispare cada query, o si el pool abre
  // más de una conexión física, TODAS nacen ya con este search_path -> no
  // hay forma de que una query "se escape" hacia public por accidente.
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: {
      ...directDbDialectOptions(DATABASE_URL),
      // SOLO el schema del tenant, SIN ",public" de respaldo. Con public
      // en el search_path, Postgres resuelve "IF NOT EXISTS" y nombres
      // sin calificar recorriendo TODO el path -> encuentra las tablas
      // ya existentes en public (sequelize_migrations, categories, etc.)
      // y las trata como si ya existieran en el tenant, sin crear nada
      // nuevo. Quitando public de acá se elimina esa ambigüedad.
      options: `-c search_path="${schemaName}"`,
    },
    // CRÍTICO: queryInterface.addColumn/removeColumn/addIndex/addConstraint/
    // describeTable/showIndex/changeColumn NO respetan search_path -- Sequelize
    // los resuelve vía extractTableDetails(), que cuando no recibe un schema
    // explícito cae SIEMPRE a `sequelize.options.schema || "public"`, sin
    // mirar el search_path de la conexión. Sin esto, cualquier migración que
    // use esas funciones de conveniencia (la gran mayoría) termina alterando
    // silenciosamente las tablas de "public" (con datos reales de producción)
    // en vez de las del schema de este tenant. Las migraciones que sí quieren
    // tocar una tabla compartida (tenants/users/subscription_plans a propósito)
    // ya pasan `{ schema: 'public' }` explícito, que sigue ganando sobre este
    // default. Solo el SQL crudo (sequelize.query) y createTable/dropTable con
    // nombre de tabla simple ignoran esto y siguen dependiendo del search_path.
    schema: schemaName,
    logging: false,
    pool: { max: 1, min: 1, idle: 10000 },
  });

  try {
    // Diagnóstico: confirmar que ESTA conexión efectivamente ve el search_path esperado
    const [[{ current_search_path }]] = await sequelize.query(
      "SELECT current_setting('search_path') AS current_search_path"
    );
    console.log(`ℹ️  search_path efectivo de la conexión: ${current_search_path}`);

    const queryInterface = sequelize.getQueryInterface();
    const SequelizeLib = require('sequelize');

    const files = listMigrationFiles();
    console.log(`ℹ️  Archivos de migración encontrados en total: ${files.length}`);
    if (files.length === 0) {
      throw new Error(
        `No se encontró NINGÚN archivo de migración en "${MIGRATIONS_DIR}". ` +
        `Esto es un problema de path, no de search_path. Revisa que la ` +
        `carpeta exista con ese nombre exacto dentro del contenedor.`
      );
    }

    const umzug = new Umzug({
      migrations: files.map((name) => {
        const migration = require(path.join(MIGRATIONS_DIR, name));
        if (typeof migration.up !== 'function') {
          return { name, up: async () => {}, down: async () => {} };
        }
        return {
          name,
          up: async () => migration.up(queryInterface, SequelizeLib, context),
          down: async () => migration.down(queryInterface, SequelizeLib, context),
        };
      }),
      context: queryInterface,
      storage: new SequelizeStorage({
        sequelize,
        tableName: 'sequelize_migrations',
        schema: schemaName, // defensa adicional: aunque el search_path fallara, esto lo fuerza explícito
      }),
      logger: console,
    });

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

    return executed.map((m) => m.name);
  } finally {
    await sequelize.close();
  }
}

module.exports = { DATABASE_URL, MIGRATIONS_DIR, listMigrationFiles, runMigrationsInSchema };
