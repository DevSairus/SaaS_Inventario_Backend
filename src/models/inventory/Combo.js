const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Combo = plantilla de productos/servicios que se cargan juntos en factura,
// cotización u orden de trabajo. Ver migración 2026092901-create-combos.
const Combo = sequelize.define('Combo', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  name: { type: DataTypes.STRING(200), allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  // true = en documentos se ven los componentes; false = solo nombre + total.
  // Es el valor por defecto: se puede cambiar al usarlo en cada documento.
  show_breakdown: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_by: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
}, {
  tableName: 'combos',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Combo;
