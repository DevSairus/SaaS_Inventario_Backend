const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PayableAlert = sequelize.define('PayableAlert', {
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
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'purchases',
      key: 'id'
    }
  },
  alert_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: {
      isIn: [['due_soon', 'overdue']]
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
  due_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  balance: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  days_to_due: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: 'Negativo = días vencido, positivo = días para vencer'
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
  tableName: 'payable_alerts',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = PayableAlert;
