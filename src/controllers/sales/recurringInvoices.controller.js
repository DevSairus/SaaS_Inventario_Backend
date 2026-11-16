// backend/src/controllers/sales/recurringInvoices.controller.js
// Facturación recurrente (contratos). Ver services/sales/recurringInvoices.service.js.
const { RecurringInvoice, RecurringInvoiceRun, Customer, Sale, Product } = require('../../models');
const svc = require('../../services/sales/recurringInvoices.service');
const audit = require('../../utils/audit');
const logger = require('../../config/logger');

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}: ${error.message}`);
  return res.status(500).json({ success: false, message });
};
const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Subtotal (sin impuestos) de una factura del contrato. */
const subtotalOf = (items) => round2((items || []).reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0) * (1 - Number(i.discount_percentage || 0) / 100), 0));
const customerName = (c) => (c ? (c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ')) : '');

/** Valida y normaliza el cuerpo del contrato. */
async function contractData(tenantId, body, current = null) {
  const out = {};
  const pick = (k) => (body[k] !== undefined ? body[k] : current?.[k]);
  out.customer_id = pick('customer_id');
  if (!out.customer_id) throw bad('Elige el cliente');
  const customer = await Customer.findOne({ where: { id: out.customer_id, tenant_id: tenantId }, attributes: ['id'] });
  if (!customer) throw bad('Cliente no encontrado');
  out.name = String(pick('name') || '').trim();
  if (!out.name) throw bad('Escribe un nombre para el contrato (p. ej. "Plan Taller Básico")');
  out.branch_id = pick('branch_id') || null;

  const items = Array.isArray(pick('items')) ? pick('items') : [];
  if (!items.length) throw bad('Agrega al menos un producto o servicio');
  const ids = items.map((i) => i.product_id).filter(Boolean);
  const products = await Product.findAll({ where: { id: ids, tenant_id: tenantId }, attributes: ['id', 'name'] });
  const byId = new Map(products.map((p) => [p.id, p]));
  out.items = items.map((i) => {
    const p = byId.get(i.product_id);
    if (!p) throw bad('Cada línea debe tener un producto existente');
    const quantity = Number(i.quantity);
    const unit_price = Number(i.unit_price);
    const discount = Number(i.discount_percentage || 0);
    if (!(quantity > 0)) throw bad(`Cantidad inválida en "${p.name}"`);
    if (!(unit_price >= 0)) throw bad(`Precio inválido en "${p.name}"`);
    if (discount < 0 || discount >= 100) throw bad(`Descuento inválido en "${p.name}"`);
    return { product_id: p.id, description: p.name, quantity, unit_price, discount_percentage: discount };
  });

  out.frequency_months = Number(pick('frequency_months'));
  if (!svc.FREQUENCIES[out.frequency_months]) throw bad('Frecuencia inválida');
  out.billing_day = Number(pick('billing_day'));
  if (!(out.billing_day >= 1 && out.billing_day <= 28)) throw bad('El día de facturación debe estar entre 1 y 28');
  out.start_date = pick('start_date');
  if (!out.start_date) throw bad('Indica la fecha de inicio');
  out.end_date = pick('end_date') || null;
  if (out.end_date && out.end_date < out.start_date) throw bad('La fecha de fin no puede ser anterior al inicio');
  out.max_invoices = pick('max_invoices') ? Number(pick('max_invoices')) : null;
  if (out.max_invoices !== null && !(out.max_invoices >= 1)) throw bad('El número de facturas debe ser 1 o más');
  out.credit_days = Number(pick('credit_days') ?? 30);
  if (!(out.credit_days >= 0 && out.credit_days <= 365)) throw bad('El plazo de crédito debe estar entre 0 y 365 días');
  out.payment_method = pick('payment_method') || 'Transferencia';
  out.notes = pick('notes') || null;
  return out;
}

// GET /api/sales/recurring
exports.list = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.status) where.status = req.query.status;
    const rows = await RecurringInvoice.findAll({ where, order: [['status', 'ASC'], ['next_run_date', 'ASC']] });
    const customers = rows.length ? await Customer.findAll({ where: { id: rows.map((r) => r.customer_id) }, attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id'] }) : [];
    const byId = new Map(customers.map((c) => [c.id, c]));
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r.toJSON(),
        customer_name: customerName(byId.get(r.customer_id)),
        customer_tax_id: byId.get(r.customer_id)?.tax_id || null,
        frequency_label: svc.FREQUENCIES[r.frequency_months],
        subtotal: subtotalOf(r.items),
      })),
    });
  } catch (error) {
    fail(res, error, 'Error listando los contratos recurrentes');
  }
};

// GET /api/sales/recurring/preview?month=YYYY-MM -- qué se va a facturar ese mes
exports.preview = async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : svc.colombiaToday().slice(0, 7);
    const rows = await RecurringInvoice.findAll({ where: { tenant_id: req.tenant_id, status: 'active' } });
    const customers = rows.length ? await Customer.findAll({ where: { id: rows.map((r) => r.customer_id) }, attributes: ['id', 'first_name', 'last_name', 'business_name'] }) : [];
    const byId = new Map(customers.map((c) => [c.id, c]));
    const out = [];
    for (const r of rows) {
      let date = r.next_run_date ? String(r.next_run_date).slice(0, 10) : null;
      let count = r.invoices_count;
      // Avanza desde la próxima fecha hasta el mes pedido (incluye atrasados).
      for (let i = 0; date && date.slice(0, 7) <= month && i < 120; i++) {
        if (svc.isOver(r, date, count)) break;
        if (date.slice(0, 7) === month || date.slice(0, 7) < month && i === 0) {
          out.push({ id: r.id, name: r.name, customer_name: customerName(byId.get(r.customer_id)), date, overdue: date.slice(0, 7) < month, subtotal: subtotalOf(r.items) });
        }
        count += 1;
        date = svc.addMonths(date, r.frequency_months, r.billing_day);
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ success: true, data: { month, items: out, total: round2(out.reduce((s, x) => s + x.subtotal, 0)) } });
  } catch (error) {
    fail(res, error, 'Error calculando la proyección');
  }
};

// GET /api/sales/recurring/:id -- contrato + historial
exports.get = async (req, res) => {
  try {
    const r = await RecurringInvoice.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!r) return res.status(404).json({ success: false, message: 'Contrato no encontrado' });
    const runs = await RecurringInvoiceRun.findAll({ where: { recurring_invoice_id: r.id }, order: [['period_date', 'DESC']] });
    const sales = runs.some((x) => x.sale_id)
      ? await Sale.findAll({ where: { id: runs.map((x) => x.sale_id).filter(Boolean) }, attributes: ['id', 'sale_number', 'dian_invoice_number', 'dian_status', 'total_amount', 'payment_status', 'status'] })
      : [];
    const saleById = new Map(sales.map((s) => [s.id, s]));
    const customer = await Customer.findByPk(r.customer_id, { attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id'] });
    res.json({
      success: true,
      data: {
        ...r.toJSON(),
        customer_name: customerName(customer),
        frequency_label: svc.FREQUENCIES[r.frequency_months],
        subtotal: subtotalOf(r.items),
        runs: runs.map((x) => ({ ...x.toJSON(), sale: saleById.get(x.sale_id) || null })),
      },
    });
  } catch (error) {
    fail(res, error, 'Error cargando el contrato');
  }
};

// POST /api/sales/recurring
exports.create = async (req, res) => {
  try {
    const data = await contractData(req.tenant_id, req.body);
    const first = svc.firstRunDate(data.start_date, data.billing_day);
    const row = await RecurringInvoice.create({
      ...data,
      tenant_id: req.tenant_id,
      next_run_date: svc.isOver(data, first, 0) ? null : first,
      status: svc.isOver(data, first, 0) ? 'finished' : 'active',
      created_by: req.user?.id || null,
    });
    await audit({ tenant_id: req.tenant_id, user_id: req.user?.id, action: 'recurring_invoice.create', entity: 'RecurringInvoice', entity_id: row.id, changes: { name: row.name, next_run_date: row.next_run_date } }).catch(() => {});
    res.status(201).json({ success: true, message: `Contrato creado. Primera factura: ${row.next_run_date || '—'}`, data: row });
  } catch (error) {
    fail(res, error, 'Error creando el contrato');
  }
};

// PUT /api/sales/recurring/:id
exports.update = async (req, res) => {
  try {
    const r = await RecurringInvoice.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!r) return res.status(404).json({ success: false, message: 'Contrato no encontrado' });
    if (['finished', 'cancelled'].includes(r.status)) return res.status(400).json({ success: false, message: 'Un contrato terminado no se edita' });
    const data = await contractData(req.tenant_id, req.body, r);
    let next = r.next_run_date;
    if (!r.invoices_count) {
      // Aún sin facturas: la primera fecha sale del inicio y el día nuevos.
      next = svc.firstRunDate(data.start_date, data.billing_day);
    } else if (next && data.billing_day !== r.billing_day) {
      next = `${String(next).slice(0, 7)}-${String(data.billing_day).padStart(2, '0')}`;
    }
    const over = next && svc.isOver(data, next, r.invoices_count);
    await r.update({ ...data, next_run_date: over ? null : next, status: over ? 'finished' : r.status });
    res.json({ success: true, message: 'Contrato actualizado', data: r });
  } catch (error) {
    fail(res, error, 'Error actualizando el contrato');
  }
};

// POST /api/sales/recurring/:id/status -- { status: 'active' | 'paused' | 'cancelled' }
exports.setStatus = async (req, res) => {
  try {
    const r = await RecurringInvoice.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!r) return res.status(404).json({ success: false, message: 'Contrato no encontrado' });
    const status = req.body?.status;
    if (!['active', 'paused', 'cancelled'].includes(status)) return res.status(400).json({ success: false, message: 'Estado inválido' });
    if (['finished', 'cancelled'].includes(r.status)) return res.status(400).json({ success: false, message: 'El contrato ya terminó' });
    const updates = { status };
    if (status === 'active' && r.next_run_date && String(r.next_run_date) < svc.colombiaToday()) {
      // Al reanudar no se facturan los períodos de la pausa: sigue el próximo desde hoy.
      let next = String(r.next_run_date).slice(0, 10);
      while (next < svc.colombiaToday()) next = svc.addMonths(next, r.frequency_months, r.billing_day);
      updates.next_run_date = next;
    }
    await r.update(updates);
    await audit({ tenant_id: req.tenant_id, user_id: req.user?.id, action: `recurring_invoice.${status}`, entity: 'RecurringInvoice', entity_id: r.id, changes: updates }).catch(() => {});
    res.json({ success: true, message: { active: 'Contrato reanudado', paused: 'Contrato en pausa', cancelled: 'Contrato terminado' }[status], data: r });
  } catch (error) {
    fail(res, error, 'Error cambiando el estado');
  }
};

// POST /api/sales/recurring/:id/run -- emite ya los períodos vencidos (o reintenta el que falló)
exports.runNow = async (req, res) => {
  try {
    const r = await RecurringInvoice.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!r) return res.status(404).json({ success: false, message: 'Contrato no encontrado' });
    if (r.status !== 'active') return res.status(400).json({ success: false, message: 'El contrato no está activo' });
    if (!r.next_run_date || String(r.next_run_date) > svc.colombiaToday()) {
      return res.status(400).json({ success: false, message: `Aún no le toca facturar: la próxima factura es el ${r.next_run_date || '—'}` });
    }
    const results = await svc.runDue(req.tenant_id, { contractId: r.id, userId: req.user?.id });
    const issued = results.filter((x) => x.status === 'issued').length;
    const failed = results.find((x) => x.status === 'failed');
    if (failed) return res.status(400).json({ success: false, message: `No se pudo facturar el período ${failed.period}: ${failed.message}`, data: results });
    res.json({ success: true, message: `Se emitieron ${issued} factura(s)`, data: results });
  } catch (error) {
    fail(res, error, 'Error facturando el contrato');
  }
};
