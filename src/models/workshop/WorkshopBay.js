// backend/src/models/workshop/WorkshopBay.js
// Bahía / elevador / puesto de trabajo de una sede. La OT que la ocupa se
// guarda en work_orders.bay_id. Ver services/workshop/workshopBoard.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const BAY_KINDS = ['bahia', 'elevador', 'lavado', 'alineacion', 'otro'];

const WorkshopBay = sequelize.define('WorkshopBay', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  branch_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'branches', key: 'id' },
  },
  name: {
    type: DataTypes.STRING(60),
    allowNull: false,
  },
  kind: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'bahia',
    validate: { isIn: [BAY_KINDS] },
  },
  sort_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'workshop_bays',
  timestamps: true,
  underscored: true,
});

WorkshopBay.BAY_KINDS = BAY_KINDS;

module.exports = WorkshopBay;
