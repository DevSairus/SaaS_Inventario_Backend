/**
 * Modelo de Plan de Suscripción
 * Ubicación: backend/src/models/SubscriptionPlan.js
 *
 * Define los planes disponibles para los tenants
 */

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SubscriptionPlan = sequelize.define(
  'SubscriptionPlan',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'Nombre del plan (ej: Basic, Premium, Enterprise)',
    },
    slug: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      comment: 'Identificador único (ej: basic, premium, enterprise)',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción del plan',
    },

    // Precios
    monthly_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      comment: 'Precio mensual en COP',
    },
    yearly_price: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Precio anual en COP (con descuento)',
    },

    // Características del plan
    features: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: 'Características incluidas en el plan',
    },

    // Límites
    max_users: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 3,
      comment: 'Número máximo de usuarios',
    },
    max_clients: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 50,
      comment: 'Número máximo de clientes finales',
    },
    max_invoices_per_month: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
      comment: 'Máximo de facturas por mes',
    },
    max_storage_mb: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
      comment: 'Almacenamiento máximo en MB',
    },

    // Estado y configuración
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Si el plan está disponible para contratación',
    },
    is_popular: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Si el plan se muestra como popular/recomendado',
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Orden de visualización',
    },
    trial_days: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 14,
      comment: 'Días de prueba gratuita',
    },
  },
  {
    tableName: 'subscription_plans',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['slug'],
      },
      {
        fields: ['is_active'],
      },
      {
        fields: ['sort_order'],
      },
    ],
  }
);

module.exports = SubscriptionPlan;
