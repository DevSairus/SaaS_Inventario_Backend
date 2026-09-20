// backend/src/models/crm/CrmGamificationSettings.js
//
// CRM — Gamificación, Fase 1. Ver gamificacion-crm-diseno.md §3.5.
// admin/super_admin siempre ven todo sin importar `board_visibility` — se
// reutiliza SCOPE_BYPASS_ROLES de utils/crmScope.js tal cual, no se
// reimplementa la regla acá.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmGamificationSettings = sequelize.define('CrmGamificationSettings', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  board_visibility: {
    type: DataTypes.ENUM('own_only', 'team', 'all'),
    allowNull: false,
    defaultValue: 'own_only',
  },
  enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'crm_gamification_settings',
  timestamps: true,
  underscored: true,
});

module.exports = CrmGamificationSettings;
