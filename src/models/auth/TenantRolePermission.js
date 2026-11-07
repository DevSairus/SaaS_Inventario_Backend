// backend/src/models/auth/TenantRolePermission.js
// Lo que una empresa cambió frente a los permisos por defecto del catálogo
// (config/permissions.catalog.js). Migración 2026110601.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const TenantRolePermission = sequelize.define('TenantRolePermission', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  role: { type: DataTypes.STRING(30), allowNull: false },
  permission_key: { type: DataTypes.STRING(80), allowNull: false },
  allowed: { type: DataTypes.BOOLEAN, allowNull: false },
  updated_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'tenant_role_permissions',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = TenantRolePermission;
