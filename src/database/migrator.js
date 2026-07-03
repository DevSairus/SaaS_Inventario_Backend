'use strict';

const { Umzug, SequelizeStorage } = require('umzug');
const path = require('path');
const { sequelize } = require('../config/database');
const logger = require('../config/logger');

/**
 * Ejecuta migraciones pendientes automáticamente al iniciar el servidor.
 * Usa Umzug + SequelizeStorage para rastrear qué migraciones ya se aplicaron.
 */
async function runMigrations() {
  const migrationsPath = path.join(__dirname, 'migrations', '*.js');
  logger.info(`[Migrator] Buscando migraciones en: ${migrationsPath}`);

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
