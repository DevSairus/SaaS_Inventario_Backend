// backend/src/models/common/Attachment.js
// Adjunto de cualquier documento (migración 2026110602). El archivo vive en
// almacenamiento privado: ver services/attachments/attachmentStorage.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ATTACHMENT_KINDS = ['invoice_pdf', 'invoice_xml', 'payment_proof', 'delivery_note', 'photo', 'contract', 'quote', 'rut', 'chamber_of_commerce', 'other'];

const Attachment = sequelize.define('Attachment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  entity_type: { type: DataTypes.STRING(30), allowNull: false },
  entity_id: { type: DataTypes.UUID, allowNull: false },
  kind: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'other', validate: { isIn: [ATTACHMENT_KINDS] } },
  description: { type: DataTypes.STRING(255), allowNull: true },
  // Vigencia del documento (p. ej. Cámara de Comercio del proveedor).
  valid_until: { type: DataTypes.DATEONLY, allowNull: true },
  file_name: { type: DataTypes.STRING(255), allowNull: false },
  mime_type: { type: DataTypes.STRING(120), allowNull: true },
  size_bytes: { type: DataTypes.INTEGER, allowNull: true },
  sha256: { type: DataTypes.STRING(64), allowNull: true },
  storage: { type: DataTypes.STRING(20), allowNull: false },
  storage_key: { type: DataTypes.STRING(500), allowNull: false },
  resource_type: { type: DataTypes.STRING(20), allowNull: true },
  format: { type: DataTypes.STRING(20), allowNull: true },
  uploaded_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'attachments',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

Attachment.KINDS = ATTACHMENT_KINDS;

module.exports = Attachment;
