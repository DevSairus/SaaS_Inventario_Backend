// backend/src/models/solar/SolarStudy.js
// Estudio del cotizador solar: consumo, ubicación, sistema, resultado y
// precios, con su cotización y proyecto (migración 2026110611).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SolarStudy = sequelize.define('SolarStudy', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  number: { type: DataTypes.STRING(30), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft', validate: { isIn: [['draft', 'quoted', 'project']] } },
  customer_id: { type: DataTypes.UUID, allowNull: true },
  title: { type: DataTypes.STRING(200), allowNull: true },
  system_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ongrid', validate: { isIn: [['ongrid', 'offgrid', 'hybrid']] } },
  city: { type: DataTypes.STRING(120), allowNull: true },
  department: { type: DataTypes.STRING(120), allowNull: true },
  address: { type: DataTypes.STRING(255), allowNull: true },
  latitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
  longitude: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
  hsp: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
  hsp_monthly: { type: DataTypes.JSONB, allowNull: true },
  hsp_source: { type: DataTypes.STRING(20), allowNull: true },
  monthly_kwh: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  tariff_kwh: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  bill_data: { type: DataTypes.JSONB, allowNull: true },
  inputs: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  results: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  kwp: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
  total_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  quote_id: { type: DataTypes.UUID, allowNull: true },
  project_id: { type: DataTypes.UUID, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'solar_studies', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = SolarStudy;
