// backend/src/models/finance/CustomerAdvance.js
// Anticipo de Cliente: dinero recibido de un cliente sin venta todavía
// contra qué aplicarlo. Conceptualmente es un pasivo (280505 — Anticipos de
// Clientes), no un abono — mientras no se aplique, la empresa le debe ese
// dinero al cliente. Ver Anticipos-Clientes-Analisis-y-Plan.md §4.1.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerAdvance = sequelize.define('CustomerAdvance', {
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
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customers', key: 'id' },
  },
  advance_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  applied_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  refunded_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  balance: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'amount - applied_amount - refunded_amount, mantenido en cada update',
  },
  method: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  received_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  cash_session_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'cash_sessions', key: 'id' },
  },
  reference_note: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  triggers_iva: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'true si el anticipo es para un servicio no terminado (Art. 429 lit. c ET): causa IVA al recibirse, no al facturar',
  },
  refund_history: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
    comment: 'Historial de devoluciones: [{ refund_id, amount, date, method, user_id, reason }]',
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'fully_applied', 'fully_refunded', 'voided']] },
  },
  voided_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  voided_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  voided_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'customer_advances',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = CustomerAdvance;
