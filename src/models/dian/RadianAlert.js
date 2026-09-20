// backend/src/models/dian/RadianAlert.js
// Avisos generados por el job radian-deadlines (Fase 3) — NUNCA emite
// eventos solo, solo avisa (033/034 requieren acción explícita del usuario,
// ver RADIAN-Analisis-y-Plan.md §5.7). Mismo patrón que PayableAlert.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const RadianAlert = sequelize.define('RadianAlert', {
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
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'purchases', key: 'id' },
  },
  sale_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sales', key: 'id' },
  },
  alert_type: {
    type: DataTypes.STRING(40),
    allowNull: false,
    validate: { isIn: [['purchase_deadline_due_soon', 'purchase_deadline_overdue', 'sale_tacit_acceptance_ready']] },
  },
  severity: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'warning',
    validate: { isIn: [['info', 'warning', 'critical']] },
  },
  deadline_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'resolved']] },
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  resolved_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'radian_alerts',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = RadianAlert;
