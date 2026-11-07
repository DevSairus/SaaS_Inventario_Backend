// backend/src/models/solar/SolarSetting.js
// Parámetros del cotizador solar por empresa (migración 2026110611).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SolarSetting = sequelize.define('SolarSetting', {
  tenant_id: { type: DataTypes.UUID, primaryKey: true, references: { model: 'tenants', key: 'id' } },
  price_per_kwp: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 1250000 },
  labor_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 22 },
  electrical_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 13 },
  consulting_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
  service_tax_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 19 },
  performance_ratio: { type: DataTypes.DECIMAL(4, 3), allowNull: false, defaultValue: 0.8 },
  default_hsp: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 4.5 },
  dc_ac_ratio: { type: DataTypes.DECIMAL(4, 2), allowNull: false, defaultValue: 1.2 },
  panel_product_id: { type: DataTypes.UUID, allowNull: true },
  panel_watts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 645 },
  inverter_product_id: { type: DataTypes.UUID, allowNull: true },
  use_aiu: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  aiu_admin_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
  aiu_unforeseen_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 5 },
  aiu_profit_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
  validity_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
  payment_terms: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  conditions: { type: DataTypes.TEXT, allowNull: true },
  ocr_api_key: { type: DataTypes.STRING(200), allowNull: true }, // OCR.space: ya no se usa
  // Simulador público (migración 2026110613)
  public_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  public_title: { type: DataTypes.STRING(150), allowNull: true },
  public_intro: { type: DataTypes.TEXT, allowNull: true },
  public_price_range_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 10 },
  public_default_tariff: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 900 },
  public_privacy_url: { type: DataTypes.STRING(300), allowNull: true },
  public_notify_emails: { type: DataTypes.STRING(500), allowNull: true },
  public_whatsapp: { type: DataTypes.STRING(30), allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'solar_settings', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = SolarSetting;
