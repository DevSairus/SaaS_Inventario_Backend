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
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_movements' AND column_name IN ('direction', 'movement_reason', 'created_by', 'previous_stock', 'new_stock', 'user_id')"
    );
    const movColNames = movCols.map(c => c.column_name);
    if (!movColNames.includes('direction')) missing.push('inventory_movements.direction');
    if (!movColNames.includes('movement_reason')) missing.push('inventory_movements.movement_reason');
    if (!movColNames.includes('created_by')) missing.push('inventory_movements.created_by');
    if (!movColNames.includes('previous_stock')) missing.push('inventory_movements.previous_stock');
    if (!movColNames.includes('new_stock')) missing.push('inventory_movements.new_stock');
    if (!movColNames.includes('user_id')) missing.push('inventory_movements.user_id');

    const [purchCols] = await sequelize.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'purchases' AND column_name IN ('payment_history', 'user_id')"
    );
    const purchColNames = purchCols.map(c => c.column_name);
    if (!purchColNames.includes('payment_history')) missing.push('purchases.payment_history');
    if (!purchColNames.includes('user_id')) missing.push('purchases.user_id');

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
 * Repara directamente las columnas/constraints faltantes detectadas por
 * checkCriticalColumns, SIN tocar la tabla de control de migraciones.
 *
 * IMPORTANTE: antes esta función borraba toda `sequelize_migrations` para
 * "forzar" el re-run de todo. Eso es destructivo: si cualquier migración
 * anterior no es 100% idempotente (ej. un CREATE INDEX sin IF NOT EXISTS),
 * el re-run completo revienta a mitad de camino y el problema real nunca
 * se llega a corregir (loop infinito de wipe + crash en cada restart).
 * Por eso ahora se repara puntualmente con ALTER TABLE ... IF NOT EXISTS.
 */
async function repairCriticalColumns(missing) {
  if (missing.includes('inventory_movements.direction')) {
    await sequelize.query(
      "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS direction VARCHAR(20)"
    );
  }
  if (missing.includes('inventory_movements.movement_reason')) {
    await sequelize.query(
      "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS movement_reason VARCHAR(50)"
    );
  }
  if (missing.includes('inventory_movements.created_by')) {
    await sequelize.query(
      "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS created_by UUID"
    );
  }
  if (missing.includes('inventory_movements.previous_stock')) {
    await sequelize.query(
      "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS previous_stock DECIMAL(15,2) NOT NULL DEFAULT 0"
    );
  }
  if (missing.includes('inventory_movements.new_stock')) {
    await sequelize.query(
      "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS new_stock DECIMAL(15,2) NOT NULL DEFAULT 0"
    );
  }
  if (missing.includes('inventory_movements.user_id')) {
    await sequelize.query(
      "ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS user_id UUID"
    );
  }
  if (missing.includes('purchases.payment_history')) {
    await sequelize.query(
      "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_history JSONB DEFAULT '[]'::jsonb"
    );
  }
  if (missing.includes('purchases.user_id')) {
    await sequelize.query(
      "ALTER TABLE purchases ADD COLUMN IF NOT EXISTS user_id UUID"
    );
  }
  if (missing.includes('inventory_movements.movement_type_check_obsolete')) {
    await sequelize.query(
      "ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check"
    );
    // Sin la lista exacta de valores nuevos no reconstruimos el CHECK aquí;
    // 2026070401-fix-inventory-movements-columns.js es la fuente de verdad
    // para el constraint definitivo y sigue corriendo normalmente si aún
    // está pendiente en sequelize_migrations.
  }
}

/**
 * Ejecuta migraciones pendientes automáticamente al iniciar el servidor.
 */
async function runMigrations() {
  // IMPORTANTE: 'glob' usa '\' como carácter de escape, así que en Windows
  // path.join() (que genera backslashes) rompe el patrón silenciosamente y
  // no matchea ningún archivo. Se normaliza a forward-slashes siempre.
  const migrationsPath = path.join(__dirname, 'migrations', '*.js').split(path.sep).join('/');
  logger.info(`[Migrator] Buscando migraciones en: ${migrationsPath}`);

  // Verificar si faltan columnas críticas
  const missingCols = await checkCriticalColumns();
  if (missingCols.length > 0 && !missingCols.includes('unknown')) {
    logger.warn(`[Migrator] Columnas faltantes: ${missingCols.join(', ')}. Reparando puntualmente...`);
    try {
      await repairCriticalColumns(missingCols);
      logger.info('[Migrator] Columnas reparadas sin afectar el historial de migraciones');
    } catch (e) {
      logger.warn('[Migrator] No se pudieron reparar todas las columnas:', e.message);
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