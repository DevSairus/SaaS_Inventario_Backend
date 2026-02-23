/**
 * Rate Limiting Middleware
 * Ubicación: backend/src/middleware/rateLimiter.js
 *
 * Protege la API contra:
 * - Ataques DDoS
 * - Brute force en login
 * - Spam de requests
 * - Abuso de recursos
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('../config/logger');

// ============================================
// CONFIGURACIONES DE RATE LIMITING
// ============================================

/**
 * Rate limiter general para todas las rutas
 * 100 requests por 15 minutos
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Límite de requests
  message: {
    success: false,
    error: 'Demasiadas peticiones desde esta IP, intenta de nuevo más tarde',
    retryAfter: 15, // minutos
  },
  standardHeaders: true, // Retorna rate limit info en headers `RateLimit-*`
  legacyHeaders: false, // Deshabilita headers `X-RateLimit-*`

  // Handler cuando se excede el límite
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      user: req.user?.id || 'anonymous',
    });

    res.status(429).json({
      success: false,
      error: 'Demasiadas peticiones, intenta de nuevo más tarde',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 / 60), // minutos
    });
  },

  // Función para generar la key compatible con IPv6
  keyGenerator: (req) => ipKeyGenerator(req),
});

/**
 * Rate limiter estricto para autenticación
 * 5 intentos por 15 minutos
 * Solo cuenta intentos fallidos
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true, // No cuenta requests exitosos
  message: {
    success: false,
    error:
      'Demasiados intentos de login fallidos. Intenta de nuevo en 15 minutos',
  },

  handler: (req, res) => {
    logger.warn('Auth rate limit exceeded', {
      ip: req.ip,
      email: req.body?.email,
    });

    res.status(429).json({
      success: false,
      error:
        'Demasiados intentos de login. Por seguridad, intenta de nuevo en 15 minutos',
      retryAfter: 15,
    });
  },
});

/**
 * Rate limiter para creación de recursos
 * 20 requests por hora
 */
const createResourceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 20,
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
      error:
        'Límite de transacciones de pago alcanzado. Contacta soporte si necesitas aumentar el límite',
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

  handler: (req, res) => {
    logger.warn('Import rate limit exceeded', {
      ip: req.ip,
      user: req.user?.id,
    });

    res.status(429).json({
      success: false,
      error:
        'Límite de importaciones alcanzado. Las importaciones consumen muchos recursos, intenta más tarde',
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
 * Rate limiter flexible basado en rol del usuario
 * Los admin tienen límites más altos
 */
const createRoleBasedLimiter = (maxForUser = 50, maxForAdmin = 200) => {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: (req) => {
      // Admin tiene límite más alto
      if (req.user?.role === 'admin' || req.user?.role === 'super_admin') {
        return maxForAdmin;
      }
      return maxForUser;
    },
    keyGenerator: (req) => {
      // Si está autenticado, usar user ID, sino IP compatible IPv6
      return req.user?.id || ipKeyGenerator(req);
    },
  });
};

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
};