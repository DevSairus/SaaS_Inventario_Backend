// backend/src/models/workshop/WorkOrderItem.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WorkOrderItem = sequelize.define('WorkOrderItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  work_order_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'work_orders', key: 'id' },
    onDelete: 'CASCADE'
  },
  // Tipo de ítem
  item_type: {
    type: DataTypes.ENUM('repuesto', 'servicio', 'mano_obra', 'free_line'),
    allowNull: false,
    comment: 'repuesto = descuenta inventario, servicio/mano_obra = product_type service, free_line = línea libre ad-hoc sin producto de catálogo'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: true, // null para free_line
    references: { model: 'products', key: 'id' }
  },
  // Snapshot del producto al momento de agregar
  product_name: {
    type: DataTypes.TEXT, // ver migración 2026092301-widen-item-product-name
    allowNull: false
  },
  product_sku: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  // Cantidad y precios
  quantity: {
    type: DataTypes.DECIMAL(10, 3),
    allowNull: false,
    defaultValue: 1
  },
  unit_price: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  tax_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 19
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  total: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Técnico responsable de este ítem (puede diferir del técnico principal de la OT)
  technician_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  // Control de movimiento de inventario
  inventory_movement_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Referencia al movimiento de inventario generado'
  },
  // Cotización con aprobación del cliente — por defecto 'aprobado' para que
  // los ítems agregados de la forma normal (sin requires_approval) se
  // comporten exactamente igual que antes de esta funcionalidad.
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
  // Ronda de cotización a la que pertenece este ítem (NULL mientras está
  // pendiente de enviar). Ver models/workshop/WorkOrderQuoteRequest.js
  quote_request_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_order_quote_requests', key: 'id' },
    onDelete: 'SET NULL',
  },
  // Categoría de comisión resuelta al agregar el ítem (desde product.category_id
  // o desde diagram_template.system si vino de una marca de diagnóstico). El %
  // NO se congela acá -- se congela recién al liquidar (ver
  // CommissionSettlementItem) para no romper la liquidación de OT ya abiertas
  // si el admin cambia el % de la categoría a mitad de mes.
  commission_category_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'commission_categories', key: 'id' },
    onDelete: 'SET NULL',
  },
  // ── Combo (ver migración 2026092901-create-combos) ────────
  // Las líneas que vienen de un combo comparten combo_group_id. Los campos
  // combo_* son snapshot: el documento no depende de que el combo exista.
  combo_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'combos', key: 'id' },
    onDelete: 'SET NULL',
  },
  combo_group_id: { type: DataTypes.UUID, allowNull: true },
  combo_name: { type: DataTypes.STRING(200), allowNull: true },
  combo_quantity: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
  // false = en pantalla/PDF/DIAN el grupo se muestra solo como nombre + total
  combo_show_breakdown: { type: DataTypes.BOOLEAN, allowNull: true },
}, {
  tableName: 'work_order_items',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['work_order_id'] },
    { fields: ['product_id'] }
  ]
});

module.exports = WorkOrderItem;