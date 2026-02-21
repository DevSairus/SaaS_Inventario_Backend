const Tenant = require('../models/auth/Tenant');
const { sequelize } = require('../config/database');

/**
 * Middleware para validar y cargar el tenant del usuario autenticado
 * MEJORADO: Ahora configura la variable de sesión PostgreSQL para RLS
 */
const tenantMiddleware = async (req, res, next) => {
  try {
    // El usuario debe estar autenticado primero
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

    // Obtener tenant del usuario
    if (!req.user.tenant_id) {
      return res.status(403).json({
        success: false,
        message: 'Usuario no asociado a ninguna empresa',
      });
    }

    // Cargar datos del tenant
    const tenant = await Tenant.findByPk(req.user.tenant_id);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Empresa no encontrada',
      });
    }

    // Validar que el tenant esté activo
    if (!tenant.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Esta empresa ha sido desactivada. Contacte a soporte.',
      });
    }

    // Validar estado de suscripción
    if (tenant.subscription_status === 'suspended') {
      return res.status(402).json({
        success: false,
        message:
          'Suscripción suspendida. Por favor actualice su método de pago.',
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

    // Validar período de prueba
    if (tenant.subscription_status === 'trial' && tenant.trial_ends_at) {
      const now = new Date();
      const trialEnd = new Date(tenant.trial_ends_at);

      if (now > trialEnd) {
        return res.status(402).json({
          success: false,
          message:
            'Período de prueba finalizado. Por favor seleccione un plan.',
          code: 'TRIAL_EXPIRED',
        });
      }
    }

    // Agregar información del tenant al request
    req.tenant_id = tenant.id;
    req.tenant = tenant;
    req.is_super_admin = false;

    // ============================================================================
    // CRÍTICO: Configurar variable de sesión PostgreSQL para RLS
    // Esta variable es requerida por las políticas de Row Level Security
    // ============================================================================
    try {
      // Usar una query raw de Sequelize para configurar la variable de sesión
      await sequelize.query(
        `SET LOCAL app.current_tenant_id = :tenantId`,
        {
          replacements: { tenantId: tenant.id },
          type: sequelize.QueryTypes.RAW
        }
      );
      
      // Log opcional para debugging (comentar en producción)
      // console.log(`✅ Tenant context set: ${tenant.id}`);
    } catch (error) {
      console.error('⚠️ Error al configurar tenant_id en PostgreSQL:', error.message);
      // Continuar de todos modos - algunas operaciones pueden no requerir RLS
      // pero loguear el error para debugging
    }

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

      // Configurar variable de sesión PostgreSQL si hay tenant
      if (tenant?.id) {
        try {
          await sequelize.query(
            `SET LOCAL app.current_tenant_id = :tenantId`,
            {
              replacements: { tenantId: tenant.id },
              type: sequelize.QueryTypes.RAW
            }
          );
        } catch (error) {
          console.error('Error al configurar tenant_id opcional:', error.message);
        }
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

module.exports = {
  tenantMiddleware,
  optionalTenantMiddleware,
};