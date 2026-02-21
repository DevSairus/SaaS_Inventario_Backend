const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Announcement = sequelize.define('Announcement', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [1, 255]
    }
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  type: {
    type: DataTypes.STRING(50),
    defaultValue: 'feature',
    validate: {
      isIn: [['feature', 'update', 'maintenance', 'warning', 'info']]
    }
  },
  priority: {
    type: DataTypes.STRING(20),
    defaultValue: 'normal',
    validate: {
      isIn: [['low', 'normal', 'high', 'critical']]
    }
  },
  icon: {
    type: DataTypes.STRING(50),
    defaultValue: 'star'
  },
  version: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  release_date: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  show_once: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  target_audience: {
    type: DataTypes.STRING(50),
    defaultValue: 'all',
    validate: {
      isIn: [['all', 'tenants', 'superadmin']]
    }
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  }
}, {
  tableName: 'announcements',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['is_active'] },
    { fields: ['release_date'] },
    { fields: ['expires_at'] },
    { fields: ['target_audience'] }
  ]
});

module.exports = Announcement;