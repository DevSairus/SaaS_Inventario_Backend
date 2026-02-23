const winston = require('winston');
const path = require('path');
const fs = require('fs');

// En Vercel (serverless) no existe filesystem escribible — solo consola
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    if (Object.keys(metadata).length > 0 && !metadata.stack) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  })
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} ${level}: ${message}`;
    if (metadata.stack) msg += `\n${metadata.stack}`;
    return msg;
  })
);

// Transports: siempre consola, archivos solo en local
const transports = [
  new winston.transports.Console({
    format: consoleFormat,
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  }),
];

if (!isVercel) {
  try {
    const logsDir = path.join(__dirname, '../../logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    transports.push(
      new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error', maxsize: 5242880, maxFiles: 5 }),
      new winston.transports.File({ filename: path.join(logsDir, 'combined.log'), maxsize: 10485760, maxFiles: 5 })
    );
  } catch (e) {
    // Si falla la creación de logs locales, continuar solo con consola
  }
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: { service: 'inventario-backend', environment: process.env.NODE_ENV || 'development' },
  transports,
});

// Módulos child
logger.auth         = logger.child({ module: 'auth' });
logger.invoice      = logger.child({ module: 'invoice' });
logger.payment      = logger.child({ module: 'payment' });
logger.notification = logger.child({ module: 'notification' });

logger.logRequest = (req) => logger.http('Request', { method: req.method, url: req.url, ip: req.ip, user: req.user?.id || 'anonymous' });
logger.logError   = (error, context = {}) => logger.error(error.message, { ...context, stack: error.stack, name: error.name });

logger.info('Logger initialized', { level: logger.level, env: process.env.NODE_ENV, vercel: isVercel });

module.exports = logger;