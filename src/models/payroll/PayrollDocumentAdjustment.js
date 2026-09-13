// backend/src/models/payroll/PayrollDocumentAdjustment.js
//
// "Nota de Ajuste al Documento Soporte de Pago de Nómina Electrónica" —
// análogo directo a SupportDocumentAdjustment.js, con la diferencia de que
// el Anexo Técnico de Nómina distingue Reemplazar(1)/Eliminar(2) en vez de
// crédito/débito.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollDocumentAdjustment = sequelize.define('PayrollDocumentAdjustment', {
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
  payroll_document_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'payroll_documents', key: 'id' },
    comment: 'FK real al Documento Soporte de Nómina original.',
  },
  adjustment_type: {
    type: DataTypes.STRING(10),
    allowNull: false,
    validate: { isIn: [['replace', 'delete']] },
    comment: 'Anexo Técnico §2: Reemplazar(1) / Eliminar(2)',
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  snapshot_liquidation: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Liquidación corregida — solo aplica si adjustment_type=replace; NULL si delete',
  },
  devengados_total: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  deducciones_total: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  comprobante_total: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  adjustment_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  cune: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  xml_content: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  dian_status: {
    type: DataTypes.STRING(30),
    defaultValue: 'pending',
    comment: 'pending | sending | accepted | rejected',
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
  tableName: 'payroll_document_adjustments',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['payroll_document_id'] },
  ],
});

module.exports = PayrollDocumentAdjustment;