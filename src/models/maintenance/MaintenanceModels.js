// backend/src/models/maintenance/MaintenanceModels.js
// Mantenimientos recurrentes (Fase 4, req. 1.3; migración 2026111405).
// Ver services/projects/maintenance.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const opts = (tableName) => ({ tableName, timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
const base = {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
};

// Instalación (sistema del cliente) que se mantiene: de un proyecto de Pitbox
// o anterior a Pitbox (sin proyecto).
const MaintenanceInstallation = sequelize.define('MaintenanceInstallation', {
  ...base,
  customer_id: { type: DataTypes.UUID, allowNull: false },
  project_id: { type: DataTypes.UUID, allowNull: true },
  name: { type: DataTypes.STRING(200), allowNull: false },
  system_type: { type: DataTypes.STRING(100), allowNull: true },
  capacity: { type: DataTypes.STRING(50), allowNull: true },
  site_address: { type: DataTypes.TEXT, allowNull: true },
  city: { type: DataTypes.STRING(100), allowNull: true },
  installed_at: { type: DataTypes.DATEONLY, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, opts('maintenance_installations'));

// Equipo de una instalación: inversor, paneles, tablero...
const MaintenanceEquipment = sequelize.define('MaintenanceEquipment', {
  ...base,
  installation_id: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING(150), allowNull: false },
  brand: { type: DataTypes.STRING(100), allowNull: true },
  model: { type: DataTypes.STRING(100), allowNull: true },
  serial: { type: DataTypes.STRING(100), allowNull: true },
  location: { type: DataTypes.STRING(150), allowNull: true },
  installed_at: { type: DataTypes.DATEONLY, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, opts('maintenance_equipment'));

// Plan recurrente sobre la instalación (equipment_id NULL) o un equipo.
const MaintenancePlan = sequelize.define('MaintenancePlan', {
  ...base,
  installation_id: { type: DataTypes.UUID, allowNull: false },
  equipment_id: { type: DataTypes.UUID, allowNull: true },
  name: { type: DataTypes.STRING(150), allowNull: false },
  frequency_months: { type: DataTypes.INTEGER, allowNull: false },
  tasks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  start_date: { type: DataTypes.DATEONLY, allowNull: false },
  alert_days_before: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 15 },
  assigned_user_id: { type: DataTypes.UUID, allowNull: true },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active', validate: { isIn: [['active', 'paused', 'ended']] } },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, opts('maintenance_plans'));

// Visita programada / realizada.
const MaintenanceVisit = sequelize.define('MaintenanceVisit', {
  ...base,
  plan_id: { type: DataTypes.UUID, allowNull: false },
  installation_id: { type: DataTypes.UUID, allowNull: false },
  equipment_id: { type: DataTypes.UUID, allowNull: true },
  visit_no: { type: DataTypes.STRING(20), allowNull: false },
  scheduled_date: { type: DataTypes.DATEONLY, allowNull: false },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'scheduled', validate: { isIn: [['scheduled', 'done', 'cancelled']] } },
  technician_user_id: { type: DataTypes.UUID, allowNull: true },
  checklist: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  observations: { type: DataTypes.TEXT, allowNull: true },
  cancel_reason: { type: DataTypes.TEXT, allowNull: true },
  done_at: { type: DataTypes.DATE, allowNull: true },
  client_name: { type: DataTypes.STRING(200), allowNull: true },
  client_document: { type: DataTypes.STRING(30), allowNull: true },
  client_signature: { type: DataTypes.TEXT, allowNull: true },
  completed_by: { type: DataTypes.UUID, allowNull: true },
}, opts('maintenance_visits'));

module.exports = { MaintenanceInstallation, MaintenanceEquipment, MaintenancePlan, MaintenanceVisit };
