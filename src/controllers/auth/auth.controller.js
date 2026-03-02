const logger = require('../../config/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../../models/auth/User');
const Tenant = require('../../models/auth/Tenant');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '365d'; // Sesión larga

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
        message: 'Usuario desactivado'
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
          message: 'Empresa no encontrada'
        });
      }

      if (!tenant.is_active) {
        return res.status(403).json({
          success: false,
          message: 'Esta empresa ha sido desactivada. Contacte a soporte.'
        });
      }

      if (tenant.subscription_status === 'suspended') {
        return res.status(402).json({
          success: false,
          message: 'Suscripción suspendida. Por favor actualice su método de pago.',
          code: 'SUBSCRIPTION_SUSPENDED'
        });
      }

      if (tenant.subscription_status === 'cancelled') {
        return res.status(403).json({
          success: false,
          message: 'Suscripción cancelada. Contacte a ventas para reactivar.',
          code: 'SUBSCRIPTION_CANCELLED'
        });
      }

      if (tenant.subscription_status === 'trial' && tenant.trial_ends_at) {
        if (new Date() > new Date(tenant.trial_ends_at)) {
          return res.status(402).json({
            success: false,
            message: 'Período de prueba finalizado. Por favor seleccione un plan.',
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

module.exports = {
  login,
  getProfile,
  verifyToken
};