// backend/src/models/projects/WorkShift.js
// Turno de trabajo (entrada, salida, descanso) para precargar la planilla
// diaria de la obra (Fase 4, req. 1.1; migración 2026111404).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WorkShift = sequelize.define('WorkShift', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  name: { type: DataTypes.STRING(80), allowNull: false },
  start_time: { type: DataTypes.TIME, allowNull: false },
  end_time: { type: DataTypes.TIME, allowNull: false },
  break_minutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { tableName: 'work_shifts', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = WorkShift;
