// backend/src/models/TenantMercadoPagoConfig.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const TenantMercadoPagoConfig = sequelize.define(
  'TenantMercadoPagoConfig',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenant_id: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: {
        model: 'tenants',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    access_token: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    public_key: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    test_mode: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    custom_success_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    custom_failure_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    custom_pending_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    custom_notification_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    binary_mode: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    auto_return: {
      type: DataTypes.STRING(50),
      defaultValue: 'approved',
    },
    statement_descriptor: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: 'tenant_mercadopago_config',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = TenantMercadoPagoConfig;
