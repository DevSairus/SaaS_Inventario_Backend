const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const TransferItem = sequelize.define('TransferItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  transfer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'transfers', key: 'id' },
    onDelete: 'CASCADE'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  quantity_sent: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  quantity_received: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  // Despacho de materiales de un proyecto: línea del BOM de la que salió
  // (si el traslado se cancela, la cantidad vuelve a quedar reservada).
  project_bom_item_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'project_bom_items', key: 'id' }
  }
}, {
  tableName: 'transfer_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = TransferItem;