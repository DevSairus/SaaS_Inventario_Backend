// backend/src/models/workshop/DiagramSystemCommissionMap.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Mapea DiagramTemplate.system (frenos_delanteros, suspension_delantera...)
// a una CommissionCategory del tenant -- ver
// plan-comisiones-tecnicos-por-sistema.md sección 2, punto 2 y sección 4.1.
const DiagramSystemCommissionMap = sequelize.define('DiagramSystemCommissionMap', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  system: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  commission_category_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
}, {
  tableName: 'diagram_system_commission_map',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'system'], unique: true },
  ],
});

module.exports = DiagramSystemCommissionMap;
