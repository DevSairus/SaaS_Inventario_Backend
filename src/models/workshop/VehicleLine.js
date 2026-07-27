const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const VehicleLine = sequelize.define('VehicleLine', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tenants',
      key: 'id'
    }
  },
  brand_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  }
}, {
  tableName: 'vehicle_lines',
  timestamps: true,
  underscored: true
});

module.exports = VehicleLine;
