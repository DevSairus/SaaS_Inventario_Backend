const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ComboItem = sequelize.define('ComboItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  combo_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'combos', key: 'id' },
    onDelete: 'CASCADE'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  quantity: { type: DataTypes.DECIMAL(10, 3), allowNull: false, defaultValue: 1 },
  // Precio dentro del combo: arranca en el base_price del producto pero se
  // puede editar. Es el precio que se carga al documento.
  unit_price: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'combo_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [{ fields: ['combo_id'] }, { fields: ['product_id'] }]
});

module.exports = ComboItem;
