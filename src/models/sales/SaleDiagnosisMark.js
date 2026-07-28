// backend/src/models/sales/SaleDiagnosisMark.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Espejo de WorkOrderDiagnosisMark (ver models/workshop/WorkOrderDiagnosisMark.js),
// pero para una cotización (Sale con document_type='cotizacion'). Solo tiene
// sentido cuando el tenant tiene el módulo Taller activo y el campo vehículo
// habilitado — igual catálogo de DiagramTemplate, misma UX en el frontend
// (DiagramMapEditor generalizado), pero el ítem generado cae en sale_items
// en vez de work_order_items.
const SaleDiagnosisMark = sequelize.define('SaleDiagnosisMark', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  sale_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'sales', key: 'id' },
    onDelete: 'CASCADE'
  },
  diagram_template_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'diagram_templates', key: 'id' }
  },
  point_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Cuál de los puntos del diagrama se marcó'
  },
  severity: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'revisar',
    comment: 'revisar | cambiar_pronto | urgente'
  },
  side: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'izquierdo | derecho | ambos | NULL'
  },
  observation: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  suggested_product_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'products', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Producto/servicio del catálogo sugerido para autogenerar la línea de la cotización'
  },
  generated_item_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sale_items', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'SaleItem generado a partir de esta marca (si se confirmó)'
  },
  marked_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL'
  },
  marked_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'sale_diagnosis_marks',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['sale_id'] },
    { fields: ['diagram_template_id'] }
  ]
});

module.exports = SaleDiagnosisMark;
