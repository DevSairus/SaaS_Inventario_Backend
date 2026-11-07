// backend/src/models/tools/ToolEvent.js
// Evento de la hoja de vida de una herramienta (migración 2026110608).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const TOOL_EVENT_TYPES = ['created', 'assigned', 'returned', 'maintenance', 'calibration', 'repair', 'damage', 'lost', 'retired', 'reactivated', 'note'];

const ToolEvent = sequelize.define('ToolEvent', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  tool_id: { type: DataTypes.UUID, allowNull: false },
  event_type: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [TOOL_EVENT_TYPES] } },
  event_date: { type: DataTypes.DATEONLY, allowNull: false },
  description: { type: DataTypes.STRING(500), allowNull: true },
  cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  supplier_id: { type: DataTypes.UUID, allowNull: true },
  certificate_number: { type: DataTypes.STRING(100), allowNull: true },
  next_due_date: { type: DataTypes.DATEONLY, allowNull: true },
  assignment_id: { type: DataTypes.UUID, allowNull: true },
  project_id: { type: DataTypes.UUID, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'tool_events', timestamps: true, updatedAt: false, underscored: true, createdAt: 'created_at' });

ToolEvent.TYPES = TOOL_EVENT_TYPES;

module.exports = ToolEvent;
