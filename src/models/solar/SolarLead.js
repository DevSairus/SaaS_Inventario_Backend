// backend/src/models/solar/SolarLead.js
// Interesado captado por el simulador solar público (migración 2026110613).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SolarLead = sequelize.define('SolarLead', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  study_id: { type: DataTypes.UUID, allowNull: true },
  customer_id: { type: DataTypes.UUID, allowNull: true },
  opportunity_id: { type: DataTypes.UUID, allowNull: true },
  name: { type: DataTypes.STRING(150), allowNull: false },
  phone: { type: DataTypes.STRING(30), allowNull: true },
  email: { type: DataTypes.STRING(150), allowNull: true },
  city: { type: DataTypes.STRING(120), allowNull: true },
  address: { type: DataTypes.STRING(255), allowNull: true }, // 2026110614

  segment: { type: DataTypes.STRING(20), allowNull: true },
  monthly_kwh: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  kwp: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
  price_min: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  price_max: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  consent_text: { type: DataTypes.TEXT, allowNull: false },
  consent_at: { type: DataTypes.DATE, allowNull: false },
  consent_ip: { type: DataTypes.STRING(64), allowNull: true },
  user_agent: { type: DataTypes.STRING(300), allowNull: true },
  referrer: { type: DataTypes.STRING(500), allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'new', validate: { isIn: [['new', 'contacted', 'quoted', 'won', 'discarded']] } },
  notes: { type: DataTypes.TEXT, allowNull: true },
}, { tableName: 'solar_leads', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = SolarLead;
