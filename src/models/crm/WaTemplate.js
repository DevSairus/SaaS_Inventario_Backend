const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const WaTemplate = sequelize.define('WaTemplate', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING(512), allowNull: false },
  language: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'es' },
  status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'PENDING' },
  category: { type: DataTypes.STRING(32), allowNull: true },
  components_schema: { type: DataTypes.JSONB, allowNull: true },
  meta_template_id: { type: DataTypes.STRING(64), allowNull: true },
  last_synced_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'wa_templates',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = WaTemplate;
