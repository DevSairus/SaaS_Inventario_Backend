const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Supplier = sequelize.define('Supplier', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tenants',
      key: 'id'
    }
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  code: {
    type: DataTypes.STRING(50),
    allowNull: true  // CAMBIADO: ahora es opcional
  },
  business_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  trade_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  tax_id: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  phone: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  mobile: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  website: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  city: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  state: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  country: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  postal_code: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  contact_name: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  contact_email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  contact_phone: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  contact_position: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  payment_terms: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    set(value) {
      // Convertir string vacío o undefined a null
      this.setDataValue('payment_terms', value === '' || value === undefined ? null : value);
    }
  },
  credit_limit: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
    defaultValue: null,
    set(value) {
      this.setDataValue('credit_limit', value === '' || value === undefined ? null : value);
    }
  },
  discount_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true,
    defaultValue: null,
    set(value) {
      this.setDataValue('discount_percentage', value === '' || value === undefined ? null : value);
    }
  },
  supplier_type: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  bank_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  account_number: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  account_type: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  rating: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    set(value) {
      this.setDataValue('rating', value === '' || value === undefined ? null : value);
    }
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'suppliers',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Supplier;