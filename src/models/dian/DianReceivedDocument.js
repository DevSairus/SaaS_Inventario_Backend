// backend/src/models/dian/DianReceivedDocument.js
//
// Documento electrónico recibido según el Excel de "Documentos" del portal
// DIAN (ver migración 2026100201-create-dian-received-documents.js).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const money = () => ({ type: DataTypes.DECIMAL(15, 2), defaultValue: 0 });

const DianReceivedDocument = sequelize.define('DianReceivedDocument', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  cufe: { type: DataTypes.STRING(200), allowNull: false },
  document_type: { type: DataTypes.STRING(120) },
  folio: { type: DataTypes.STRING(60) },
  prefix: { type: DataTypes.STRING(20) },
  currency: { type: DataTypes.STRING(10) },
  payment_form: { type: DataTypes.STRING(60) },
  payment_method: { type: DataTypes.STRING(120) },
  issue_date: { type: DataTypes.DATEONLY },
  reception_date: { type: DataTypes.DATE },
  issuer_nit: { type: DataTypes.STRING(30) },
  issuer_name: { type: DataTypes.STRING(255) },
  receiver_nit: { type: DataTypes.STRING(30) },
  receiver_name: { type: DataTypes.STRING(255) },
  iva: money(),
  ica: money(),
  inc: money(),
  other_taxes: { type: DataTypes.JSONB, defaultValue: {} },
  rete_iva: money(),
  rete_renta: money(),
  rete_ica: money(),
  total: money(),
  dian_status: { type: DataTypes.STRING(80) },
  dian_group: { type: DataTypes.STRING(40) },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    validate: { isIn: [['pending', 'loaded', 'discarded']] },
  },
  purchase_id: { type: DataTypes.UUID, allowNull: true },
  expense_id: { type: DataTypes.UUID, allowNull: true },
  supplier_id: { type: DataTypes.UUID, allowNull: true },
  xml_content: { type: DataTypes.TEXT },
  xml_fetched_at: { type: DataTypes.DATE },
  xml_fetch_error: { type: DataTypes.TEXT },
  discard_reason: { type: DataTypes.STRING(255) },
  first_seen_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  last_seen_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  times_seen: { type: DataTypes.INTEGER, defaultValue: 1 },
}, {
  tableName: 'dian_received_documents',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = DianReceivedDocument;
