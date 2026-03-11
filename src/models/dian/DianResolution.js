// backend/src/models/dian/DianResolution.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const DianResolution = sequelize.define('DianResolution', {
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
  resolution_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Número de resolución DIAN (ej: 18760000001)',
  },
  resolution_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  prefix: {
    type: DataTypes.STRING(10),
    allowNull: false,
    comment: 'Prefijo autorizado (ej: SETP, FV, FE)',
  },
  from_number: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: 'Número inicial del rango autorizado',
  },
  to_number: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: 'Número final del rango autorizado',
  },
  current_number: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: 'Consecutivo actual (siguiente a usar)',
  },
  valid_from: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  valid_to: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  document_type: {
    type: DataTypes.ENUM('invoice', 'credit_note', 'debit_note'),
    defaultValue: 'invoice',
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  is_test: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'TRUE = resolución de habilitación/pruebas',
  },
  notes: {
    type: DataTypes.TEXT,
  },
}, {
  tableName: 'dian_resolutions',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = DianResolution;