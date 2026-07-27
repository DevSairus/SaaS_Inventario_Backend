// backend/src/models/workshop/DiagramTemplate.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

// Biblioteca de diagramas base para el "Mapa de intervención" (ver propuesta
// de diagramas interactivos, sección 2.2). No se modela por vehículo — se
// modela por tipología de sistema mecánico (vehicle_type + system +
// configuration), que se repite entre cientos de modelos distintos.
const DiagramTemplate = sequelize.define('DiagramTemplate', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'tenants', key: 'id' },
    comment: 'NULL = biblioteca compartida global; con valor = diagrama propio de un taller'
  },
  vehicle_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: 'automovil | camioneta | motocicleta | camion | otro'
  },
  system: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'suspension_delantera | suspension_trasera | frenos_delanteros | frenos_traseros | ...'
  },
  configuration: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'macpherson | doble_horquilla | eje_rigido | multilink | independiente | disco_ventilado | ...'
  },
  name: {
    type: DataTypes.STRING(150),
    allowNull: false,
    comment: 'Ej. "Suspensión delantera MacPherson"'
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  svg_content: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Legado — SVG usado antes de migrar a image_path. Aún lo usa el PDF hasta migrar workshopPdfService.'
  },
  image_path: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Ruta relativa a public/assets/diagrams/, ej. "suspension/macpherson.webp"'
  },
  view_box: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: '0 0 600 400'
  },
  points: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
    comment: 'Catálogo de partes numeradas: [{point_number, x, y, part_name, label_dx?, label_dy?}]. ' +
      'label_dx/label_dy (opcionales) desplazan el número respecto a (x,y) y el frontend dibuja una ' +
      'línea guía desde el label hasta el punto real — usados cuando hay varias marcas muy próximas.'
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  is_customized: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'true = editado a mano vía el panel admin (image_path y/o points); el seed deja de sobreescribirla'
  }
}, {
  tableName: 'diagram_templates',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['vehicle_type', 'system', 'configuration'] }
  ]
});

module.exports = DiagramTemplate;
