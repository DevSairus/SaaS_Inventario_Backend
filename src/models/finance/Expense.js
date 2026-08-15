const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Expense = sequelize.define('Expense', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' }
  },
  branch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'branches', key: 'id' },
    comment: 'Sede a la que pertenece el gasto (opcional, gastos de tenant no se asocian a ninguna)'
  },
  expense_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Número único del gasto, ej GAS-2026-00001'
  },
  category: {
    type: DataTypes.STRING(50),
    allowNull: false,
    validate: {
      isIn: [[
        'arriendo', 'servicios_publicos', 'nomina', 'mantenimiento',
        'transporte', 'impuestos', 'marketing', 'insumos_oficina',
        'seguros', 'honorarios', 'comisiones_tecnicos', 'otro'
      ]]
    }
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  supplier_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'suppliers', key: 'id' },
    comment: 'Proveedor asociado, si aplica (ej arriendo con un tercero registrado)'
  },
  expense_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  due_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    validate: { min: 0 }
  },
  payment_method: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  payment_status: {
    type: DataTypes.STRING(20),
    defaultValue: 'pending',
    validate: { isIn: [['pending', 'partial', 'paid']] }
  },
  paid_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  payment_history: {
    type: DataTypes.JSONB,
    defaultValue: [],
    comment: 'Historial de abonos: [{date, amount, method, user_id, notes}]'
  },
  is_recurring: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Gasto recurrente (arriendo, nómina, servicios) — informativo, no genera automatización aún'
  },
  receipt_url: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: 'URL del soporte/factura del gasto (Cloudinary u otro storage)'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  }
}, {
  tableName: 'expenses',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['tenant_id', 'branch_id'] },
    { fields: ['tenant_id', 'expense_date'] },
    { fields: ['tenant_id', 'payment_status'] },
    { unique: true, fields: ['tenant_id', 'expense_number'] }
  ]
});

module.exports = Expense;
