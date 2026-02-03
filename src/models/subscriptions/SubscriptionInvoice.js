/**
 * Modelo de Factura de Suscripción
 * Ubicación: backend/src/models/SubscriptionInvoice.js
 *
 * Facturas generadas por pagos de suscripción de tenants
 * SEPARADAS de las facturas de clientes finales
 */

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SubscriptionInvoice = sequelize.define(
  'SubscriptionInvoice',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    invoice_number: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      comment: 'Número de factura único (ej: SUB-2026-0001)',
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
    subscription_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'tenant_subscriptions',
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
    },

    // Montos
    subtotal: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      comment: 'Subtotal antes de impuestos',
    },
    tax_amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
      comment: 'Monto de IVA (19% en Colombia)',
    },
    total_amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      comment: 'Total a pagar',
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'COP',
    },

    // Estado de pago
    status: {
      type: DataTypes.ENUM(
        'pending',
        'paid',
        'failed',
        'cancelled',
        'refunded'
      ),
      allowNull: false,
      defaultValue: 'pending',
      comment: 'Estado del pago',
    },

    // Fechas
    issue_date: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'Fecha de emisión',
    },
    due_date: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fecha de vencimiento',
    },
    paid_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha de pago',
    },

    // Período facturado
    period_start: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Inicio del período facturado',
    },
    period_end: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fin del período facturado',
    },

    // Integración MercadoPago
    mercadopago_payment_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID del pago en MercadoPago',
    },
    mercadopago_preference_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID de preferencia de pago',
    },
    payment_method: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Método de pago usado (credit_card, debit_card, etc)',
    },
    payment_details: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: 'Detalles adicionales del pago',
    },

    // Información de factura
    billing_data: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: 'Datos de facturación del tenant',
    },

    // URLs
    pdf_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'URL del PDF generado',
    },
    payment_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'URL de pago de MercadoPago',
    },

    // Notas
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Notas internas',
    },
  },
  {
    tableName: 'subscription_invoices',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['invoice_number'],
      },
      {
        fields: ['tenant_id'],
      },
      {
        fields: ['subscription_id'],
      },
      {
        fields: ['status'],
      },
      {
        fields: ['due_date'],
      },
      {
        fields: ['mercadopago_payment_id'],
      },
    ],
  }
);

module.exports = SubscriptionInvoice;
