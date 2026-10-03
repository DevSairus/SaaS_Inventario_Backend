const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Category = sequelize.define('Category', {
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
    type: DataTypes.STRING(100),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  parent_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'categories',
      key: 'id'
    }
  },
  // Concepto de retención en la fuente (catálogo del tenant). NULL = heredar
  // de la categoría / proveedor / tipo (ver retentionEngine.service.js).
  retention_concept: {
    type: DataTypes.STRING(60),
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  // Mapeo hacia la categoría de comisión de mano de obra (Frenos, Suspensión...)
  // -- ver plan-comisiones-tecnicos-por-sistema.md sección 2 y 4.1.
  commission_category_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'commission_categories',
      key: 'id'
    }
  }
}, {
  tableName: 'categories',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Category;