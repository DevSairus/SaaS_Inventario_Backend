// Facturación recurrente (contratos) -- ver services/sales/recurringInvoices.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const base = { underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' };

const RecurringInvoice = sequelize.define('RecurringInvoice', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  customer_id: { type: DataTypes.UUID, allowNull: false },
  branch_id: { type: DataTypes.UUID, allowNull: true },
  name: { type: DataTypes.STRING(200), allowNull: false },
  // [{ product_id, description, quantity, unit_price, discount_percentage }]
  items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  frequency_months: { type: DataTypes.INTEGER, allowNull: false, validate: { isIn: [[1, 2, 3, 6, 12]] } },
  billing_day: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 28 } },
  start_date: { type: DataTypes.DATEONLY, allowNull: false },
  end_date: { type: DataTypes.DATEONLY, allowNull: true },
  max_invoices: { type: DataTypes.INTEGER, allowNull: true },
  credit_days: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
  payment_method: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'Transferencia' },
  notes: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'active', validate: { isIn: [['active', 'paused', 'finished', 'cancelled']] } },
  next_run_date: { type: DataTypes.DATEONLY, allowNull: true },
  invoices_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  last_run_at: { type: DataTypes.DATE, allowNull: true },
  last_error: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { ...base, tableName: 'recurring_invoices' });

const RecurringInvoiceRun = sequelize.define('RecurringInvoiceRun', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  recurring_invoice_id: { type: DataTypes.UUID, allowNull: false },
  period_date: { type: DataTypes.DATEONLY, allowNull: false },
  sale_id: { type: DataTypes.UUID, allowNull: true },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'processing', validate: { isIn: [['processing', 'issued', 'failed']] } },
  message: { type: DataTypes.TEXT, allowNull: true },
}, { ...base, tableName: 'recurring_invoice_runs' });

RecurringInvoice.hasMany(RecurringInvoiceRun, { foreignKey: 'recurring_invoice_id', as: 'runs' });
RecurringInvoiceRun.belongsTo(RecurringInvoice, { foreignKey: 'recurring_invoice_id', as: 'contract' });

module.exports = { RecurringInvoice, RecurringInvoiceRun };
