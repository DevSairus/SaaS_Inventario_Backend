const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WaReminderJob = sequelize.define('WaReminderJob', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  customer_id: { type: DataTypes.UUID, allowNull: true },
  phone: { type: DataTypes.STRING(32), allowNull: false },
  template_name: { type: DataTypes.STRING(512), allowNull: false },
  language: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'es' },
  components: { type: DataTypes.JSONB, allowNull: true },
  scheduled_at: { type: DataTypes.DATE, allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
  error_message: { type: DataTypes.TEXT, allowNull: true },
  sent_at: { type: DataTypes.DATE, allowNull: true },
  created_by_user_id: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'wa_reminder_jobs',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = WaReminderJob;
