// backend/src/models/sales/Sale.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Sale = sequelize.define('Sale', {
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
  sale_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  document_type: {
    type: DataTypes.ENUM('remision', 'factura', 'cotizacion'),
    defaultValue: 'remision',
  },
  customer_id: {
    type: DataTypes.UUID,
    references: { model: 'customers', key: 'id' },
    onDelete: 'SET NULL',
  },
  customer_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  customer_tax_id: { type: DataTypes.STRING(50) },
  customer_email:  { type: DataTypes.STRING(255) },
  customer_phone:  { type: DataTypes.STRING(20) },
  customer_address:{ type: DataTypes.TEXT },
  vehicle_plate: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'Número de placa del vehículo (opcional)',
  },
  // ── Kilometraje ───────────────────────────────────────────
  mileage: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Kilometraje del vehículo al momento del servicio (informativo)',
  },
  // ─────────────────────────────────────────────────────────
  warehouse_id: {
    type: DataTypes.UUID,
    references: { model: 'warehouses', key: 'id' },
    onDelete: 'RESTRICT',
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('draft', 'pending', 'completed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending',
  },
  sale_date: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  delivery_date: { type: DataTypes.DATE },
  credit_days: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Días de plazo pactados para pago. Null = contado.',
  },
  due_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    defaultValue: null,
    comment: 'Fecha límite de pago = sale_date + credit_days.',
  },
  payment_method:  { type: DataTypes.STRING(50) },
  payment_status: {
    type: DataTypes.ENUM('pending', 'partial', 'paid'),
    defaultValue: 'pending',
  },
  paid_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  payment_history: {
    type: DataTypes.JSONB,
    defaultValue: [],
    comment: 'Historial de pagos: [{date, amount, method, user_id}]',
  },
  notes:          { type: DataTypes.TEXT },
  internal_notes: { type: DataTypes.TEXT },
  pdf_url:        { type: DataTypes.STRING(500) },
  created_by: {
    type: DataTypes.UUID,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'sales',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'sale_number'], unique: true },
    { fields: ['tenant_id', 'status'] },
    { fields: ['customer_id'] },
    { fields: ['tenant_id', 'due_date'] },
  ],
});

module.exports = Sale;