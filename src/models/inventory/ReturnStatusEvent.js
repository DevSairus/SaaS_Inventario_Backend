const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Bitácora de estados de las devoluciones de venta y de compra (req. 3.5 / 4.2,
// migración 2026111303). Una fila por cada cambio de estado: quién, cuándo y
// una nota (motivo de rechazo / reversión). La escribe el hook de
// services/returns/returnStateMachine.js, no los controladores.
const ReturnStatusEvent = sequelize.define('ReturnStatusEvent', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  return_type: { type: DataTypes.STRING(10), allowNull: false }, // 'customer' | 'supplier'
  return_id: { type: DataTypes.UUID, allowNull: false },
  from_status: { type: DataTypes.STRING(20), allowNull: true }, // null = creación
  to_status: { type: DataTypes.STRING(20), allowNull: false },
  user_id: { type: DataTypes.UUID, allowNull: true },
  note: { type: DataTypes.TEXT, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  tableName: 'return_status_events',
  timestamps: false,
  underscored: true,
  indexes: [{ fields: ['return_type', 'return_id'] }, { fields: ['tenant_id'] }],
});

module.exports = ReturnStatusEvent;
