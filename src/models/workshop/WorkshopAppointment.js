// backend/src/models/workshop/WorkshopAppointment.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Solicitud de cita de taller -- creada por el cliente desde la página
// pública (/agendar/:slug, sin login) o por el staff (walk-in/teléfono).
// share_token se genera siempre al crear (no perezosamente como
// Sale.share_token) porque es el único dato que el cliente público se
// lleva para poder consultar el estado de su solicitud después.
const WorkshopAppointment = sequelize.define('WorkshopAppointment', {
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
  scheduled_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  duration_minutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Snapshot de slot_duration_minutes del config al momento de reservar.',
  },
  status: {
    type: DataTypes.ENUM('pendiente', 'confirmada', 'cancelada', 'no_asistio', 'completada'),
    allowNull: false,
    defaultValue: 'pendiente',
  },
  customer_name:  { type: DataTypes.STRING, allowNull: false },
  customer_phone: { type: DataTypes.STRING, allowNull: false },
  customer_email: { type: DataTypes.STRING, allowNull: true },
  vehicle_plate:  { type: DataTypes.STRING, allowNull: true },
  vehicle_brand:  { type: DataTypes.STRING, allowNull: true },
  vehicle_model:  { type: DataTypes.STRING, allowNull: true },
  service_description: { type: DataTypes.TEXT, allowNull: true },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'customers', key: 'id' },
    onDelete: 'SET NULL',
  },
  vehicle_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'vehicles', key: 'id' },
    onDelete: 'SET NULL',
  },
  converted_to_work_order_id: {
    type: DataTypes.UUID,
    allowNull: true,
    unique: true,
    references: { model: 'work_orders', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Guard de conversión única -- mismo patrón que Sale.converted_to_work_order_id.',
  },
  share_token: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
  },
  confirmed_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  confirmed_at:     { type: DataTypes.DATE, allowNull: true },
  cancelled_reason: { type: DataTypes.STRING, allowNull: true },
  reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
  source: {
    type: DataTypes.ENUM('public', 'staff'),
    allowNull: false,
    defaultValue: 'public',
  },
}, {
  tableName: 'workshop_appointments',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'branch_id', 'scheduled_at'] },
    { fields: ['tenant_id', 'status'] },
  ],
});

module.exports = WorkshopAppointment;
