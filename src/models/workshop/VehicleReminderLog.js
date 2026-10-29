// backend/src/models/workshop/VehicleReminderLog.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Un intento de recordatorio de vencimiento (SOAT o técnico-mecánica) por
// canal, con su resultado. Ver services/vehicleReminderService.js y la
// migración 2026102905-create-vehicle-reminder-logs.js.
const VehicleReminderLog = sequelize.define('VehicleReminderLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  vehicle_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  document_type: {
    type: DataTypes.STRING(20), // 'soat' | 'tecnomecanica'
    allowNull: false,
  },
  expiry_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  days_before: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  channel: {
    type: DataTypes.STRING(20), // 'email' | 'whatsapp'
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING(20), // 'sent' | 'failed' | 'skipped'
    allowNull: false,
  },
  destination: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  detail: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'vehicle_reminder_logs',
  timestamps: true,
  underscored: true,
});

module.exports = VehicleReminderLog;
