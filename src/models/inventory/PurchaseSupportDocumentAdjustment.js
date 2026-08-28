// backend/src/models/inventory/PurchaseSupportDocumentAdjustment.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// "Nota de Ajuste al Documento Soporte" — cumple el rol de crédito/débito
// para el Documento Soporte, pero es un tipo de documento DIAN propio (no
// es "nota crédito"/"nota débito"). A diferencia de la nota crédito de
// factura (que solo queda enlazada por texto libre en `Sale.notes`, ver
// dian.controller.js#createAndSendCreditNote), acá `purchase_id` es FK real.
const PurchaseSupportDocumentAdjustment = sequelize.define('PurchaseSupportDocumentAdjustment', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
  },
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'purchases', key: 'id' },
    comment: 'FK real al Documento Soporte original.',
  },
  adjustment_type: {
    type: DataTypes.STRING(10),
    allowNull: false,
    validate: { isIn: [['credit', 'debit']] },
    comment: 'DIAN los llama "concepto de ajuste"',
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  items: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  adjustment_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  cuds: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  dian_status: {
    type: DataTypes.STRING(30),
    defaultValue: 'not_applicable',
    comment: 'not_applicable | pending | sending | accepted | rejected',
  },
  dian_response: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  dian_sent_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  dian_accepted_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  dian_error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'purchase_support_document_adjustments',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PurchaseSupportDocumentAdjustment;
