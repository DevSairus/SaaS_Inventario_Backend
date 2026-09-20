// backend/src/models/accounting/ExogenaConceptMapping.js
//
// Información Exógena DIAN — Fase 4 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Mapeo de "concepto" DIAN (atributo `cpt`) para los formatos que lo exigen
// por registro (1001, 1007). A propósito Pitbox NO adivina/hardcodea el
// código de concepto: la clasificación fiscal de cada naturaleza de
// pago/ingreso la decide el contador del tenant con la cartilla de Exógena
// vigente a la mano (ver services/exogena/exogenaReadiness.service.js, que
// bloquea la generación mientras falte algún source_key por mapear).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ExogenaConceptMapping = sequelize.define(
  'ExogenaConceptMapping',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    format_code: { type: DataTypes.STRING(10), allowNull: false },
    // 'purchase' | 'expense:<category>' | 'sale' — ver
    // services/exogena/thirdPartyMapper.js#SOURCE_KEYS
    source_key: { type: DataTypes.STRING(60), allowNull: false },
    concept_code: { type: DataTypes.STRING(10), allowNull: false },
  },
  {
    tableName: 'exogena_concept_mappings',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { fields: ['tenant_id', 'format_code', 'source_key'], unique: true },
    ],
  }
);

module.exports = ExogenaConceptMapping;
