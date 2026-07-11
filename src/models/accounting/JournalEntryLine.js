const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const JournalEntryLine = sequelize.define(
  'JournalEntryLine',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    entry_id: { type: DataTypes.UUID, allowNull: false },
    account_id: { type: DataTypes.UUID, allowNull: false },
    debit: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    credit: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    description: { type: DataTypes.STRING(255), allowNull: true },
    third_party_id: { type: DataTypes.UUID, allowNull: true },
    line_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // La tabla tiene created_at NOT NULL (sin updated_at, las líneas son
    // inmutables). Con timestamps:false Sequelize no le pone valor a menos
    // que se declare explícitamente como atributo normal — el defaultValue
    // de la migración (Sequelize.NOW en un queryInterface.createTable crudo)
    // no siempre se traduce en un DEFAULT real a nivel de Postgres, así que
    // no basta con confiar en la columna. Esto asegura el valor en cada insert.
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'journal_entry_lines',
    timestamps: false,
    underscored: true,
  }
);

module.exports = JournalEntryLine;
