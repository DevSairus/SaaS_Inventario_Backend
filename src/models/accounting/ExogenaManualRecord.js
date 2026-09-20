// backend/src/models/accounting/ExogenaManualRecord.js
//
// Información Exógena DIAN — Fase 4 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Captura 100% manual para formatos donde Pitbox no tiene (ni puede
// derivar) la data operativa -- hoy solo el 1004 (descuentos tributarios
// solicitados). `payload` guarda los atributos propios del formato (todo
// menos la identidad del tercero, que vive en columnas propias para poder
// validarla con exogenaReadiness igual que los formatos derivados de datos).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ExogenaManualRecord = sequelize.define(
  'ExogenaManualRecord',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    format_code: { type: DataTypes.STRING(10), allowNull: false },
    fiscal_year: { type: DataTypes.INTEGER, allowNull: false },

    third_party_document_type: { type: DataTypes.STRING(5), allowNull: false },
    third_party_tax_id: { type: DataTypes.STRING(20), allowNull: false },

    payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'exogena_manual_records',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id', 'format_code', 'fiscal_year'] },
      {
        fields: ['tenant_id', 'format_code', 'fiscal_year', 'third_party_document_type', 'third_party_tax_id'],
        unique: true,
      },
    ],
  }
);

module.exports = ExogenaManualRecord;
