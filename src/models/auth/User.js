// backend/src/models/auth/User.js
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
    allowNull: true,
    references: {
      model: 'tenants',
      key: 'id'
    }
  },
  email: {
    // Nullable: un técnico con has_system_access = false no tiene email
    // (nunca inicia sesión). Ver validador de modelo más abajo.
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  password_hash: {
    // Nullable por el mismo motivo que email (ver has_system_access).
    type: DataTypes.STRING,
    allowNull: true
  },
  has_system_access: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: 'false = técnico solo para asignación de trabajos (sin login, sin email/password_hash)'
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
    defaultValue: 'user',
    validate: {
      isIn: [[
        'super_admin',
        'admin',
        'manager',
        'seller',
        'warehouse_keeper',
        'accountant',
        'user',
        'viewer',
        'technician',
        'support'
      ]]
    }
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Documento/cédula -- no todos los usuarios lo tienen cargado (se pide
  // la primera vez que hace falta, ej. al vincular como técnico/asesor
  // ante la Ensambladora, ver ensambladora/tecnicos.controller.js).
  cedula: {
    type: DataTypes.STRING,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  last_login: {
    type: DataTypes.DATE,
    allowNull: true
  },
  wa_workspace_prefs: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Toggles visuales del workspace WhatsApp (funciones plus del asesor)',
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'users',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeValidate(user) {
      if (user.email) {
        user.email = String(user.email).toLowerCase().trim();
      }
    }
  },
  validate: {
    // Si el usuario tiene acceso al sistema, email y password_hash son
    // obligatorios (login los necesita). Un técnico sin acceso
    // (has_system_access = false) puede tener ambos en null.
    accessRequiresCredentials() {
      if (this.has_system_access) {
        if (!this.email) {
          throw new Error('El email es requerido cuando el usuario tiene acceso al sistema');
        }
        if (!this.password_hash) {
          throw new Error('La contraseña es requerida cuando el usuario tiene acceso al sistema');
        }
      } else if (this.role !== 'technician') {
        throw new Error('Un usuario sin acceso al sistema solo puede tener el rol technician');
      }
    }
  }
});

module.exports = User; 