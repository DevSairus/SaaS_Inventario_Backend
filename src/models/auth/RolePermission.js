const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const RolePermission = sequelize.define(
  'RolePermission',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    role: {
      type: DataTypes.ENUM('super_admin', 'admin', 'operario', 'cliente'),
      allowNull: false,
      comment: 'Rol que tiene el permiso',
    },
    permission_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'permissions',
        key: 'id',
      },
    },
  },
  {
    tableName: 'role_permissions',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['role', 'permission_id'],
        name: 'unique_role_permission',
      },
    ],
  }
);

RolePermission.associate = (models) => {
  // Relación con Permission
  RolePermission.belongsTo(models.Permission, {
    foreignKey: 'permission_id',
    as: 'permission',
  });
};

module.exports = RolePermission;