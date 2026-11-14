// backend/src/models/projects/ProjectCut.js
// Corte de obra: avance acumulado por línea del contrato, acta y factura
// parcial (migración 2026110612). Ver services/projects/projectCuts.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectCut = sequelize.define('ProjectCut', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  project_id: { type: DataTypes.UUID, allowNull: false },
  cut_no: { type: DataTypes.INTEGER, allowNull: false },
  cut_date: { type: DataTypes.DATEONLY, allowNull: false },
  period_from: { type: DataTypes.DATEONLY, allowNull: true },
  period_to: { type: DataTypes.DATEONLY, allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft', validate: { isIn: [['draft', 'approved', 'invoicing', 'invoiced', 'cancelled']] } },
  global_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  direct_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  aiu_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // AIU de este corte (copia editable del proyecto; migración 2026111403)
  aiu_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  aiu_admin_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  aiu_unforeseen_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  aiu_profit_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  subtotal: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  tax_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  advance_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  retention_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  net_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  progress_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
  approved_by_name: { type: DataTypes.STRING(200), allowNull: true },
  approved_by_document: { type: DataTypes.STRING(30), allowNull: true },
  approved_signature: { type: DataTypes.TEXT, allowNull: true },
  approved_at: { type: DataTypes.DATE, allowNull: true },
  approved_user_id: { type: DataTypes.UUID, allowNull: true },
  sale_id: { type: DataTypes.UUID, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'project_cuts', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ProjectCut;
