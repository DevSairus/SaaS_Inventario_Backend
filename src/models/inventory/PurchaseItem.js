const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PurchaseItem = sequelize.define('PurchaseItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'purchases',
      key: 'id'
    },
    onDelete: 'CASCADE'
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tenants',
      key: 'id'
    },
    comment: 'Denormalizado desde purchases.tenant_id para reportes/consultas directas'
  },
  line_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Posición/orden del item dentro de la compra'
  },
  product_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Nombre del producto al momento de la compra (histórico, no depende del catálogo actual)'
  },
  product_sku: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  product_barcode: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'products',
      key: 'id'
    }
  },
  quantity: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    validate: {
      min: 0
    }
  },
  received_quantity: {
    type: DataTypes.DECIMAL(15, 4),
    defaultValue: 0,
    validate: {
      min: 0
    }
  },
  unit_of_measure: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'unit',
    comment: 'Unidad de medida al momento de la compra (histórico, tomado del producto)'
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    comment: 'Precio unitario de compra'
  },
  tax_rate: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
    comment: 'Tasa de IVA (%)'
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
    comment: 'Monto del IVA'
  },
  inc_rate: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
    comment: 'Tasa de INC (Impuesto Nacional al Consumo) %'
  },
  inc_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  ica_rate: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
    comment: 'Tasa de ICA (%)'
  },
  ica_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  discount_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0
  },
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  batch_number: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  expiration_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
    comment: 'quantity * unit_cost - discount'
  },
  total: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
    comment: 'subtotal + tax_amount'
  },
  line_total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Duplicado de total en el esquema real (probable columna legada); se mantiene sincronizada con total'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'purchase_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['purchase_id']
    },
    {
      fields: ['product_id']
    }
  ],
  hooks: {
    // 'line_total' es una columna legada duplicada de 'total' en el esquema real.
    // Se sincroniza aquí para que ningún punto de creación/actualización del
    // modelo tenga que acordarse de setearla manualmente.
    beforeValidate: (item) => {
      if (item.total !== undefined && item.total !== null) {
        item.line_total = item.total;
      }
    }
  }
});

module.exports = PurchaseItem;