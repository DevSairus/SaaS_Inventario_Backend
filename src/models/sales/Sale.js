// backend/src/models/sales/Sale.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Sale = sequelize.define('Sale', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  branch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'branches', key: 'id' },
    onDelete: 'RESTRICT',
    comment: 'Sede donde se realizó la venta',
  },
  sale_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  document_type: {
    type: DataTypes.ENUM('remision', 'factura', 'cotizacion', 'nota_credito', 'nota_debito'),
    defaultValue: null,
    allowNull: true,
  },
  customer_id: {
    type: DataTypes.UUID,
    references: { model: 'customers', key: 'id' },
    onDelete: 'SET NULL',
  },
  customer_name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  customer_tax_id: { type: DataTypes.STRING(50) },
  customer_email:  { type: DataTypes.STRING(255) },
  customer_phone:  { type: DataTypes.STRING(20) },
  customer_address:{ type: DataTypes.TEXT },
  // ── DIAN — dirección real del comprador, denormalizada al momento de
  // facturar (mismo patrón que customer_address/customer_tax_id de arriba)
  // para que la factura/NC/ND ya enviada conserve los datos con los que
  // se transmitió aunque el cliente cambie de ciudad después ──
  customer_city_code: {
    type: DataTypes.STRING(5),
    allowNull: true,
    comment: 'Código DIVIPOLA (DANE) del comprador al momento de facturar — copiado de Customer.city_code',
  },
  customer_city_name: { type: DataTypes.STRING(100), allowNull: true },
  customer_department_name: { type: DataTypes.STRING(100), allowNull: true },
  customer_document_type: {
    type: DataTypes.STRING(4),
    allowNull: true,
    comment: 'schemeID DIAN del comprador al momento de facturar — copiado de Customer.document_type',
  },
  vehicle_plate: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'Número de placa del vehículo (opcional)',
  },
  vehicle_brand: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Marca del vehículo',
  },
  vehicle_model: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Modelo del vehículo',
  },
  vehicle_year: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Año del vehículo',
  },
  vehicle_color: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Color del vehículo',
  },
  vehicle_type: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'automovil | camioneta | motocicleta | camion | otro — solo si hay diagrama de intervención asociado',
  },
  converted_to_work_order_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'work_orders', key: 'id' },
    comment: 'OT generada al convertir esta cotización, si ya fue convertida',
  },
  // ── Kilometraje ───────────────────────────────────────────
  mileage: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Kilometraje del vehículo al momento del servicio (informativo)',
  },
  // ─────────────────────────────────────────────────────────
  warehouse_id: {
    type: DataTypes.UUID,
    references: { model: 'warehouses', key: 'id' },
    onDelete: 'RESTRICT',
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  // Suma de los descuentos por línea (sale_items.discount_amount) -- NO es
  // un descuento global, ver global_discount_* abajo.
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  // Descuento global de la venta/cotización -- 'fixed' (global_discount_value
  // = monto en $) o 'percentage' (% del total antes de descuento). Se resta
  // DESPUÉS de impuestos, encima de los descuentos por línea (que sí afectan
  // la base gravable) -- ver resolveGlobalDiscount en sales.controller.js.
  // global_discount_amount queda persistido como el monto ya resuelto.
  global_discount_type: {
    type: DataTypes.STRING(10),
    defaultValue: 'fixed',
    validate: { isIn: [['fixed', 'percentage']] },
  },
  global_discount_value: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  global_discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('draft', 'pending', 'completed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending',
  },
  sale_date: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  // ── Liquidaciones de comisiones ──────────────────────────
  product_settled_at: { type: DataTypes.DATE, allowNull: true },
  product_settlement_id: { type: DataTypes.UUID, allowNull: true },
  labor_settled_at: { type: DataTypes.DATE, allowNull: true },
  labor_settlement_id: { type: DataTypes.UUID, allowNull: true },
  delivery_date: { type: DataTypes.DATE },
  credit_days: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Días de plazo pactados para pago. Null = contado.',
  },
  due_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    defaultValue: null,
    comment: 'Fecha límite de pago = sale_date + credit_days.',
  },
  payment_terms: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Plazo de pago en días (credit_days). Si no se especifica, se toma del cliente.',
  },
  payment_method:  { type: DataTypes.STRING(50) },
  payment_status: {
    type: DataTypes.ENUM('pending', 'partial', 'paid'),
    defaultValue: 'pending',
  },
  paid_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
  },
  payment_history: {
    type: DataTypes.JSONB,
    defaultValue: [],
    comment: 'Historial de pagos: [{date, amount, method, user_id}]',
  },
  notes:          { type: DataTypes.TEXT },
  internal_notes: { type: DataTypes.TEXT },
  pdf_url:        { type: DataTypes.STRING(500) },
  share_token: {
    type: DataTypes.UUID,
    allowNull: true,
    unique: true,
    comment: 'Token persistente para el link público del PDF (cotización/factura/remisión) — mismo patrón que WorkOrder.share_token',
  },
  // ── Ciclo de vida de cotizaciones (document_type='cotizacion') ───────
  quote_status: {
    type: DataTypes.ENUM('borrador', 'enviada', 'aprobada', 'parcial', 'rechazada', 'vencida'),
    allowNull: true,
    defaultValue: null,
    comment: 'Solo aplica a document_type=cotizacion. El cliente aprueba/rechaza (total o por ítem) desde /public/quote/:token. "parcial" = aprobó algunos ítems y rechazó otros.',
  },
  quote_approved_by_name:     { type: DataTypes.STRING, allowNull: true },
  quote_approved_by_document: { type: DataTypes.STRING, allowNull: true },
  quote_approved_ip:          { type: DataTypes.STRING, allowNull: true },
  quote_responded_at:         { type: DataTypes.DATE, allowNull: true },
  // ── Técnico asignado (venta directa, sin orden de trabajo) ───────────
  technician_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Técnico asignado a la venta directa (feature: technician_field_enabled)',
  },
  technician_name: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Nombre del técnico al momento de la venta (copia desnormalizada)',
  },
  // ── DIAN — Facturación Electrónica ─────────────────────────────────
  dian_status: {
    type: DataTypes.STRING(30),
    allowNull: true,
    defaultValue: 'not_applicable',
    comment: 'not_applicable | pending | sending | accepted | rejected',
  },
  dian_invoice_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Número de factura DIAN (prefijo + consecutivo)',
  },
  cufe: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'CUFE/CUDE asignado por la DIAN',
  },
  dian_response: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Última respuesta DIAN (raw)',
  },
  dian_sent_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  dian_accepted_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  dian_error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  reference_sale_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'sales', key: 'id' },
    onDelete: 'SET NULL',
    comment: 'Para notas crédito/débito: factura original que referencian (persistido para poder reenviar).',
  },
  // ── Retenciones ─────────────────────────────────────────────────────
  retefuente_rate:   { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
  retefuente_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  reteiva_rate:      { type: DataTypes.DECIMAL(5, 2), defaultValue: 0 },
  reteiva_amount:    { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  reteica_rate:      { type: DataTypes.DECIMAL(5, 4), defaultValue: 0 },
  reteica_amount:    { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  total_retentions:  { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  tax_breakdown:     { type: DataTypes.JSONB, defaultValue: [] },
  // ─────────────────────────────────────────────────────────────────────
  created_by: {
    type: DataTypes.UUID,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'sales',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tenant_id', 'sale_number'], unique: true },
    { fields: ['tenant_id', 'status'] },
    { fields: ['tenant_id', 'quote_status'] },
    { fields: ['customer_id'] },
    { fields: ['tenant_id', 'due_date'] },
  ],
});

module.exports = Sale;