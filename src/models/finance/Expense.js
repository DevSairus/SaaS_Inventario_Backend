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
  // ── DIAN — Documento Soporte (mismo criterio que Purchase) ──────────
  // requires_support_document es el único flag de intención que vive
  // acá; el estado/CUDS/respuesta DIAN vive en support_documents
  // (models/dian/SupportDocument.js). subtotal/tax_rate/tax_amount
  // existen porque, a diferencia de Purchase (que ya traía desglose vía
  // PurchaseItem), Expense solo tenía total_amount sin discriminar IVA —
  // el Documento Soporte necesita base + impuesto por separado.
  // total_amount = subtotal + tax_amount (recalculado en el controller).
  requires_support_document: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Precargado en true cuando supplier.is_obligated_to_invoice=false, editable por el usuario.'
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    comment: 'Base gravable del gasto (sin IVA).'
  },
  tax_rate: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: 0,
    comment: '% de IVA aplicado (0 cuando el gasto no genera IVA discriminado).'
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  // ── Retenciones — mismo set que ya existe en Purchase desde Fase C
  // (2026070302-add-multi-tax-system.js). Un gasto a un independiente
  // (honorarios, arriendo) puede generar autorretención igual que una
  // compra de inventario.
  retefuente_rate:   { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
  retefuente_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  reteiva_rate:      { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
  reteiva_amount:    { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  reteica_rate:      { type: DataTypes.DECIMAL(5, 4), defaultValue: 0 },
  reteica_amount:    { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  total_retentions:  { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
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
