'use strict';

const { Umzug, SequelizeStorage } = require('umzug');
const path = require('path');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');

/**
 * Verifica si las columnas críticas existen en la BD.
 * Si faltan, fuerza re-ejecución de migraciones.
 */
async function checkCriticalColumns() {
  try {
    const [cols] = await sequelize.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sales' AND column_name IN ('dian_status', 'tax_breakdown')"
    );
    const colNames = cols.map(c => c.column_name);
    const missing = [];
    if (!colNames.includes('dian_status')) missing.push('dian_status');
    if (!colNames.includes('tax_breakdown')) missing.push('tax_breakdown');
    return missing;
  } catch {
    return ['unknown'];
  }
}

/**
 * Ejecuta migraciones pendientes automáticamente al iniciar el servidor.
 * Usa Umzug + SequelizeStorage para rastrear qué migraciones ya se aplicaron.
 */
async function runMigrations() {
  const migrationsPath = path.join(__dirname, 'migrations', '*.js');
  logger.info(`[Migrator] Buscando migraciones en: ${migrationsPath}`);

  // Verificar si faltan columnas críticas
  const missingCols = await checkCriticalColumns();
  if (missingCols.length > 0) {
    logger.warn(`[Migrator] Columnas faltantes en 'sales': ${missingCols.join(', ')}. Forzando re-ejecución...`);
    // Limpiar registro de migraciones para forzar re-ejecución
    try {
      await sequelize.query("DELETE FROM sequelize_migrations");
      logger.info('[Migrator] Tabla sequelize_migrations limpiada para re-ejecución');
    } catch (e) {
      logger.warn('[Migrator] No se pudo limpiar sequelize_migrations:', e.message);
    }
  }

  const umzug = new Umzug({
    migrations: {
      glob: migrationsPath,
      resolve: ({ name, path: filePath, context }) => {
        logger.info(`[Migrator] Cargando migración: ${name}`);
        const migration = require(filePath);
        return {
          name,
          up: async () => migration.up(context.queryInterface, context.Sequelize),
          down: async () => migration.down(context.queryInterface, context.Sequelize),
        };
      },
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_migrations' }),
    logger: {
      info: (msg) => logger.info(`[Migrator] ${msg.message || msg}`),
      warn: (msg) => logger.warn(`[Migrator] ${msg.message || msg}`),
      error: (msg) => logger.error(`[Migrator] ${msg.message || msg}`),
      debug: (msg) => logger.debug(`[Migrator] ${msg.message || msg}`),
    },
  });

  const pending = await umzug.pending();
  if (pending.length === 0) {
    logger.info('[Migrator] No hay migraciones pendientes');
    return [];
  }

  logger.info(`[Migrator] ${pending.length} migración(es) pendiente(s): ${pending.map(m => m.name).join(', ')}`);

  const executed = await umzug.up();
  logger.info(`[Migrator] ${executed.length} migración(es) ejecutada(s) exitosamente`);
  return executed;
}

module.exports = { runMigrations };
