// backend/src/models/crm/CrmMessageTemplate.js
//
// CRM Fase B.3 — plantillas de mensaje reutilizables en WhatsApp/seguimientos,
// con variables {{cliente}}, {{asesor}}, {{monto}} resueltas en el backend
// (ver utils/crmMessageTemplate.js).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmMessageTemplate = sequelize.define('CrmMessageTemplate', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  channel: {
    type: DataTypes.ENUM('whatsapp', 'llamada', 'email'),
    allowNull: false,
    defaultValue: 'whatsapp',
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  tableName: 'crm_message_templates',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'channel'] },
  ],
});

module.exports = CrmMessageTemplate;
