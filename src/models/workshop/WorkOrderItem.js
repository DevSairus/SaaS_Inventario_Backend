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
    type: DataTypes.ENUM('repuesto', 'servicio', 'mano_obra'),
    allowNull: false,
    comment: 'repuesto = descuenta inventario, servicio/mano_obra = product_type service'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  // Snapshot del producto al momento de agregar
  product_name: {
    type: DataTypes.STRING(255),
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
  }
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