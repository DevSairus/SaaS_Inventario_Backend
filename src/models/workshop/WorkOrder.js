// backend/src/models/workshop/WorkOrder.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WorkOrder = sequelize.define('WorkOrder', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' }
  },
  order_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'OT-2026-0001'
  },
  // Vehículo y cliente
  vehicle_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'vehicles', key: 'id' }
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'customers', key: 'id' },
    onDelete: 'SET NULL'
  },
  // Técnico asignado
  technician_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL'
  },
  // Bodega de donde salen los repuestos
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'warehouses', key: 'id' },
    onDelete: 'SET NULL'
  },
  // Estado del flujo
  status: {
    type: DataTypes.ENUM('recibido', 'en_proceso', 'en_espera', 'listo', 'entregado', 'cancelado'),
    defaultValue: 'recibido',
    comment: 'recibido → en_proceso → listo → entregado'
  },
  // Datos de ingreso
  mileage_in: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Kilometraje al ingreso'
  },
  mileage_out: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Kilometraje al entregar'
  },
  // Descripción del problema
  problem_description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Descripción del problema reportado por el cliente'
  },
  diagnosis: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Diagnóstico técnico'
  },
  work_performed: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Trabajo realizado'
  },
  // Fotos (URLs Cloudinary o locales)
  photos_in: {
    type: DataTypes.JSONB,
    defaultValue: [],
    comment: 'Fotos de ingreso: [{url, public_id, caption}]'
  },
  photos_out: {
    type: DataTypes.JSONB,
    defaultValue: [],
    comment: 'Fotos de entrega: [{url, public_id, caption}]'
  },
  // Fechas
  received_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  promised_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Fecha prometida de entrega'
  },
  completed_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  delivered_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Totales
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  // Vínculo con remisión generada
  sale_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sales', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Remisión generada al entregar'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  internal_notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL'
  },
  // Liquidación de comisiones
  settled_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Fecha en que la mano de obra fue liquidada'
  },
  settlement_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Liquidación en la que fue incluida'
  }
}, {
  tableName: 'work_orders',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'order_number'], unique: true },
    { fields: ['tenant_id', 'status'] },
    { fields: ['vehicle_id'] },
    { fields: ['customer_id'] }
  ]
});

module.exports = WorkOrder;