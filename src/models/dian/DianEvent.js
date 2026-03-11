// backend/src/models/dian/DianEvent.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const DianEvent = sequelize.define('DianEvent', {
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
  sale_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sales', key: 'id' },
    onDelete: 'SET NULL',
  },
  event_type: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'SendBillSync | SendTestSetAsync | GetStatusZip | GetNumberingRange',
  },
  document_type: {
    type: DataTypes.STRING(30),
    comment: 'Invoice | CreditNote | DebitNote',
  },
  invoice_number: {
    type: DataTypes.STRING(50),
    comment: 'Número completo con prefijo',
  },
  cufe: {
    type: DataTypes.STRING(200),
  },
  request_xml: {
    type: DataTypes.TEXT,
    comment: 'XML enviado a la DIAN (sin firma para auditoría)',
  },
  response_raw: {
    type: DataTypes.TEXT,
    comment: 'Respuesta cruda SOAP de la DIAN',
  },
  status: {
    type: DataTypes.STRING(30),
    comment: 'accepted | rejected | error | pending',
  },
  error_message: {
    type: DataTypes.TEXT,
  },
  is_test: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  tableName: 'dian_events',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = DianEvent;