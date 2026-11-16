// Modelos de ICA por municipio -- ver migración 2026100505-ica-municipal.js
// y services/tax/ica.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const base = { underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' };

const IcaMunicipality = sequelize.define('IcaMunicipality', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  city_code: { type: DataTypes.STRING(10), allowNull: true },
  city_name: { type: DataTypes.STRING(120), allowNull: false },
  periodicity: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'bimestral', validate: { isIn: [['mensual', 'bimestral', 'anual']] } },
  // Avisos y tableros: % sobre el ICA (normalmente 15%).
  avisos_tableros: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  avisos_pct: { type: DataTypes.DECIMAL(6, 3), allowNull: false, defaultValue: 15 },
  // Sobretasa bomberil: % sobre el ICA (lo fija cada municipio).
  bomberil_pct: { type: DataTypes.DECIMAL(6, 3), allowNull: false, defaultValue: 0 },
  autoica_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // Aproximar los renglones de la declaración al múltiplo de mil más cercano.
  round_thousands: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  // Prefijos de cuentas de ingreso que NO son base gravable (p.ej. 4210
  // financieros, 4245 utilidad en venta de activos fijos).
  excluded_account_prefixes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { ...base, tableName: 'ica_municipalities' });

const IcaActivity = sequelize.define('IcaActivity', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  municipality_id: { type: DataTypes.UUID, allowNull: false },
  ciiu_code: { type: DataTypes.STRING(10), allowNull: true },
  description: { type: DataTypes.STRING(200), allowNull: false },
  // Tarifa en por mil (‰).
  rate: { type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
  // Tarifa de autorretención (‰); null = la misma tarifa del ICA.
  autoica_rate: { type: DataTypes.DECIMAL(7, 4), allowNull: true },
  // Prefijos de cuentas de ingreso de esta actividad (p.ej. ['4135'] comercio,
  // ['4155'] servicios). Una cuenta sin prefijo coincidente va a la actividad
  // is_default.
  account_prefixes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  // Formulario 2593 (SIMPLE): grupo del art. 908 E.T. ('1','2','3','3p','6')
  // y tarifa ICA consolidada (‰) adoptada por el municipio (null = calculada).
  simple_group: { type: DataTypes.STRING(4), allowNull: true, validate: { isIn: [['1', '2', '3', '3p', '6']] } },
  simple_rate: { type: DataTypes.DECIMAL(7, 4), allowNull: true },
}, { ...base, tableName: 'ica_activities' });

// Formulario 2593: un recibo por año y bimestre (ver simple2593.service.js).
const SimpleReceipt = sequelize.define('SimpleReceipt', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  year: { type: DataTypes.INTEGER, allowNull: false },
  period: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 6 } },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'borrador', validate: { isIn: [['borrador', 'presentado']] } },
  inputs: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  result: { type: DataTypes.JSONB, allowNull: true },
  form_number: { type: DataTypes.STRING(40), allowNull: true },
  presented_at: { type: DataTypes.DATE, allowNull: true },
  presented_by: { type: DataTypes.UUID, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { ...base, tableName: 'simple_receipts' });

const IcaSettlement = sequelize.define('IcaSettlement', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  municipality_id: { type: DataTypes.UUID, allowNull: false },
  kind: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ica', validate: { isIn: [['ica', 'autoica']] } },
  date_from: { type: DataTypes.DATEONLY, allowNull: false },
  date_to: { type: DataTypes.DATEONLY, allowNull: false },
  base_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  tax_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  // Retenciones y autorretenciones descontadas (solo kind 'ica').
  credits_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  balance_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  detail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  entry_id: { type: DataTypes.UUID, allowNull: true },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'causado', validate: { isIn: [['causado', 'anulado']] } },
  created_by: { type: DataTypes.UUID, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  voided_by: { type: DataTypes.UUID, allowNull: true },
  voided_at: { type: DataTypes.DATE, allowNull: true },
  void_reason: { type: DataTypes.TEXT, allowNull: true },
}, { tableName: 'ica_settlements', underscored: true, timestamps: false });

IcaMunicipality.hasMany(IcaActivity, { foreignKey: 'municipality_id', as: 'activities' });
IcaActivity.belongsTo(IcaMunicipality, { foreignKey: 'municipality_id', as: 'municipality' });
IcaSettlement.belongsTo(IcaMunicipality, { foreignKey: 'municipality_id', as: 'municipality' });

module.exports = { IcaMunicipality, IcaActivity, IcaSettlement, SimpleReceipt };
