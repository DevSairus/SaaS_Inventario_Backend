// backend/src/models/accounting/ExogenaShareholder.js
//
// Composición societaria del tenant (socios/accionistas/comuneros/
// cooperados) — Formato 1010 de Exógena, Fase 4 del plan de Contabilidad
// Pitbox, Grupo C. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Se captura por año gravable (fiscal_year) porque la composición
// societaria puede cambiar de un año a otro y el Formato 1010 exige el
// dato "a treinta y uno (31) de diciembre" de cada año.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ExogenaShareholder = sequelize.define(
  'ExogenaShareholder',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    fiscal_year: { type: DataTypes.INTEGER, allowNull: false },

    document_type: { type: DataTypes.STRING(5), allowNull: false },
    tax_id: { type: DataTypes.STRING(20), allowNull: false },

    first_name: { type: DataTypes.STRING(60), allowNull: true },
    last_name: { type: DataTypes.STRING(60), allowNull: true },
    business_name: { type: DataTypes.STRING(450), allowNull: true },

    address: { type: DataTypes.STRING(200), allowNull: true },
    city_code: { type: DataTypes.STRING(5), allowNull: true },
    country_code: { type: DataTypes.STRING(4), allowNull: false, defaultValue: '169' },

    nominal_value: { type: DataTypes.DECIMAL(18, 0), allowNull: false, defaultValue: 0 },
    premium_value: { type: DataTypes.DECIMAL(18, 0), allowNull: false, defaultValue: 0 },
    participation_percentage: { type: DataTypes.DECIMAL(10, 6), allowNull: false },

    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'exogena_shareholders',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id', 'fiscal_year'] },
      { fields: ['tenant_id', 'fiscal_year', 'document_type', 'tax_id'], unique: true },
    ],
  }
);

module.exports = ExogenaShareholder;
