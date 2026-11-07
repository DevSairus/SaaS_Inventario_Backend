// backend/src/models/projects/ProjectBomItem.js
// Línea de la lista de materiales (BOM) de un proyecto, pegada desde Excel.
// Cantidades (ver services/projects/projectBom.service.js):
//   qty_required   lo que pide la obra
//   qty_reserved   apartado del stock y todavía sin despachar (cuenta como
//                  "en trámite", ver services/inventory/stockInProcess.service.js)
//   qty_dispatched ya salió hacia la bodega del proyecto
//   qty_ordered    anotado en pedidos a proveedor
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectBomItem = sequelize.define('ProjectBomItem', {
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
  project_id: { type: DataTypes.UUID, allowNull: false },
  line_no: { type: DataTypes.INTEGER, allowNull: false },
  input_code: { type: DataTypes.STRING(100), allowNull: true },
  input_description: { type: DataTypes.STRING(255), allowNull: true },
  unit: { type: DataTypes.STRING(30), allowNull: true },
  product_id: { type: DataTypes.UUID, allowNull: true },
  match_status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'unmatched',
    validate: { isIn: [['matched', 'manual', 'ambiguous', 'unmatched']] },
  },
  qty_required: { type: DataTypes.DECIMAL(15, 4), allowNull: false },
  qty_reserved: { type: DataTypes.DECIMAL(15, 4), allowNull: false, defaultValue: 0 },
  qty_dispatched: { type: DataTypes.DECIMAL(15, 4), allowNull: false, defaultValue: 0 },
  qty_ordered: { type: DataTypes.DECIMAL(15, 4), allowNull: false, defaultValue: 0 },
  budget_unit_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'project_bom_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = ProjectBomItem;
