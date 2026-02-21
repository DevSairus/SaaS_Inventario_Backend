// backend/src/models/auth/Tenant.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

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
  slug: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  business_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  tax_id: {
    type: DataTypes.STRING,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  logo_url: {
    type: DataTypes.STRING,
    allowNull: true
  },
  website: {
    type: DataTypes.STRING,
    allowNull: true
  },

  // Personalización
  primary_color: {
    type: DataTypes.STRING,
    defaultValue: '#3B82F6'
  },
  secondary_color: {
    type: DataTypes.STRING,
    defaultValue: '#1E40AF'
  },
  pdf_config: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },

  // Suscripción
  plan: {
    type: DataTypes.STRING,
    defaultValue: 'free',
    validate: {
      isIn: [['free', 'basic', 'premium', 'enterprise']]
    }
  },
  subscription_status: {
    type: DataTypes.STRING,
    defaultValue: 'trial',
    validate: {
      isIn: [['trial', 'active', 'suspended', 'cancelled']]
    }
  },
  trial_ends_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  subscription_starts_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  next_billing_date: {
    type: DataTypes.DATE,
    allowNull: true
  },

  // Límites del plan
  max_users: {
    type: DataTypes.INTEGER,
    defaultValue: 3
  },
  max_clients: {
    type: DataTypes.INTEGER,
    defaultValue: 50
  },
  max_products: {
    type: DataTypes.INTEGER,
    defaultValue: 100
  },
  max_warehouses: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  max_invoices_per_month: {
    type: DataTypes.INTEGER,
    defaultValue: 100
  },

  // Features y configuración
  features: {
    type: DataTypes.JSONB,
    defaultValue: {
      basic_reports: true,
      advanced_reports: false,
      barcode_scanner: true,
      multi_warehouse: false,
      api_access: false
    }
  },
  business_config: {
    type: DataTypes.JSONB,
    defaultValue: {
      currency: 'COP',
      timezone: 'America/Bogota',
      locale: 'es-CO',
      date_format: 'DD/MM/YYYY',
      cost_method: 'weighted_average'
    }
  },

  // Estado
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
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
  tableName: 'tenants',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Tenant;