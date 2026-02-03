const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Purchase = sequelize.define('Purchase', {
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
  purchase_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Número único de la orden de compra'
  },
  supplier_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'suppliers',
      key: 'id'
    }
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: true,  // CAMBIADO: ahora es opcional
    references: {
      model: 'users',
      key: 'id'
    },
    comment: 'Usuario que registró la compra'
  },
  purchase_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  expected_delivery_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    set(value) {
      // Convertir fechas inválidas o strings vacíos a null
      if (!value || value === '' || value === 'Invalid date') {
        this.setDataValue('expected_delivery_date', null);
      } else {
        this.setDataValue('expected_delivery_date', value);
      }
    }
  },
  due_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    set(value) {
      if (!value || value === '' || value === 'Invalid date') {
        this.setDataValue('due_date', null);
      } else {
        this.setDataValue('due_date', value);
      }
    }
  },
  received_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING(20),
    defaultValue: 'draft',
    validate: {
      isIn: [['draft', 'confirmed', 'received', 'cancelled']]
    }
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  shipping_cost: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  other_costs: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  payment_method: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Efectivo, Transferencia, Crédito, etc.'
  },
  payment_status: {
    type: DataTypes.STRING(20),
    defaultValue: 'pending',
    validate: {
      isIn: [['pending', 'partial', 'paid']]
    }
  },
  payment_terms: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  paid_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  invoice_number: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Número de factura del proveedor'
  },
  order_number: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  reference: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Referencia externa o número de orden del proveedor'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  internal_notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Notas internas no visibles para el proveedor'
  },
  currency: {
    type: DataTypes.STRING(10),
    defaultValue: 'COP'
  },
  exchange_rate: {
    type: DataTypes.DECIMAL(10, 4),
    defaultValue: 1
  },
  supplier_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  supplier_tax_id: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  supplier_address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'warehouses',
      key: 'id'
    },
    comment: 'Bodega de destino'
  },
  attachments: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  approved_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  approved_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  cancelled_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  cancelled_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  cancellation_reason: {
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
  tableName: 'purchases',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      unique: true,
      fields: ['tenant_id', 'purchase_number']
    },
    {
      fields: ['supplier_id']
    },
    {
      fields: ['status']
    },
    {
      fields: ['purchase_date']
    }
  ]
});

module.exports = Purchase;