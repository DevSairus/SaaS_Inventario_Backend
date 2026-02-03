/**
 * Configuración de Winston Logger
 * Ubicación: backend/src/config/logger.js
 *
 * Este archivo configura un sistema de logging profesional con:
 * - Logs a archivo con rotación
 * - Logs coloreados en consola para desarrollo
 * - Niveles de log: error, warn, info, http, debug
 * - Loggers específicos por módulo
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Crear directorio de logs si no existe
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Formato personalizado para logs
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;

    // Agregar metadata si existe
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }

    return msg;
  })
);

// Formato para consola (con colores)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} ${level}: ${message}`;

    if (Object.keys(metadata).length > 0 && metadata.stack) {
      msg += `\n${metadata.stack}`;
    }

    return msg;
  })
);

// Configuración principal del logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: {
    service: 'saas-acueductos',
    environment: process.env.NODE_ENV || 'development',
  },
  transports: [
    // Logs de ERROR a archivo separado
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true,
    }),

    // Logs WARN a archivo separado
    new winston.transports.File({
      filename: path.join(logsDir, 'warn.log'),
      level: 'warn',
      maxsize: 5242880,
      maxFiles: 3,
      tailable: true,
    }),

    // Todos los logs a archivo combinado
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

// En desarrollo, también loggear a consola con colores
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
      level: 'debug',
    })
  );
}

// Loggers específicos por módulo
logger.auth = logger.child({ module: 'auth' });
logger.invoice = logger.child({ module: 'invoice' });
logger.payment = logger.child({ module: 'payment' });
logger.financing = logger.child({ module: 'financing' });
logger.notification = logger.child({ module: 'notification' });
logger.pqrs = logger.child({ module: 'pqrs' });
logger.job = logger.child({ module: 'job' });

// Helper methods
logger.logRequest = (req) => {
  logger.http('Request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    user: req.user?.id || 'anonymous',
  });
};

logger.logError = (error, context = {}) => {
  logger.error(error.message, {
    ...context,
    stack: error.stack,
    name: error.name,
  });
};

logger.logTransaction = (type, data) => {
  logger.info(`Transaction: ${type}`, data);
};

// Log de inicio
logger.info('Logger initialized', {
  level: logger.level,
  logsDir,
});

module.exports = logger;
