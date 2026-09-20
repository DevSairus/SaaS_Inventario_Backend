// backend/src/models/accounting/BankAccount.js
//
// Cuenta bancaria del tenant — Fase 3 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3.
//
// `chart_of_account_id` apunta a una subcuenta dedicada de Bancos (ej.
// 111005-01), creada automáticamente al dar de alta esta fila -- resuelve
// el gap de que antes solo existía la cuenta genérica 111005 en
// account_mapping y dos cuentas bancarias eran contablemente indistinguibles.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const BankAccount = sequelize.define(
  'BankAccount',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },

    bank_name: { type: DataTypes.STRING(100), allowNull: false },
    account_number: { type: DataTypes.STRING(30), allowNull: false },
    account_alias: { type: DataTypes.STRING(100), allowNull: true },
    // NIT del banco (no del tenant) -- lo exige el Formato 1012 de Exógena
    // (Fase 4): ese formato reporta la entidad financiera como tercero.
    bank_tax_id: { type: DataTypes.STRING(20), allowNull: true },

    chart_of_account_id: { type: DataTypes.UUID, allowNull: false },

    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'bank_accounts',
    timestamps: true,
    underscored: true,
    indexes: [{ fields: ['tenant_id'] }],
  }
);

module.exports = BankAccount;
