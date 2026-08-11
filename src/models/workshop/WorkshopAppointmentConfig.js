// backend/src/models/workshop/WorkshopAppointmentConfig.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Horario/capacidad de reserva de citas, una fila por sede (branch) --
// cada sede puede tener horarios y capacidad distintos. business_hours usa
// llaves de 3 letras en inglés (mon..sun) para no depender del locale del
// servidor al calcular el día de la semana.
const WorkshopAppointmentConfig = sequelize.define('WorkshopAppointmentConfig', {
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
    onDelete: 'CASCADE',
  },
  business_hours: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    comment: '{ mon: [{start:"08:00", end:"18:00"}], ... } -- array vacío = cerrado ese día.',
  },
  slot_duration_minutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 60,
  },
  capacity_per_slot: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: 'Máximo de vehículos que se pueden recibir en la misma franja de horario.',
  },
  advance_booking_days: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 30,
  },
  min_notice_hours: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 2,
  },
  blocked_dates: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
    comment: '[{date:"YYYY-MM-DD", reason}] -- festivos/excepciones de esta sede.',
  },
  is_public_booking_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'workshop_appointment_configs',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'branch_id'], unique: true },
  ],
});

module.exports = WorkshopAppointmentConfig;
