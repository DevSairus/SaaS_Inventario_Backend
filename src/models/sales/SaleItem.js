// backend/src/models/sales/SaleItem.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SaleItem = sequelize.define('SaleItem', {
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
    allowNull: false,
    references: { model: 'sales', key: 'id' },
    onDelete: 'CASCADE',
  },
  // ── Tipo de línea ─────────────────────────────────────────
  item_type: {
    type: DataTypes.ENUM('product', 'service', 'free_line'),
    allowNull: false,
    defaultValue: 'product',
    comment: 'product = del catálogo con inventario, service = del catálogo sin inventario, free_line = línea libre ad-hoc'
  },
  // ─────────────────────────────────────────────────────────
  product_id: {
    type: DataTypes.UUID,
    allowNull: true, // null para free_line
    references: { model: 'products', key: 'id' },
    onDelete: 'RESTRICT',
  },
  product_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  product_sku: {
    type: DataTypes.STRING(100),
  },
  quantity: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  unit_price: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  discount_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
  },
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  tax_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 19,
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  // ── Impuestos adicionales ─────────────────────────────────
  inc_rate:   { type: DataTypes.DECIMAL(5, 2), defaultValue: 0, comment: 'Tasa INC (%)' },
  inc_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0, comment: 'Monto INC' },
  ica_rate:   { type: DataTypes.DECIMAL(5, 4), defaultValue: 0, comment: 'Tasa ICA (‰)' },
  ica_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0, comment: 'Monto ICA' },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
  },
  notes: {
    type: DataTypes.TEXT,
  },
  // Técnico responsable de este ítem (puede diferir del técnico de la venta)
  technician_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  // Aprobación por ítem de cotizaciones (document_type='cotizacion') — mismo
  // patrón que WorkOrderItem.approval_status. Default 'aprobado' para que
  // los ítems de ventas normales (sin flujo de cotización) se comporten
  // exactamente igual que antes de esta funcionalidad.
  approval_status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'aprobado',
    validate: { isIn: [['pendiente', 'aprobado', 'rechazado']] },
  },
  rejection_reason: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
}, {
  tableName: 'sale_items',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['sale_id'] },
    { fields: ['product_id'] },
    { fields: ['item_type'] },
  ],
});

module.exports = SaleItem;