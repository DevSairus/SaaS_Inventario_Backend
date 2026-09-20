// backend/src/models/workshop/CommissionCategory.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Catálogo de categorías de comisión de mano de obra (Frenos, Suspensión,
// Motor, Otros...), desacoplado del árbol `categories` de inventario -- ver
// 00 - Documentación/plan-comisiones-tecnicos-por-sistema.md sección 2.
const CommissionCategory = sequelize.define('CommissionCategory', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  code: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  default_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // Categoría fallback ("Otros") usada cuando un producto/sistema de
  // diagrama no tiene mapeo explícito -- nunca "sin comisión" silencioso.
  is_default: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'commission_categories',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id'] },
  ],
});

module.exports = CommissionCategory;
