// backend/src/models/workshop/VehicleInspection.js
// Peritaje vehicular PER-000001 (migración 2026112701). Ver
// services/workshop/inspections.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const REQUESTER_TYPES = ['propietario', 'comprador', 'financiera', 'aseguradora', 'concesionario', 'otro'];
const PURPOSES = ['compraventa', 'financiacion', 'seguro', 'control', 'otro'];
const STATUSES = ['draft', 'finalized', 'cancelled'];

const VehicleInspection = sequelize.define('VehicleInspection', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  number: { type: DataTypes.STRING(30), allowNull: false },
  vehicle_id: { type: DataTypes.UUID, allowNull: false },
  owner_customer_id: { type: DataTypes.UUID, allowNull: true },
  requester_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'propietario', validate: { isIn: [REQUESTER_TYPES] } },
  requester_customer_id: { type: DataTypes.UUID, allowNull: true },
  requester_name: { type: DataTypes.STRING(200), allowNull: true },
  requester_document: { type: DataTypes.STRING(30), allowNull: true },
  requester_phone: { type: DataTypes.STRING(30), allowNull: true },
  requester_email: { type: DataTypes.STRING(150), allowNull: true },
  purpose: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'compraventa', validate: { isIn: [PURPOSES] } },
  template_id: { type: DataTypes.UUID, allowNull: true },
  template_name: { type: DataTypes.STRING(150), allowNull: true },
  template_snapshot: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  inspector_id: { type: DataTypes.UUID, allowNull: true },
  inspected_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  mileage: { type: DataTypes.INTEGER, allowNull: true },
  meter_unit: { type: DataTypes.STRING(2), allowNull: false, defaultValue: 'km' },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft', validate: { isIn: [STATUSES] } },
  score: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
  suggested_concept: { type: DataTypes.STRING(30), allowNull: true },
  concept: { type: DataTypes.STRING(30), allowNull: true },
  section_scores: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  conclusion: { type: DataTypes.TEXT, allowNull: true },
  recommendations: { type: DataTypes.TEXT, allowNull: true },
  body_marks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  paint_readings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  identity: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  runt_snapshot_id: { type: DataTypes.UUID, allowNull: true },
  photos: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  inspector_signature: { type: DataTypes.TEXT, allowNull: true },
  price: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  is_public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  verify_token: { type: DataTypes.UUID, allowNull: false, defaultValue: DataTypes.UUIDV4 },
  work_order_id: { type: DataTypes.UUID, allowNull: true },
  sale_id: { type: DataTypes.UUID, allowNull: true },
  finalized_at: { type: DataTypes.DATE, allowNull: true },
  finalized_by: { type: DataTypes.UUID, allowNull: true },
  cancelled_at: { type: DataTypes.DATE, allowNull: true },
  cancel_reason: { type: DataTypes.STRING(500), allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'vehicle_inspections', timestamps: true, underscored: true });

VehicleInspection.REQUESTER_TYPES = REQUESTER_TYPES;
VehicleInspection.PURPOSES = PURPOSES;
VehicleInspection.STATUSES = STATUSES;

module.exports = VehicleInspection;
