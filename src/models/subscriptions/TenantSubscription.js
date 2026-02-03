/**
 * Modelo de Suscripción de Tenant
 * Ubicación: backend/src/models/TenantSubscription.js
 *
 * Maneja las suscripciones activas de cada tenant
 */

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const TenantSubscription = sequelize.define(
  'TenantSubscription',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenant_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'tenants',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    plan_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'subscription_plans',
        key: 'id',
      },
      onDelete: 'RESTRICT',
    },

    // Estado de la suscripción
    status: {
      type: DataTypes.ENUM(
        'trial',
        'active',
        'past_due',
        'suspended',
        'cancelled',
        'expired'
      ),
      allowNull: false,
      defaultValue: 'trial',
      comment: 'Estado actual de la suscripción',
    },

    // Fechas importantes
    trial_ends_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha de fin del período de prueba',
    },
    starts_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'Fecha de inicio de la suscripción',
    },
    current_period_start: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'Inicio del período actual de facturación',
    },
    current_period_end: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fin del período actual de facturación',
    },
    next_billing_date: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Próxima fecha de cobro',
    },
    cancelled_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha de cancelación',
    },

    // Configuración de pago
    billing_cycle: {
      type: DataTypes.ENUM('monthly', 'yearly'),
      allowNull: false,
      defaultValue: 'monthly',
      comment: 'Ciclo de facturación',
    },
    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      comment: 'Monto a cobrar por ciclo',
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'COP',
    },

    // Integración con MercadoPago
    mercadopago_subscription_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      unique: true,
      comment: 'ID de suscripción en MercadoPago',
    },
    mercadopago_preapproval_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID de preaprobación en MercadoPago',
    },
    payment_method_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID del método de pago guardado',
    },

    // Recordatorios y notificaciones
    last_reminder_sent_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Última fecha de envío de recordatorio',
    },
    reminder_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Número de recordatorios enviados',
    },

    // Información adicional
    auto_renew: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Si la suscripción se renueva automáticamente',
    },
    cancellation_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Razón de cancelación',
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Notas internas',
    },
  },
  {
    tableName: 'tenant_subscriptions',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['tenant_id'],
      },
      {
        fields: ['plan_id'],
      },
      {
        fields: ['status'],
      },
      {
        fields: ['next_billing_date'],
      },
      {
        fields: ['mercadopago_subscription_id'],
      },
    ],
  }
);

module.exports = TenantSubscription;
