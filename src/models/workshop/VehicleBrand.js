const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const VehicleBrand = sequelize.define('VehicleBrand', {
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
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  }
}, {
  tableName: 'vehicle_brands',
  timestamps: true,
  underscored: true
});

module.exports = VehicleBrand;
