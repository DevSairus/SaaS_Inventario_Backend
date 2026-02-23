// backend/src/models/workshop/Vehicle.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Vehicle = sequelize.define('Vehicle', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' }
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'customers', key: 'id' },
    onDelete: 'SET NULL'
  },
  // Identificación
  plate: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: 'Número de placa'
  },
  brand: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Marca del vehículo'
  },
  model: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Modelo del vehículo'
  },
  year: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  color: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  vin: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Número de chasis / VIN'
  },
  engine: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Cilindraje / tipo de motor'
  },
  fuel_type: {
    type: DataTypes.ENUM('gasolina', 'diesel', 'gas', 'hibrido', 'electrico', 'otro'),
    defaultValue: 'gasolina'
  },
  current_mileage: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Último kilometraje registrado'
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
  tableName: 'vehicles',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'plate'] },
    { fields: ['customer_id'] }
  ]
});

module.exports = Vehicle;