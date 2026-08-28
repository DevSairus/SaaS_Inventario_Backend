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
  branch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'branches', key: 'id' },
    onDelete: 'RESTRICT',
    comment: 'Sede a la que pertenece esta resolución (cada sede maneja su propio consecutivo)',
  },
  resolution_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Número de resolución DIAN (ej: 18760000001) — solo aplica a facturas; NC/ND no requieren resolución DIAN.',
  },
  resolution_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  prefix: {
    type: DataTypes.STRING(4),
    allowNull: false,
    comment: 'Prefijo autorizado (ej: SETP, FV, FE) — máximo 4 caracteres (límite DIAN / @dian-kit)',
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
    allowNull: true,
    comment: 'Solo aplica a facturas (vigencia de la resolución DIAN); NC/ND no la requieren.',
  },
  valid_to: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  document_type: {
    type: DataTypes.ENUM('invoice', 'credit_note', 'debit_note', 'support_document', 'support_document_adjustment'),
    defaultValue: 'invoice',
  },
  technical_key: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Clave técnica propia de ESTA resolución/habilitación. La DIAN entrega una habilitación (y por lo tanto una clave técnica) separada por tipo de documento — la de facturación de venta NO sirve para Documento Soporte. Si viene NULL, el sistema usa tenant.dian_config.technical_key (retrocompatible con las resoluciones de factura ya creadas).',
  },
  test_set_id: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'TestSetId del set de pruebas de ESTA resolución/habilitación (idem technical_key: por tipo de documento). Si viene NULL, se usa tenant.dian_config.test_set_id.',
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