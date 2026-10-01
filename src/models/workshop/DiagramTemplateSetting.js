// backend/src/models/workshop/DiagramTemplateSetting.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Ajustes del taller sobre un DiagramTemplate: activarlo/desactivarlo y en
// qué categorías de vehículo adicionales aplica. Sin fila = activo y solo en
// su vehicle_type de origen. Ver 2026093001-create-diagram-template-settings.js.
const DiagramTemplateSetting = sequelize.define('DiagramTemplateSetting', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  diagram_template_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  is_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  extra_vehicle_types: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
}, {
  tableName: 'diagram_template_settings',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'diagram_template_id'], unique: true },
  ],
});

module.exports = DiagramTemplateSetting;
