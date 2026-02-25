const logger = require('../../config/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  password_hash: {
    type: DataTypes.STRING,
    allowNull: false
  },
  first_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  last_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  role: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'user'
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  last_login: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'users',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

const Tenant = sequelize.define('Tenant', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  company_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  subscription_status: {
    type: DataTypes.STRING,
    defaultValue: 'trial'
  },
  trial_ends_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'tenants',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '365d'; // Sesión de larga duración - sin expiración práctica

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

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

    const user = await User.findOne({
      where: { email: email.toLowerCase().trim() }
    });

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

    // Verificar estado del tenant (solo para usuarios no-super_admin)
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

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    await user.update({ last_login: new Date() });

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
      message: 'Error en el servidor'});
  }
};

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