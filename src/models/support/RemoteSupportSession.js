const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const RemoteSupportSession = sequelize.define('RemoteSupportSession', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  ticket_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'support_tickets',
      key: 'id'
    }
  },
  agent_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tenants',
      key: 'id'
    }
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  mode: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'view_only',
    validate: {
      isIn: [['view_only', 'remote_control']]
    }
  },
  started_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  ended_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  consent_given_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  consent_scope: {
    type: DataTypes.STRING(20),
    allowNull: true,
    validate: {
      isIn: [['view_only', 'remote_control']]
    }
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    validate: {
      isIn: [['pending', 'active', 'ended', 'rejected', 'expired']]
    }
  }
}, {
  tableName: 'remote_support_sessions',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['ticket_id'] },
    { fields: ['tenant_id'] },
    { fields: ['status'] }
  ]
});

module.exports = RemoteSupportSession;
