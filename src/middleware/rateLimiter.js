/**
 * Rate Limiting Middleware
 * Ubicación: backend/src/middleware/rateLimiter.js
 *
 * Protege la API contra:
 * - Ataques DDoS
 * - Brute force en login
 * - Spam de requests
 * - Abuso de recursos
 *
 * REQUISITO: app.set('trust proxy', 1) debe estar en server.js
 * para que req.ip resuelva la IP real desde X-Forwarded-For (Vercel/proxies).
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redisClient } = require('../config/redisClient');
const logger = require('../config/logger');

// ============================================
// KEY GENERATOR — usa IP real tras el proxy
// ============================================
// Con app.set('trust proxy', 1), express-rate-limit puede calcular correctamente la llave
// incluso para IPv6 usando su helper. Esto evita bypasses y pasa la validación v8+.
const ipKey = (req) => ipKeyGenerator(req);

// ============================================
// STORE — Redis compartido entre réplicas si está configurado
// ============================================
// Sin esto, el MemoryStore por defecto de express-rate-limit vive dentro del
// proceso: con N réplicas cada una lleva su propio contador y el límite
// efectivo se multiplica por N (ej. 10 intentos de login se vuelven ~10×N
// repartidos entre réplicas). Cada limiter usa un prefix distinto para que
// sus contadores no se mezclen entre sí dentro de la misma llave de Redis.
const makeStore = (prefix) => {
  if (!redisClient) return undefined; // cae al MemoryStore por defecto
  return new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix: `rl:${prefix}:`,
  });
};

// ============================================
// CONFIGURACIONES DE RATE LIMITING
// ============================================

/**
 * Rate limiter general para todas las rutas
 * 500 requests por 15 minutos por IP real
 * (antes 100 — demasiado bajo: búsquedas con debounce consumen ~1 req/300ms)
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 500,
  store: makeStore('general'),
  message: {
    success: false,
    error: 'Demasiadas peticiones desde esta IP, intenta de nuevo más tarde',
    retryAfter: 15,
  },
  standardHeaders: true,  // Retorna rate limit info en headers `RateLimit-*`
  legacyHeaders: false,   // Deshabilita headers `X-RateLimit-*`
  keyGenerator: ipKey,

  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      user: req.user?.id || 'anonymous',
    });

    res.status(429).json({
      success: false,
      error: 'Demasiadas peticiones, intenta de nuevo más tarde',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 / 60),
    });
  },
});

/**
 * Rate limiter estricto para autenticación
 * 10 intentos fallidos por 15 minutos por IP real
 * (antes 5 — muy restrictivo cuando múltiples usuarios comparten IP corporativa/NAT)
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  store: makeStore('auth'),
  skipSuccessfulRequests: true, // No cuenta requests exitosos
  keyGenerator: ipKey,
  message: {
    success: false,
    error: 'Demasiados intentos de login fallidos. Intenta de nuevo en 15 minutos',
  },

  handler: (req, res) => {
    logger.warn('Auth rate limit exceeded', {
      ip: req.ip,
      email: req.body?.email,
    });

    res.status(429).json({
      success: false,
      error: 'Demasiados intentos de login. Por seguridad, intenta de nuevo en 15 minutos',
      retryAfter: 15,
    });
  },
});

/**
 * Rate limiter para creación de recursos
 * 20 requests por hora
 */
const createResourceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  store: makeStore('create-resource'),
  keyGenerator: ipKey,
  message: {
    success: false,
    error: 'Límite de creación de recursos alcanzado',
  },
  skipSuccessfulRequests: false,

  handler: (req, res) => {
    logger.warn('Create resource rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
      path: req.path,
    });

    res.status(429).json({
      success: false,
      error: 'Límite de creación alcanzado. Intenta de nuevo en 1 hora',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter para pagos
 * 10 transacciones por hora
 */
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  store: makeStore('payment'),
  keyGenerator: ipKey,
  message: {
    success: false,
    error: 'Límite de transacciones alcanzado',
  },

  handler: (req, res) => {
    logger.warn('Payment rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
    });

    res.status(429).json({
      success: false,
      error: 'Límite de transacciones de pago alcanzado. Contacta soporte si necesitas aumentar el límite',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter para generación de PDFs
 * 20 PDFs por hora
 */
const pdfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  store: makeStore('pdf'),
  keyGenerator: ipKey,

  handler: (req, res) => {
    logger.warn('PDF generation rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
    });

    res.status(429).json({
      success: false,
      error: 'Límite de generación de PDFs alcanzado',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter para exportaciones (Excel, CSV)
 * 10 exportaciones por hora
 */
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  store: makeStore('export'),
  keyGenerator: ipKey,

  handler: (req, res) => {
    logger.warn('Export rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
    });

    res.status(429).json({
      success: false,
      error: 'Límite de exportaciones alcanzado',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter para importaciones (Excel)
 * 5 importaciones por hora
 */
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  store: makeStore('import'),
  keyGenerator: ipKey,

  handler: (req, res) => {
    logger.warn('Import rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
    });

    res.status(429).json({
      success: false,
      error: 'Límite de importaciones alcanzado. Las importaciones consumen muchos recursos, intenta más tarde',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter para endpoints de notificaciones
 * 50 notificaciones por hora
 */
const notificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  store: makeStore('notification'),
  keyGenerator: ipKey,

  handler: (req, res) => {
    logger.warn('Notification rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
    });

    res.status(429).json({
      success: false,
      error: 'Límite de notificaciones alcanzado',
    });
  },
});

/**
 * Rate limiter para el chat de NEXA (asistente de IA)
 * 25 mensajes / 10 min por usuario (no por IP — varios usuarios de la misma
 * oficina comparten IP). Cada mensaje puede disparar varias llamadas a Groq
 * + hasta MAX_TOOL_ITERATIONS consultas a la base de datos, por lo que
 * generalLimiter (pensado para CRUD normal) no alcanza a frenar el costo.
 */
const aiChatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 25,
  store: makeStore('ai-chat'),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id?.toString() || ipKeyGenerator(req),
  message: {
    success: false,
    error: 'Demasiados mensajes a NEXA. Espera unos minutos antes de continuar',
  },

  handler: (req, res) => {
    logger.warn('AI chat rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
    });

    res.status(429).json({
      success: false,
      message: 'Demasiados mensajes a NEXA en poco tiempo. Espera unos minutos antes de continuar',
      retryAfter: 10,
    });
  },
});

/**
 * Rate limiter flexible basado en rol del usuario
 * Los admin tienen límites más altos
 */
const createRoleBasedLimiter = (maxForUser = 50, maxForAdmin = 200) => {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    store: makeStore(`role-based-${maxForUser}-${maxForAdmin}`),
    max: (req) => {
      if (req.user?.role === 'admin' || req.user?.role === 'super_admin') {
        return maxForAdmin;
      }
      return maxForUser;
    },
    keyGenerator: (req) => {
      // Si está autenticado, usar user ID para no penalizar IPs compartidas
      return req.user?.id?.toString() || ipKeyGenerator(req);
    },
  });
};

/**
 * Rate limiter para la respuesta pública a una cotización de OT
 * (POST /public/work-orders/:token/quote-requests/:id/respond).
 * Es un endpoint sin autenticación — protege contra intentos de adivinar
 * tokens o de spamear/reintentar la respuesta. 20 intentos por hora por IP
 * es generoso para un cliente real (una sola respuesta legítima) pero corta
 * el abuso automatizado.
 */
const quoteResponseLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  store: makeStore('quote-response'),
  keyGenerator: ipKey,
  message: {
    success: false,
    error: 'Demasiados intentos. Intenta de nuevo más tarde',
  },

  handler: (req, res) => {
    logger.warn('Quote response rate limit exceeded', {
      ip: req.ip,
      path: req.path,
    });

    res.status(429).json({
      success: false,
      message: 'Demasiados intentos. Intenta de nuevo en un rato, o contacta al taller directamente',
      retryAfter: 60,
    });
  },
});

/**
 * Rate limiter para la reserva pública de citas de taller
 * (POST /public/workshop/:slug/:branchId/appointments). Sin autenticación
 * -- mismo criterio que quoteResponseLimiter: generoso para un cliente real
 * (una reserva legítima), corta el abuso automatizado de slots.
 */
const appointmentBookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  store: makeStore('appointment-booking'),
  keyGenerator: ipKey,
  handler: (req, res) => {
    logger.warn('Appointment booking rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json({
      success: false,
      message: 'Demasiados intentos. Intenta de nuevo en un rato, o contacta al taller directamente',
      retryAfter: 60,
    });
  },
});

module.exports = {
  generalLimiter,
  authLimiter,
  createResourceLimiter,
  paymentLimiter,
  pdfLimiter,
  exportLimiter,
  importLimiter,
  notificationLimiter,
  createRoleBasedLimiter,
  aiChatLimiter,
  quoteResponseLimiter,
  appointmentBookingLimiter,
};