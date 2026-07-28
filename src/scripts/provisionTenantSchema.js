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
const fs = require('fs');

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
  let tenantId;
  try {
    await bootstrapSequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    console.log(`✅ Schema "${schemaName}" listo`);

    // Necesario para que las migraciones de backfill (sede principal,
    // asignación usuario-sede, etc.) puedan filtrar por ESTE tenant y no
    // arrastren filas de todos los tenants existentes en public.tenants.
    const [[tenant]] = await bootstrapSequelize.query(
      `SELECT id FROM public.tenants WHERE slug = :slug`,
      { replacements: { slug } }
    );
    if (!tenant) throw new Error(`Tenant "${slug}" no existe en public.tenants`);
    tenantId = tenant.id;
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

    const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
    console.log(`ℹ️  Buscando migraciones en: ${migrationsDir}`);

    const queryInterface = sequelize.getQueryInterface();
    const SequelizeLib = require('sequelize');

    // CORRECCIÓN DE ORDEN: no tocamos ningún archivo en disco (renombrarlo
    // rompería el migrator normal de producción, que ya tiene esta
    // migración registrada con su nombre actual y correría addIndex()
    // de nuevo contra public, donde esos índices ya existen -> error).
    // En vez de eso, corregimos el ORDEN DE EJECUCIÓN únicamente para
    // este proceso de aprovisionamiento, vía un sort-key explícito.
    //
    // "0260202120100-create-supplier-returns.js" le falta el "2" inicial
    // (debería ser "20260202120100...", justo antes de
    // "20260202120200-create-transfers.js"). Al ordenar alfabéticamente
    // tal cual, cae primero que todo -> intenta crear una FK hacia
    // "purchases"/"suppliers" antes de que existan en un schema fresco.
    // "YYYYMMDDHHMMSS-create-customer-returns.js" nunca tuvo su timestamp real
    // puesto -> ordena al final (Y > cualquier dígito), pero
    // "2026070611-fix-full-schema-audit.js" hace ADD COLUMN IF NOT EXISTS
    // sobre `customer_returns`, que en un schema nuevo todavía no existe.
    // Solo depende de sales/customers/sale_items/products (baselines), así
    // que la reordenamos justo después de los baselines.
    const SORT_KEY_OVERRIDES = {
      '0260202120100-create-supplier-returns.js': '20260202120100-create-supplier-returns.js',
      'YYYYMMDDHHMMSS-create-customer-returns.js': '20260103000000-create-customer-returns.js',
    };

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.js'))
      .sort((a, b) => {
        const keyA = SORT_KEY_OVERRIDES[a] || a;
        const keyB = SORT_KEY_OVERRIDES[b] || b;
        return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
      });

    console.log(`ℹ️  Archivos de migración encontrados en total: ${files.length}`);
    if (files.length === 0) {
      throw new Error(
        `No se encontró NINGÚN archivo de migración en "${migrationsDir}". ` +
        `Esto es un problema de path, no de search_path. Revisa que la ` +
        `carpeta exista con ese nombre exacto dentro del contenedor.`
      );
    }

    const umzug = new Umzug({
      migrations: files.map((name) => {
        const filePath = path.join(migrationsDir, name);
        const migration = require(filePath);
        if (typeof migration.up !== 'function') {
          return { name, up: async () => {}, down: async () => {} };
        }
        return {
          name,
          up: async () => migration.up(queryInterface, SequelizeLib, { tenantId, schemaName, slug }),
          down: async () => migration.down(queryInterface, SequelizeLib, { tenantId, schemaName, slug }),
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