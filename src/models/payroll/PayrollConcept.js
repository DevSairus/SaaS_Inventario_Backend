// backend/src/models/payroll/PayrollConcept.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollConcept = sequelize.define('PayrollConcept', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  code: {
    type: DataTypes.STRING(30),
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING(150),
    allowNull: false,
  },
  concept_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [['devengado', 'deduccion']] },
  },
  dian_category: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: 'Otros',
    comment: 'Categoría del Anexo Técnico DIAN a la que mapea (Basico, HEDs, HRNs, Comisiones, AuxilioTransporte, Bonificaciones, Salud, Pension, FondoSolidaridadPension, RetencionFuente, Libranza, Otros, ...)',
  },
  dian_code: {
    type: DataTypes.STRING(10),
    allowNull: true,
    comment: 'Código de novedad/tipo específico del Anexo Técnico, cuando aplica',
  },
  calculation_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'manual',
    validate: { isIn: [['fixed', 'percentage', 'formula', 'manual']] },
  },
  default_value: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    defaultValue: 0,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // Si es true, el concepto se aplica SOLO a todos los empleados
  // liquidados en cada periodo (ver payrollService.js#liquidarEmpleado) —
  // sin necesidad de capturar una novedad manual. Restringido por el
  // controller a dian_category de valor simple (kind 'single'/
  // 'simpleList' en DIAN_CATEGORY_MAP) y calculation_type 'fixed' o
  // 'percentage' — 'manual'/'formula' no tienen sentido en automático, y
  // las categorías de arreglo/objeto necesitan campos que un cálculo
  // automático no puede inventar (ver NOVEDAD_FIELD_SCHEMAS en el
  // frontend para la lista completa de esos campos).
  auto_apply: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  sort_order: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'payroll_concepts',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PayrollConcept;
