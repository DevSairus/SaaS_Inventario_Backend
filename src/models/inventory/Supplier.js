const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Supplier = sequelize.define('Supplier', {
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
  name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  code: {
    type: DataTypes.STRING(50),
    allowNull: true  // CAMBIADO: ahora es opcional
  },
  business_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  trade_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  tax_id: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  phone: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  mobile: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  website: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  city: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  state: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  country: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  postal_code: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  contact_name: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  contact_email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  contact_phone: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  contact_position: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  payment_terms: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    set(value) {
      // Convertir string vacío o undefined a null
      this.setDataValue('payment_terms', value === '' || value === undefined ? null : value);
    }
  },
  credit_limit: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
    defaultValue: null,
    set(value) {
      this.setDataValue('credit_limit', value === '' || value === undefined ? null : value);
    }
  },
  discount_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true,
    defaultValue: null,
    set(value) {
      this.setDataValue('discount_percentage', value === '' || value === undefined ? null : value);
    }
  },
  supplier_type: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  bank_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  account_number: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  account_type: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  rating: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    set(value) {
      this.setDataValue('rating', value === '' || value === undefined ? null : value);
    }
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  // Configuración de retenciones que el tenant aplica a este proveedor al
  // pagarle (ReteFuente/ReteIVA/ReteICA, is_exento). Columna agregada en la
  // migración 2026070302-add-multi-tax-system.js pero nunca declarada aquí ->
  // nunca se guardaba ni se leía. Hoy purchases.controller.js no llama a
  // taxService (ver Fase C), pero el campo debe existir para cuando se
  // conecte.
  retention_config: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  // ── Clasificación fiscal (Documento Soporte DIAN) ───────────────────
  // Sin esto no hay forma de saber automáticamente cuándo una compra a
  // este proveedor necesita Documento Soporte en vez de esperar una
  // factura de él (Resolución DIAN 000167 de 2021).
  person_type: {
    type: DataTypes.STRING(20),
    allowNull: true,
    validate: { isIn: [['natural', 'juridica']] },
    comment: 'natural | juridica — determina el schemeID en el XML (CC vs NIT)'
  },
  tax_regime: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'simple | comun | no_responsable, etc. — informativo'
  },
  fiscal_responsibilities: {
    type: DataTypes.JSONB,
    defaultValue: [],
    comment: 'Códigos de responsabilidad DIAN del proveedor (ej. ["R-99-PN"])'
  },
  is_obligated_to_invoice: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: 'FALSE = proveedor no obligado a facturar (régimen simplificado histórico, informal, sin resolución propia) — las compras a él requieren Documento Soporte.'
  }
}, {
  tableName: 'suppliers',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Supplier;