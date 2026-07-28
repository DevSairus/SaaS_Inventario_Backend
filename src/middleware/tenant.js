// src/middleware/tenant.js (versión con schema-per-tenant)
const Tenant = require('../models/auth/Tenant');
const { runWithTenantSchema } = require('../config/tenantContext');

const tenantMiddleware = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }

    if (req.user.role === 'super_admin') {
      req.tenant_id = null;
      req.tenant = null;
      req.is_super_admin = true;
      // superadmin opera sin schema fijo (o contra `public` para vistas agregadas)
      return next();
    }

    if (!req.user.tenant_id) {
      return res.status(403).json({ success: false, message: 'Usuario no asociado a ninguna empresa' });
    }

    const tenant = await Tenant.findByPk(req.user.tenant_id);
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Empresa no encontrada' });
    }
    if (!tenant.is_active) {
      return res.status(403).json({ success: false, message: 'Esta empresa ha sido desactivada. Contacte a soporte.' });
    }
    if (tenant.subscription_status === 'suspended') {
      return res.status(402).json({ success: false, message: 'Suscripción suspendida.', code: 'SUBSCRIPTION_SUSPENDED' });
    }
    if (tenant.subscription_status === 'cancelled') {
      return res.status(403).json({ success: false, message: 'Suscripción cancelada.', code: 'SUBSCRIPTION_CANCELLED' });
    }
    if (tenant.subscription_status === 'trial' && tenant.trial_ends_at && new Date() > new Date(tenant.trial_ends_at)) {
      return res.status(402).json({ success: false, message: 'Período de prueba finalizado.', code: 'TRIAL_EXPIRED' });
    }

    req.tenant_id = tenant.id;
    req.tenant = tenant;
    req.is_super_admin = false;

    // MIGRACIÓN GRADUAL: si el tenant YA fue migrado (tiene schema_name),
    // sus queries van a su schema dedicado. Si todavía no (schema_name
    // null), sigue operando en modo legado (public + tenant_id) sin que
    // el resto de la app note diferencia. Esto permite cortar tenant por
    // tenant sin downtime ni big-bang.
    if (tenant.schema_name) {
      return runWithTenantSchema(tenant.schema_name, next);
    }
    return next();
  } catch (error) {
    console.error('Error en tenant middleware:', error);
    res.status(500).json({
      success: false,
      message: 'Error al validar la empresa',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const optionalTenantMiddleware = async (req, res, next) => {
  try {
    if (req.user && req.user.tenant_id) {
      const tenant = await Tenant.findByPk(req.user.tenant_id);
      req.tenant_id = tenant?.id || null;
      req.tenant = tenant || null;
      if (tenant?.schema_name) {
        return runWithTenantSchema(tenant.schema_name, next);
      }
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

module.exports = { tenantMiddleware, optionalTenantMiddleware };