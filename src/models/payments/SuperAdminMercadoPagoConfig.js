// backend/src/models/SuperAdminMercadoPagoConfig.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SuperAdminMercadoPagoConfig = sequelize.define(
  'SuperAdminMercadoPagoConfig',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    access_token: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment:
        'Token de acceso de MercadoPago del SuperAdmin para cobrar suscripciones',
    },
    public_key: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Public key de MercadoPago del SuperAdmin',
    },
    webhook_secret: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Secret para validar webhooks de MercadoPago',
    },
    test_mode: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Si está usando credenciales de prueba',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'superadmin_mercadopago_config',
    timestamps: true,
    underscored: true,
  }
);

module.exports = SuperAdminMercadoPagoConfig;
