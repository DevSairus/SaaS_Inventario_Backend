// backend/src/models/workshop/WorkOrderDiagnosisMark.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// La "hoja de inspección" de una OT concreta: cada marca es un punto del
// diagrama que el técnico señaló como revisado/dañado, con severidad,
// lado y observación libre (ver propuesta, sección 2.2 y 2.5).
const WorkOrderDiagnosisMark = sequelize.define('WorkOrderDiagnosisMark', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  work_order_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'work_orders', key: 'id' },
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
    allowNull: true,
    comment: 'Texto libre del técnico, ej. "Antiruido espiral (Derecho)"'
  },
  suggested_product_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'products', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Producto/servicio del catálogo sugerido para autogenerar el ítem'
  },
  generated_item_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_order_items', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'WorkOrderItem generado a partir de esta marca (si se confirmó)'
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
  tableName: 'work_order_diagnosis_marks',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['work_order_id'] },
    { fields: ['diagram_template_id'] }
  ]
});

module.exports = WorkOrderDiagnosisMark;
