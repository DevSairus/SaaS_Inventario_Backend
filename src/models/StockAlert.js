const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const StockAlert = sequelize.define('StockAlert', {
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
    allowNull: false,
    references: {
      model: 'products',
      key: 'id'
    }
  },
  alert_type: {
    type: DataTypes.STRING(50),
    allowNull: false,
    validate: {
      isIn: [['low_stock', 'out_of_stock', 'overstock']]
    }
  },
  severity: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'warning',
    validate: {
      isIn: [['info', 'warning', 'critical']]
    }
  },
  current_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  min_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  max_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
    validate: {
      isIn: [['active', 'resolved', 'ignored']]
    }
  },
  alert_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  resolved_date: {
    type: DataTypes.DATE,
    allowNull: true
  },
  resolved_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  resolution_notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'created_at'
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'updated_at'
  }
}, {
  tableName: 'stock_alerts',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = StockAlert;