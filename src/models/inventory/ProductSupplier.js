const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProductSupplier = sequelize.define('ProductSupplier', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tenants',
      key: 'id'
    }
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  supplier_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  last_price: {
    type: DataTypes.DECIMAL(15, 2)
  },
  last_purchase_date: {
    type: DataTypes.DATE
  },
  lead_time_days: {
    type: DataTypes.INTEGER
  },
  // Código con el que ESE proveedor identifica el ítem (SellersItemIdentification
  // del XML de factura electrónica) — no es el SKU interno de Pitbox. Junto con
  // tenant_id + supplier_id forma el mapeo código-proveedor → producto interno
  // que usa invoiceImport.controller.js para reconocer ítems automáticamente
  // en próximas facturas del mismo proveedor.
  supplier_code: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Descripción tal como la escribe el proveedor en su factura — se guarda de
  // referencia para cuando el contador/comprador revisa el mapeo manualmente.
  supplier_description: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'product_suppliers',
  timestamps: true,
  underscored: true
});

module.exports = ProductSupplier;