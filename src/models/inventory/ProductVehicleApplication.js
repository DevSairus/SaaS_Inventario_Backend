const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProductVehicleApplication = sequelize.define('ProductVehicleApplication', {
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
  product_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  vehicle_type: {
    type: DataTypes.STRING(30),
    allowNull: true
  },
  brand: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  line: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  year_from: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  year_to: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  engine: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  brand_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  line_id: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'product_vehicle_applications',
  timestamps: true,
  underscored: true
});

module.exports = ProductVehicleApplication;
