// backend/src/models/finance/CashSession.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CashSession = sequelize.define('CashSession', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
  },
  branch_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'branches', key: 'id' },
  },

  // Fecha de negocio de la caja (normalmente coincide con el día en que se
  // abre). Se usa para filtrar los movimientos de Tesorería de ese día.
  session_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'open',
    validate: { isIn: [['open', 'closed']] },
  },

  // ── Apertura ──────────────────────────────────────────────
  opening_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    comment: 'Base en efectivo con la que se abre la caja',
  },
  opening_notes: { type: DataTypes.TEXT },
  opened_by: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  opened_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },

  // ── Cierre ────────────────────────────────────────────────
  // Todas estas son JSONB con forma { efectivo: n, tarjeta: n, transferencia: n, otro: n }
  expected_amounts: {
    type: DataTypes.JSONB,
    defaultValue: {},
    comment: 'Lo que el sistema calcula que debería haber, por método de pago (incluye la base en efectivo)',
  },
  counted_amounts: {
    type: DataTypes.JSONB,
    defaultValue: {},
    comment: 'Lo que la persona contó/reportó físicamente al cerrar, por método de pago',
  },
  differences: {
    type: DataTypes.JSONB,
    defaultValue: {},
    comment: 'counted - expected, por método de pago (positivo = sobrante, negativo = faltante)',
  },
  closing_notes: { type: DataTypes.TEXT },
  closed_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  closed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'cash_sessions',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = CashSession;