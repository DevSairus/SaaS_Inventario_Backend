// backend/src/models/workshop/WorkOrderQuoteRequest.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Agrupa los ítems de work_order_items que se enviaron a aprobar al cliente
// de esta OT. Hay UNA sola fila por OT (ver sendQuoteRequest): si ya existe,
// los ítems 'pendiente' nuevos se suman ahí (quote_request_id) y la fila
// vuelve a 'enviada' -- así el cliente ve un único enlace/bloque con todo lo
// cotizado, en vez de un bloque nuevo por cada ronda de ítems agregados.
// Los ítems ya decididos (aprobado/rechazado) en una ronda anterior no se
// tocan al reabrir la ronda: solo los nuevos 'pendiente' quedan sujetos a
// la respuesta del cliente.
const WorkOrderQuoteRequest = sequelize.define('WorkOrderQuoteRequest', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  work_order_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'work_orders', key: 'id' },
    onDelete: 'CASCADE',
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'enviada',
    validate: { isIn: [['enviada', 'respondida']] },
  },
  sent_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  responded_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  approved_by_name: {
    type: DataTypes.STRING(150),
    allowNull: true,
  },
  approved_by_document: {
    type: DataTypes.STRING(30),
    allowNull: true,
  },
  approved_ip: {
    type: DataTypes.STRING(45),
    allowNull: true,
  },
  staff_seen_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'work_order_quote_requests',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['work_order_id'] },
  ],
});

module.exports = WorkOrderQuoteRequest;
