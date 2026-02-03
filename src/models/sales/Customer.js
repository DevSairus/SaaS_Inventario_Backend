const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Customer = sequelize.define('Customer', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  customer_type: {
    type: DataTypes.STRING(20),
    defaultValue: 'individual',
  },
  first_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  last_name: {
    type: DataTypes.STRING(255),
  },
  business_name: {
    type: DataTypes.STRING(255),
  },
  trade_name: {
    type: DataTypes.STRING(255),
  },
  tax_id: {
    type: DataTypes.STRING(50),
  },
  email: {
    type: DataTypes.STRING(255),
  },
  phone: {
    type: DataTypes.STRING(20),
  },
  mobile: {
    type: DataTypes.STRING(20),
  },
  address: {
    type: DataTypes.TEXT,
  },
  city: {
    type: DataTypes.STRING(100),
  },
  state: {
    type: DataTypes.STRING(100),
  },
  country: {
    type: DataTypes.STRING(100),
    defaultValue: 'Colombia',
  },
  postal_code: {
    type: DataTypes.STRING(20),
  },
  default_price_list_id: {
    type: DataTypes.UUID,
  },
  customer_category: {
    type: DataTypes.STRING(50),
  },
  credit_limit: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  payment_terms: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  notes: {
    type: DataTypes.TEXT,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'customers',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['tenant_id', 'is_active'] },
    { fields: ['tenant_id', 'tax_id'], unique: true },
  ],
});

// Sobrescribe toJSON para agregar full_name al JSON de respuesta
Customer.prototype.toJSON = function () {
  const values = this.get();
  values.full_name = [values.first_name, values.last_name].filter(Boolean).join(' ');
  return values;
};

module.exports = Customer;