const Tenant = require('../models/auth/Tenant');

/**
 * Middleware para validar y cargar el tenant del usuario autenticado
 */
const tenantMiddleware = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado',
      });
    }

    // Super admin no necesita tenant
    if (req.user.role === 'super_admin') {
      req.tenant_id = null;
      req.tenant = null;
      req.is_super_admin = true;
      return next();
    }

    if (!req.user.tenant_id) {
      return res.status(403).json({
        success: false,
        message: 'Usuario no asociado a ninguna empresa',
      });
    }

    const tenant = await Tenant.findByPk(req.user.tenant_id);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Empresa no encontrada',
      });
    }

    if (!tenant.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Esta empresa ha sido desactivada. Contacte a soporte.',
      });
    }

    if (tenant.subscription_status === 'suspended') {
      return res.status(402).json({
        success: false,
        message: 'Suscripción suspendida. Por favor actualice su método de pago.',
        code: 'SUBSCRIPTION_SUSPENDED',
      });
    }

    if (tenant.subscription_status === 'cancelled') {
      return res.status(403).json({
        success: false,
        message: 'Suscripción cancelada. Contacte a ventas para reactivar.',
        code: 'SUBSCRIPTION_CANCELLED',
      });
    }

    if (tenant.subscription_status === 'trial' && tenant.trial_ends_at) {
      if (new Date() > new Date(tenant.trial_ends_at)) {
        return res.status(402).json({
          success: false,
          message: 'Período de prueba finalizado. Por favor seleccione un plan.',
          code: 'TRIAL_EXPIRED',
        });
      }
    }

    req.tenant_id = tenant.id;
    req.tenant = tenant;
    req.is_super_admin = false;

    next();
  } catch (error) {
    console.error('Error en tenant middleware:', error);
    res.status(500).json({
      success: false,
      message: 'Error al validar la empresa',
      error: error.message,
    });
  }
};

/**
 * Middleware opcional - permite acceso sin tenant (para rutas públicas)
 */
const optionalTenantMiddleware = async (req, res, next) => {
  try {
    if (req.user && req.user.tenant_id) {
      const tenant = await Tenant.findByPk(req.user.tenant_id);
      req.tenant_id = tenant?.id || null;
      req.tenant = tenant || null;
    } else {
      req.tenant_id = null;
      req.tenant = null;
    }
    next();
  } catch (error) {
    req.tenant_id = null;
    req.tenant = null;
    next();
  }
};

module.exports = {
  tenantMiddleware,
  optionalTenantMiddleware,
};