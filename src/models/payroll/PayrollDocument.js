// backend/src/models/payroll/PayrollDocument.js
//
// Documento Soporte de Pago de Nómina Electrónica — un registro por
// EMPLEADO por PERIODO (el Anexo Técnico exige un NominaIndividual
// independiente por cada trabajador, no uno agregado por periodo). Análogo
// directo a SupportDocument.js — mismo principio de snapshot para poder
// reconstruir/auditar el documento tal como se envió, sin depender de que
// los datos "vivos" del empleado/catálogo no hayan cambiado después.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollDocument = sequelize.define('PayrollDocument', {
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
    allowNull: true,
    references: { model: 'branches', key: 'id' },
  },
  employee_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'employees', key: 'id' },
  },
  payroll_period_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'payroll_periods', key: 'id' },
  },
  payroll_document_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Prefijo + consecutivo (NumNE) — equivalente a SupportDocument.support_document_number',
  },
  cune: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Código Único de Documento Soporte de Pago de Nómina Electrónica — equivalente a cuds/cufe',
  },
  devengados_total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  deducciones_total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  comprobante_total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  snapshot_liquidation: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Salida completa de payrollService.js#liquidarEmpleado() al momento de emitir',
  },
  xml_content: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'XML firmado enviado a DIAN',
  },
  pdf_path: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Ruta de la representación gráfica generada (Fase 3) — NULL hasta que se genere',
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
  email_sent_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'NULL hasta que payrollEmailService.js confirme el envío al empleado',
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'payroll_documents',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['tenant_id', 'payroll_period_id'] },
    { fields: ['tenant_id', 'employee_id'] },
    { fields: ['tenant_id', 'dian_status'] },
  ],
});

module.exports = PayrollDocument;