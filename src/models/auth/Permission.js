// backend/src/models/auth/Permission.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Permission = sequelize.define('Permission', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  module: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'general'
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'permissions',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = Permission;