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
    const missing = [];

    const [salesCols] = await sequelize.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sales' AND column_name IN ('dian_status', 'tax_breakdown')"
    );
    const salesColNames = salesCols.map(c => c.column_name);
    if (!salesColNames.includes('dian_status')) missing.push('sales.dian_status');
    if (!salesColNames.includes('tax_breakdown')) missing.push('sales.tax_breakdown');

    const [movCols] = await sequelize.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_movements' AND column_name IN ('direction', 'movement_reason', 'created_by')"
    );
    const movColNames = movCols.map(c => c.column_name);
    if (!movColNames.includes('direction')) missing.push('inventory_movements.direction');
    if (!movColNames.includes('movement_reason')) missing.push('inventory_movements.movement_reason');
    if (!movColNames.includes('created_by')) missing.push('inventory_movements.created_by');

    // Verificar CHECK constraint de movement_type
    try {
      const [constraints] = await sequelize.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'inventory_movements'::regclass AND contype = 'c' AND conname LIKE '%movement_type%'"
      );
      if (constraints.length > 0 && constraints[0].def.includes('entrada')) {
        missing.push('inventory_movements.movement_type_check_obsolete');
      }
    } catch { /* ignorar */ }

    return missing;
  } catch {
    return ['unknown'];
  }
}

/**
 * Ejecuta migraciones pendientes automáticamente al iniciar el servidor.
 */
async function runMigrations() {
  const migrationsPath = path.join(__dirname, 'migrations', '*.js');
  logger.info(`[Migrator] Buscando migraciones en: ${migrationsPath}`);

  // Verificar si faltan columnas críticas
  const missingCols = await checkCriticalColumns();
  if (missingCols.length > 0) {
    logger.warn(`[Migrator] Columnas faltantes: ${missingCols.join(', ')}. Forzando re-ejecución...`);
    try {
      await sequelize.query("DELETE FROM sequelize_migrations");
      logger.info('[Migrator] Tabla sequelize_migrations limpiada');
    } catch (e) {
      logger.warn('[Migrator] No se pudo limpiar sequelize_migrations:', e.message);
    }
  }

  const queryInterface = sequelize.getQueryInterface();
  const SequelizeLib = require('sequelize');

  const umzug = new Umzug({
    migrations: {
      glob: migrationsPath,
      resolve: ({ name, path: filePath }) => {
        const migration = require(filePath);
        // Saltar archivos vacíos o sin función up
        if (typeof migration.up !== 'function') {
          logger.warn(`[Migrator] Saltando ${name} (no tiene función up)`);
          return {
            name,
            up: async () => {},
            down: async () => {},
          };
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
