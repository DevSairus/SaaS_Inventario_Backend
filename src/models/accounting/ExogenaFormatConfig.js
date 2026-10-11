// backend/src/models/accounting/ExogenaFormatConfig.js
//
// Información Exógena DIAN — Fase 4 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Un registro por (tenant, formato) — checklist de los 13 formatos
// seleccionables. format_code no tiene FK propia: el catálogo completo
// (nombre, versión, grupo, si Pitbox ya lo puede generar) vive en
// data/exogena-catalogs.js, no en base de datos.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ExogenaFormatConfig = sequelize.define(
  'ExogenaFormatConfig',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    format_code: { type: DataTypes.STRING(10), allowNull: false },
    is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Opciones del formato (migración 2026101003), p. ej. { prior_year_returns: 'skip' | 'subtract' }.
    options: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  },
  {
    tableName: 'exogena_format_configs',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id', 'format_code'], unique: true },
    ],
  }
);

module.exports = ExogenaFormatConfig;
