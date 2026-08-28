// backend/src/models/dian/SupportDocument.js
//
// Documento Soporte DIAN (adquisiciones a sujetos no obligados a
// facturar) — tabla dedicada en vez de columnas dian_* duplicadas en
// `purchases` y `expenses` por separado. Mismo principio de nullable-FK
// por origen que ya usa DianEvent con sale_id/purchase_id.
// Ver Documento-Soporte-Plan-v2.md §1.
//
// La fila solo existe si el documento se generó — no hay un
// dian_status='not_applicable' poblado por defecto en cada compra/gasto,
// a diferencia del diseño anterior (Purchase.dian_status).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupportDocument = sequelize.define('SupportDocument', {
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
  branch_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'branches', key: 'id' },
    comment: 'Sede de la resolución DIAN con la que se emitió este documento.',
  },
  source_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [['purchase', 'expense']] },
  },
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'purchases', key: 'id' },
  },
  expense_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'expenses', key: 'id' },
  },
  support_document_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Prefijo + consecutivo — equivalente a Sale.dian_invoice_number',
  },
  cuds: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Código Único del Documento Soporte — equivalente a cufe, algoritmo/orden de concatenación distintos (ver plan §4 del análisis original).',
  },
  dian_status: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'pending',
    validate: { isIn: [['pending', 'sending', 'accepted', 'rejected']] },
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
  seller_snapshot: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Fase 5 — copia del objeto `seller` (forma dianKit.buildSellerFromSupplier/' +
      'buildSellerFromAdHoc) usado para GENERAR este Documento Soporte. Necesario para poder ' +
      'construir una Nota de Ajuste después: si el origen es un Expense con vendedor ad-hoc ' +
      '(sin Supplier real), esos datos no vivían en ningún otro lado tras el envío original ' +
      '-- ver dian.controller.js#createSupportDocumentAdjustment.',
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'support_documents',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['tenant_id', 'branch_id'] },
    { fields: ['tenant_id', 'dian_status'] },
  ],
});

module.exports = SupportDocument;
