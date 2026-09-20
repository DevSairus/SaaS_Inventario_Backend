// backend/src/models/accounting/BankImportTemplate.js
//
// Mapeo de columnas recordado por banco -- Fase 3 del plan de Contabilidad
// Pitbox. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3.
//
// `file_signature`: hash de los headers detectados (ver
// bankStatementParser.service.js#computeFileSignature). Si un import trae
// la misma firma que una plantilla ya guardada para esa `bank_account_id`,
// se aplica sola -- el mapeo manual solo se pide la primera vez por banco.
//
// `column_mapping` (JSONB), forma:
//   { fecha: '<header o índice>', descripcion: '...', referencia: '...',
//     modo: 'unico' | 'debito_credito',
//     valor: '...',              // si modo = 'unico'
//     debito: '...', credito: '...' } // si modo = 'debito_credito'
//
// `amount_format` (JSONB): { decimal_separator: ',' | '.' }
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const BankImportTemplate = sequelize.define(
  'BankImportTemplate',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    bank_account_id: { type: DataTypes.UUID, allowNull: false },

    file_signature: { type: DataTypes.STRING(64), allowNull: false },
    column_mapping: { type: DataTypes.JSONB, allowNull: false },
    date_format: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'DD/MM/YYYY' },
    amount_format: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: { decimal_separator: ',', mode: 'unico' },
    },
  },
  {
    tableName: 'bank_import_templates',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { unique: true, fields: ['bank_account_id', 'file_signature'] },
    ],
  }
);

module.exports = BankImportTemplate;
