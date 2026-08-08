const logger = require('../../config/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const audit = require('../../utils/audit');

const User = require('../../models/auth/User');
const Tenant = require('../../models/auth/Tenant');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'; // Configurable via env, default 24h
const IMPERSONATION_EXPIRES_IN = process.env.IMPERSONATION_EXPIRES_IN || '2h';

const login = async (req, res) => {
  try {
    const { email, password, tenant_id } = req.body;

    /* =====================================================
       VALIDACIONES BÁSICAS
    ===================================================== */

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email y password son requeridos'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 8 caracteres'
      });
    }

    /* =====================================================
       BUSCAR USUARIO SEGÚN CONTEXTO MULTI-TENANT
    ===================================================== */

    let user;

    // 🔐 Si se envía tenant_id → login multi-tenant
    if (tenant_id) {
      user = await User.findOne({
        where: {
          email: email.toLowerCase().trim(),
          tenant_id: tenant_id
        }
      });
    } else {
      // ⚠️ Permitir login sin tenant SOLO para super_admin
      user = await User.findOne({
        where: {
          email: email.toLowerCase().trim()
        }
      });
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    /* =====================================================
       VALIDAR TENANT SI APLICA
    ===================================================== */

    if (user.tenant_id) {
      const tenant = await Tenant.findByPk(user.tenant_id);

      if (!tenant) {
        return res.status(403).json({
          success: false,
          message: 'Credenciales inválidas'
        });
      }

      if (!tenant.is_active) {
        return res.status(403).json({
          success: false,
          message: 'Esta empresa fue desactivada. Contacta a soporte para más información.',
          code: 'TENANT_INACTIVE'
        });
      }

      // Mensajes distintos a propósito -- el usuario necesita saber SI PUEDE
      // resolverlo pagando (suspendido/trial vencido) o si la cuenta ya no
      // existe como tal (cancelada), no un "contacte a soporte" genérico
      // que no dice si es por dinero, por decisión propia, o por un error.
      if (tenant.subscription_status === 'suspended') {
        return res.status(402).json({
          success: false,
          message: 'Tu suscripción está suspendida por falta de pago. Contacta a soporte para regularizar el pago y reactivar el servicio.',
          code: 'SUBSCRIPTION_SUSPENDED'
        });
      }

      if (tenant.subscription_status === 'cancelled') {
        return res.status(403).json({
          success: false,
          message: 'Tu suscripción fue cancelada. Contacta a soporte si querés reactivarla.',
          code: 'SUBSCRIPTION_CANCELLED'
        });
      }

      if (tenant.subscription_status === 'trial' && tenant.trial_ends_at) {
        if (new Date() > new Date(tenant.trial_ends_at)) {
          return res.status(402).json({
            success: false,
            message: 'Tu período de prueba terminó. Contacta a soporte para activar tu suscripción y seguir usando el sistema.',
            code: 'TRIAL_EXPIRED'
          });
        }
      }
    }

    /* =====================================================
       VALIDAR PASSWORD
    ===================================================== */

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    /* =====================================================
       ACTUALIZAR ÚLTIMO LOGIN
    ===================================================== */

    await user.update({ last_login: new Date() });

    /* =====================================================
       GENERAR TOKEN
    ===================================================== */

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    /* =====================================================
       RESPUESTA
    ===================================================== */

    // Audit: registrar login exitoso
    setImmediate(() => audit({ tenant_id: user.tenant_id, user_id: user.id, action: 'LOGIN', entity: 'user', entity_id: user.id, changes: { email: user.email }, req }));

    res.json({
      success: true,
      message: 'Login exitoso',
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          tenant_id: user.tenant_id
        }
      }
    });

  } catch (error) {
    logger.error('Error en login:', error);
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    });
  }
};

/* =====================================================
   PERFIL
===================================================== */

const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password_hash'] }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    res.json({
      success: true,
      data: user
    });

  } catch (error) {
    logger.error('Error en getProfile:', error);
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    });
  }
};

/* =====================================================
   VERIFY TOKEN
===================================================== */

const verifyToken = (req, res) => {
  res.json({
    success: true,
    message: 'Token válido',
    data: {
      user: req.user
    }
  });
};

/* =====================================================
   REFRESH TOKEN
   Re-emite un token nuevo con los datos actuales del usuario
   El frontend lo llama cada 10 min para mantener la sesión
===================================================== */

const refreshToken = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'email', 'role', 'tenant_id', 'is_active'],
    });

    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: 'Usuario no válido' });
    }

    const payload = { id: user.id, email: user.email, role: user.role, tenant_id: user.tenant_id };

    // Si esta sesión es una impersonación de soporte, el claim debe sobrevivir
    // al refresh — si no, se perdería a los 10 min (ver SessionKeepAlive.jsx)
    // y la sesión dejaría de estar marcada/bloqueada de rutas de superadmin.
    const isImpersonating = Boolean(req.user.impersonated_by);
    if (isImpersonating) {
      payload.impersonated_by = req.user.impersonated_by;
    }

    const token = jwt.sign(
      payload,
      JWT_SECRET,
      { expiresIn: isImpersonating ? IMPERSONATION_EXPIRES_IN : JWT_EXPIRES_IN }
    );

    res.json({ success: true, data: { token } });
  } catch (error) {
    logger.error('Error en refreshToken:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

/* =====================================================
   FIN DE IMPERSONACIÓN
   Cierra una sesión de soporte iniciada desde superadmin — vive en /api/auth
   (no en /api/superadmin) para que una sesión impersonada, bloqueada de las
   rutas de superadmin, sí pueda terminarse a sí misma.
===================================================== */

const endImpersonation = async (req, res) => {
  if (!req.user.impersonated_by) {
    return res.status(400).json({ success: false, message: 'No estás en una sesión de soporte' });
  }

  setImmediate(() => audit({
    tenant_id: req.user.tenant_id,
    user_id: req.user.impersonated_by,
    action: 'IMPERSONATE_END',
    entity: 'user',
    entity_id: req.user.id,
    changes: { impersonated_email: req.user.email },
    req,
  }));

  res.json({ success: true, message: 'Sesión de soporte finalizada' });
};

module.exports = {
  login,
  getProfile,
  verifyToken,
  refreshToken,
  endImpersonation,
};