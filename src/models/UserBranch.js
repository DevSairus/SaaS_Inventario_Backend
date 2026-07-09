// backend/src/models/UserBranch.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserBranch = sequelize.define('UserBranch', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' }
  },
  branch_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'branches', key: 'id' }
  },
  is_default: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Sede que se selecciona automáticamente al iniciar sesión'
  }
}, {
  tableName: 'user_branches',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = UserBranch;
