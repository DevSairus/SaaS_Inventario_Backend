// backend/src/models/finance/Receipt.js
// Recibo de Caja: documento formal y numerado que respalda cada pago/abono
// registrado en Ventas o Taller. payment_id es el mismo UUID que ya viaja en
// payment_history y que autoEntries.service usa como JournalEntry.source_id —
// es el vínculo directo hacia el asiento contable, sin duplicar lógica.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Receipt = sequelize.define('Receipt', {
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
  receipt_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  source_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [['sale', 'work_order']] },
  },
  source_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  payment_id: {
    type: DataTypes.UUID,
    allowNull: false,
    comment: 'Mismo UUID guardado en payment_history y usado como JournalEntry.source_id',
  },
  cash_session_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'cash_sessions', key: 'id' },
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  method: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  payment_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  reference: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Número de venta/OT, denormalizado para listar sin joins',
  },
  customer_name: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'voided']] },
  },
  voided_at: {
    type: DataTypes.DATE,
    allowNull: true,
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
  tableName: 'receipts',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Receipt;
