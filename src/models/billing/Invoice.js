const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

/**
 * Modelo de Facturas de Venta
 * Sistema de Inventario
 */
const Invoice = sequelize.define(
  'Invoice',
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
    invoice_number: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'Número de factura único',
    },
    customer_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: 'Nombre del cliente',
    },
    customer_tax_id: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'NIT o cédula del cliente',
    },
    customer_email: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    customer_phone: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    customer_address: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    
    // Montos
    subtotal: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
      comment: 'Subtotal antes de impuestos',
    },
    tax_amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0,
      comment: 'Monto de IVA',
    },
    discount_amount: {
      type: DataTypes.DECIMAL(15, 2),
      defaultValue: 0,
      comment: 'Monto de descuento',
    },
    total_amount: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
      comment: 'Total a pagar',
    },
    
    // Estado
    status: {
      type: DataTypes.ENUM('draft', 'issued', 'paid', 'partial', 'overdue', 'cancelled'),
      allowNull: false,
      defaultValue: 'draft',
    },
    
    // Fechas
    issue_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    due_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    paid_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    
    // Información adicional
    payment_method: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Efectivo, tarjeta, transferencia, etc',
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    pdf_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    
    // Usuario que creó la factura
    created_by: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    tableName: 'invoices',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['tenant_id', 'invoice_number'],
        unique: true,
      },
      {
        fields: ['tenant_id', 'status'],
      },
      {
        fields: ['tenant_id', 'issue_date'],
      },
    ],
  }
);

module.exports = Invoice;
