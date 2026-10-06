// Bitácora de migraciones de movimientos entre cuentas -- ver
// services/accounting/accountMigration.service.js y la migración
// 2026100503-create-account-migrations.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const AccountMigration = sequelize.define(
  'AccountMigration',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    mode: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [['reclassification', 'direct']] } },
    from_account_id: { type: DataTypes.UUID, allowNull: false },
    to_account_id: { type: DataTypes.UUID, allowNull: false },
    date_from: { type: DataTypes.DATEONLY, allowNull: false },
    date_to: { type: DataTypes.DATEONLY, allowNull: false },
    filters: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    lines_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_debit: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    total_credit: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
    // direct: ids de las líneas cuya cuenta se cambió.
    line_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    // reclassification: ids de los asientos generados (uno por sede).
    entry_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    // event_type de los mapeos que se repuntaron a la cuenta destino.
    mappings_updated: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    reason: { type: DataTypes.TEXT, allowNull: false },
    created_by: { type: DataTypes.UUID, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'account_migrations',
    timestamps: false,
    underscored: true,
  }
);

module.exports = AccountMigration;
