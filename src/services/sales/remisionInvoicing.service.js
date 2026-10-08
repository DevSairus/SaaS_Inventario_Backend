// backend/src/services/sales/remisionInvoicing.service.js
//
// Facturar electrónicamente remisiones ya confirmadas (pagadas o no), si el
// tenant lo habilitó (features.allow_remision_to_invoice). Solo remisiones
// del mes en curso: el ingreso y el IVA ya quedaron contabilizados en la
// fecha de la remisión, y la factura sale con la fecha del día en que se
// emite -- dentro del mismo mes, ambos caen en el mismo periodo.
//
// Dos modos:
//
// 1. Individual (convertRemisionToInvoice): la MISMA venta pasa de remisión
//    a factura -- nuevo consecutivo de la resolución DIAN, remision_number
//    conserva el REM-XXXX original. Pagos, recibos, kardex, asiento y la OT
//    vinculada no se tocan: los valores son idénticos (la remisión ya lleva
//    el IVA internamente, aunque se oculte con hide_remision_tax).
//
// 2. Agrupada (consolidateRemisiones): varias remisiones del mismo cliente y
//    sede → una factura NUEVA (is_consolidated_invoice). Esa factura es solo
//    el documento fiscal: el ingreso, los pagos, la cartera, el kardex y los
//    asientos siguen viviendo en las remisiones, que quedan apuntando a ella
//    (invoiced_in_sale_id). Por eso se excluye de los agregados económicos
//    (utils/remisionVisibility.js) y su paid_amount es un reflejo de las
//    remisiones (syncConsolidatedInvoice). Un pago registrado sobre la
//    factura se reparte entre sus remisiones (sales.controller#registerPayment).
//
// Mientras la DIAN no la haya aceptado (rechazada o con error), cualquiera de
// las dos se puede revertir (revertInvoicing): la venta vuelve a ser
// remisión, o la factura consolidada se cancela y libera sus remisiones.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const {
  Sale, SaleItem, Customer, Product, Vehicle, Tenant, DianResolution, CustomerReturn,
} = require('../../models');

const { resolvePaymentTerms, toDateOnly } = require('./paymentTerms.service');

const FEATURE_KEY = 'allow_remision_to_invoice';
const TIMEZONE = 'America/Bogota';
const INVOICEABLE_STATUSES = ['completed', 'pending'];
const REVERTIBLE_DIAN_STATUSES = ['rejected', 'error'];

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

function isEnabled(tenant) {
  return tenant?.features?.[FEATURE_KEY] === true;
}

// 'YYYY-MM' de una fecha en hora de Colombia.
function monthKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit' })
    .formatToParts(new Date(date));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}`;
}

function isCurrentMonth(date) {
  return Boolean(date) && monthKey(date) === monthKey(new Date());
}

// ── Requisitos de una factura electrónica (compartidos con confirm()) ──────
// Si se factura un producto tipo 'vehicle', su ficha de Vehicle debe traer
// ya los datos que pide el organismo de tránsito. Devuelve el mensaje de
// error o null.
async function checkVehicleData(items, tenantId) {
  const productIds = items
    .filter((i) => i.approval_status !== 'rechazado' && i.product_id)
    .map((i) => i.product_id);
  if (productIds.length === 0) return null;

  const vehicleProducts = await Product.findAll({
    where: { id: { [Op.in]: productIds }, tenant_id: tenantId, product_type: 'vehicle' },
    include: [{ model: Vehicle, as: 'vehicle' }],
  });
  const REQUIRED_VEHICLE_FIELDS = [
    ['vin', 'VIN/Chasis'], ['engine_number', 'Número de motor'],
    ['brand', 'Marca'], ['model', 'Línea'], ['year', 'Modelo (año)'], ['color', 'Color'],
  ];
  const incomplete = [];
  for (const product of vehicleProducts) {
    if (!product.vehicle) {
      incomplete.push(`${product.name}: no tiene una ficha de vehículo asociada`);
      continue;
    }
    const missing = REQUIRED_VEHICLE_FIELDS
      .filter(([field]) => !product.vehicle[field])
      .map(([, label]) => label);
    if (missing.length > 0) incomplete.push(`${product.name}: falta ${missing.join(', ')}`);
  }
  return incomplete.length > 0
    ? `No se puede facturar: faltan datos del vehículo requeridos para tránsito. ${incomplete.join(' | ')}`
    : null;
}

// El cliente debe tener ciudad DIVIPOLA y tipo de identificación (ver
// customerDianReadiness.js). Se valida contra el registro vivo del
// Customer, no contra lo cacheado en la venta. Lanza 422 si falta algo;
// devuelve el Customer (o null si la venta no tiene cliente).
async function loadDianReadyCustomer(customerId, tenantId) {
  if (!customerId) return null;
  const customer = await Customer.findOne({ where: { id: customerId, tenant_id: tenantId } });
  const { checkReadiness } = require('../dian/customerDianReadiness');
  const { ready, missing } = checkReadiness({
    customer_city_code: customer?.city_code,
    customer_document_type: customer?.document_type,
  });
  if (!ready) {
    throw httpError(422, `No se puede facturar: falta ${missing.map((m) => m.label).join(', ')} en la ficha del cliente. Complétala e intenta de nuevo.`, {
      code: 'DIAN_CUSTOMER_INCOMPLETE',
      customerId,
      missingFields: missing.map((m) => m.key),
    });
  }
  return customer;
}

// Snapshot denormalizado del comprador con el que se factura.
function customerSnapshot(customer) {
  if (!customer) return {};
  return {
    customer_city_code: customer.city_code,
    customer_city_name: customer.city,
    customer_department_name: customer.state,
    customer_document_type: customer.document_type,
  };
}

async function requireActiveResolution(tenantId, branchId) {
  const resolution = await DianResolution.findOne({
    where: { tenant_id: tenantId, branch_id: branchId, is_active: true, document_type: 'invoice' },
  });
  if (!resolution) {
    throw httpError(400, 'La sede de esta venta no tiene una resolución de facturación electrónica activa.');
  }
}

async function loadTenantWithFeature(tenantId) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!isEnabled(tenant)) {
    throw httpError(403, 'La facturación de remisiones no está habilitada para esta empresa (Configuración → Ventas).');
  }
  return tenant;
}

// Motivos por los que una remisión NO se puede facturar ([] = se puede).
async function remisionBlockers(sale) {
  const label = sale.sale_number;
  const reasons = [];
  if (sale.document_type !== 'remision') reasons.push(`${label} no es una remisión`);
  else if (!INVOICEABLE_STATUSES.includes(sale.status)) reasons.push(`${label} no está confirmada (estado: ${sale.status})`);
  if (sale.invoiced_in_sale_id) reasons.push(`${label} ya está incluida en otra factura`);
  if (!isCurrentMonth(sale.sale_date)) reasons.push(`${label} no es del mes en curso: solo se facturan remisiones del mismo mes`);

  const returns = await CustomerReturn.count({
    where: { sale_id: sale.id, status: { [Op.ne]: 'rejected' } },
  });
  if (returns > 0) reasons.push(`${label} tiene devoluciones o anulaciones registradas`);
  return reasons;
}

function sendToDianAsync(saleId, tenant) {
  setImmediate(async () => {
    try {
      const dianService = require('../dian/dianService');
      const finalSale = await Sale.findByPk(saleId, { include: [{ model: SaleItem, as: 'items' }] });
      await dianService.sendInvoiceToDian(finalSale, tenant);
    } catch (err) {
      logger.error(`[DIAN] Error async al enviar factura de remisión(es) ${saleId}: ${err.message}`);
    }
  });
}

// ── Elegibilidad (para la UI) ─────────────────────────────────────────────
async function getEligibility(sale, tenantId) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!isEnabled(tenant)) return { enabled: false, eligible: false, reasons: [] };
  const reasons = await remisionBlockers(sale);
  return { enabled: true, eligible: reasons.length === 0, reasons };
}

// ── 1. Conversión individual ──────────────────────────────────────────────
async function convertRemisionToInvoice({ saleId, tenantId, userId }) {
  const tenant = await loadTenantWithFeature(tenantId);

  const sale = await Sale.findOne({
    where: { id: saleId, tenant_id: tenantId },
    include: [{ model: SaleItem, as: 'items' }],
  });
  if (!sale) throw httpError(404, 'Venta no encontrada');

  const blockers = await remisionBlockers(sale);
  if (blockers.length > 0) throw httpError(400, blockers.join('. '));

  const vehicleError = await checkVehicleData(sale.items, tenantId);
  if (vehicleError) throw httpError(400, vehicleError);
  const customer = await loadDianReadyCustomer(sale.customer_id, tenantId);
  await requireActiveResolution(tenantId, sale.branch_id);

  const transaction = await sequelize.transaction();
  let newNumber;
  try {
    // Relee bajo lock: dos conversiones simultáneas no deben pasar ambas.
    const locked = await Sale.findOne({ where: { id: saleId, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
    if (locked.document_type !== 'remision' || locked.invoiced_in_sale_id) {
      throw httpError(409, 'Esta remisión ya fue facturada');
    }
    const { generateSaleNumber } = require('../../controllers/sales/sales.controller');
    newNumber = await generateSaleNumber(tenantId, 'factura', transaction, locked.id, locked.branch_id);
    // Contado/crédito según el saldo HOY (una remisión vendida a crédito y
    // ya pagada sale de contado), conservando el plazo que se pactó.
    const terms = resolvePaymentTerms({
      total: parseFloat(locked.total_amount),
      settled: parseFloat(locked.paid_amount || 0),
      baseDate: locked.sale_date,
      creditDays: locked.credit_days,
      dueDate: locked.due_date,
      paymentTerms: locked.payment_terms ?? customer?.payment_terms,
    });
    await locked.update({
      ...terms,
      remision_number: locked.sale_number,
      sale_number: newNumber,
      document_type: 'factura',
      dian_status: 'pending',
      converted_to_invoice_at: new Date(),
      converted_to_invoice_by: userId,
      ...customerSnapshot(customer),
    }, { transaction });
    await transaction.commit();
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    throw err;
  }

  sendToDianAsync(sale.id, tenant);
  logger.info(`[remision→factura] ${sale.sale_number} convertida a ${newNumber}`);
  return { sale_id: sale.id, sale_number: newNumber, remision_number: sale.sale_number };
}

// ── 2. Agrupación ─────────────────────────────────────────────────────────
async function consolidateRemisiones({ saleIds, tenantId, userId, notes }) {
  const ids = [...new Set(saleIds || [])];
  if (ids.length < 2) throw httpError(400, 'Selecciona al menos dos remisiones para agrupar');
  const tenant = await loadTenantWithFeature(tenantId);

  const remisiones = await Sale.findAll({
    where: { id: { [Op.in]: ids }, tenant_id: tenantId },
    include: [{ model: SaleItem, as: 'items' }],
    order: [['sale_date', 'ASC'], ['sale_number', 'ASC']],
  });
  if (remisiones.length !== ids.length) throw httpError(404, 'Alguna de las remisiones no existe');

  const reasons = [];
  for (const r of remisiones) reasons.push(...await remisionBlockers(r));
  const first = remisiones[0];
  if (!first.customer_id) reasons.push('Las remisiones deben tener un cliente registrado');
  if (remisiones.some((r) => r.customer_id !== first.customer_id)) reasons.push('Todas las remisiones deben ser del mismo cliente');
  if (remisiones.some((r) => r.branch_id !== first.branch_id)) reasons.push('Todas las remisiones deben ser de la misma sede');
  // AIU y descuento global se calculan sobre el documento entero: no se
  // pueden sumar entre remisiones sin recalcular la base. Esas se facturan
  // una por una.
  const aiu = remisiones.filter((r) => r.aiu_enabled).map((r) => r.sale_number);
  if (aiu.length) reasons.push(`${aiu.join(', ')} es factura AIU: factúrala individualmente`);
  const globalDiscount = remisiones.filter((r) => parseFloat(r.global_discount_amount || 0) > 0).map((r) => r.sale_number);
  if (globalDiscount.length) reasons.push(`${globalDiscount.join(', ')} tiene descuento global: factúrala individualmente`);
  if (reasons.length > 0) throw httpError(400, reasons.join('. '));

  const allItems = remisiones.flatMap((r) => r.items.filter((i) => i.approval_status !== 'rechazado'));
  const vehicleError = await checkVehicleData(allItems, tenantId);
  if (vehicleError) throw httpError(400, vehicleError);
  const customer = await loadDianReadyCustomer(first.customer_id, tenantId);
  await requireActiveResolution(tenantId, first.branch_id);

  const sum = (field) => round2(remisiones.reduce((s, r) => s + parseFloat(r[field] || 0), 0));
  const total = sum('total_amount');
  const paid = sum('paid_amount');
  // A crédito si queda saldo: vence cuando vence la última remisión pendiente.
  const pendingDueDates = remisiones
    .filter((r) => r.payment_status !== 'paid' && r.due_date)
    .map((r) => toDateOnly(r.due_date))
    .sort();
  const terms = resolvePaymentTerms({
    total,
    settled: paid,
    creditDays: pendingDueDates.length ? null : Math.max(0, ...remisiones.map((r) => Number(r.credit_days) || 0)),
    dueDate: pendingDueDates[pendingDueDates.length - 1],
    paymentTerms: customer?.payment_terms,
  });
  const remisionNumbers = remisiones.map((r) => r.sale_number);

  const transaction = await sequelize.transaction();
  let invoice;
  try {
    // Lock + recheck: ninguna pudo haberse facturado entre la validación y acá.
    const locked = await Sale.findAll({
      where: { id: { [Op.in]: ids }, tenant_id: tenantId },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    const taken = locked.filter((r) => r.document_type !== 'remision' || r.invoiced_in_sale_id);
    if (taken.length) throw httpError(409, `${taken.map((r) => r.sale_number).join(', ')} ya fue facturada`);

    const { generateSaleNumber } = require('../../controllers/sales/sales.controller');
    const saleNumber = await generateSaleNumber(tenantId, 'factura', transaction, null, first.branch_id);
    invoice = await Sale.create({
      tenant_id: tenantId,
      branch_id: first.branch_id,
      warehouse_id: first.warehouse_id,
      sale_number: saleNumber,
      document_type: 'factura',
      is_consolidated_invoice: true,
      status: 'completed',
      sale_date: new Date(),
      customer_id: first.customer_id,
      customer_name: customer?.business_name || first.customer_name,
      customer_tax_id: first.customer_tax_id,
      customer_email: first.customer_email,
      customer_phone: first.customer_phone,
      customer_address: first.customer_address,
      ...customerSnapshot(customer),
      subtotal: sum('subtotal'),
      tax_amount: sum('tax_amount'),
      discount_amount: sum('discount_amount'),
      total_amount: total,
      paid_amount: Math.min(paid, total),
      payment_status: paid >= total ? 'paid' : (paid > 0 ? 'partial' : 'pending'),
      payment_method: first.payment_method,
      ...terms,
      // Los pagos viven en las remisiones: si se copiaran acá, Flujo de Caja
      // (que lee payment_history) los contaría dos veces.
      payment_history: [],
      dian_status: 'pending',
      notes: notes || `Factura de las remisiones ${remisionNumbers.join(', ')}`,
      converted_to_invoice_at: new Date(),
      converted_to_invoice_by: userId,
      created_by: userId,
    }, { transaction });

    for (const item of allItems) {
      const data = item.get({ plain: true });
      delete data.id;
      delete data.created_at;
      delete data.updated_at;
      delete data.createdAt;
      delete data.updatedAt;
      await SaleItem.create({
        ...data,
        sale_id: invoice.id,
        notes: [data.notes, `Remisión ${remisiones.find((r) => r.id === item.sale_id).sale_number}`].filter(Boolean).join(' · '),
      }, { transaction });
    }

    await Sale.update(
      { invoiced_in_sale_id: invoice.id },
      { where: { id: { [Op.in]: ids }, tenant_id: tenantId }, transaction }
    );
    await transaction.commit();
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    throw err;
  }

  sendToDianAsync(invoice.id, tenant);
  logger.info(`[remision→factura] ${remisionNumbers.join(', ')} agrupadas en ${invoice.sale_number}`);
  return { sale_id: invoice.id, sale_number: invoice.sale_number, remision_numbers: remisionNumbers };
}

// Mensaje de bloqueo para anular/cancelar/devolver una venta que participa
// en una facturación de remisiones, o null si no aplica. La anulación de
// una factura consolidada aceptada por la DIAN (nota crédito que además
// libere o anule las remisiones) todavía no está soportada.
function lifecycleBlocker(sale) {
  if (sale.invoiced_in_sale_id) {
    return 'Esta remisión está incluida en una factura electrónica: no se puede anular ni devolver por separado.';
  }
  if (sale.is_consolidated_invoice) {
    return REVERTIBLE_DIAN_STATUSES.includes(sale.dian_status)
      ? 'Esta factura agrupa remisiones: usa "Revertir facturación" para anularla y liberar las remisiones.'
      : 'Esta factura agrupa remisiones: anúlala con "Anular factura agrupada" (nota crédito) y luego anula cada remisión si hubo devolución.';
  }
  return null;
}

// ── Reflejo de pagos en la factura consolidada ─────────────────────────────
// Llamar después de cualquier cambio de paid_amount en una remisión agrupada.
async function syncConsolidatedInvoice(invoiceId, transaction) {
  if (!invoiceId) return;
  const remisiones = await Sale.findAll({
    where: { invoiced_in_sale_id: invoiceId },
    attributes: ['paid_amount'],
    transaction,
  });
  const invoice = await Sale.findByPk(invoiceId, { transaction });
  if (!invoice) return;
  const total = parseFloat(invoice.total_amount);
  const paid = Math.min(round2(remisiones.reduce((s, r) => s + parseFloat(r.paid_amount || 0), 0)), total);
  await invoice.update({
    paid_amount: paid,
    payment_status: paid >= total - 0.005 ? 'paid' : (paid > 0 ? 'partial' : 'pending'),
  }, { transaction });
}

// Reparte cada valor de `amounts` ({ retefuente: 1000, ... }) entre N
// destinos en proporción a `weights`, redondeado a centavos; el último
// destino absorbe la diferencia de redondeo para que la suma cuadre exacta.
function splitProportionally(amounts, weights) {
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const shares = weights.map(() => ({}));
  for (const [key, value] of Object.entries(amounts)) {
    let assigned = 0;
    weights.forEach((w, i) => {
      const isLast = i === weights.length - 1;
      const part = isLast ? round2(value - assigned) : round2(totalWeight > 0 ? value * (w / totalWeight) : 0);
      shares[i][key] = part;
      assigned = round2(assigned + part);
    });
  }
  return shares;
}

// Remisiones de una factura consolidada con saldo pendiente, la más antigua
// primero, bloqueadas para repartir un pago.
async function lockPendingRemisiones(invoiceId, tenantId, transaction) {
  return Sale.findAll({
    where: {
      invoiced_in_sale_id: invoiceId,
      tenant_id: tenantId,
      payment_status: { [Op.in]: ['pending', 'partial'] },
    },
    order: [['sale_date', 'ASC'], ['sale_number', 'ASC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
}

// ── Anular una factura agrupada ya aceptada por la DIAN ───────────────────
// Solo efecto FISCAL: nota crédito total (concepto 2, "Anulación") que anula
// el documento; las remisiones vuelven a quedar libres para facturar. No hay
// asiento ni movimiento de inventario: la venta real (ingreso, pagos, kardex)
// está en las remisiones y no cambia. Si además hubo una devolución real, se
// anula cada remisión después de liberarla.
// La nota se marca también is_consolidated_invoice: es un documento solo
// fiscal y queda fuera de los agregados económicos, igual que su factura.
async function annulConsolidatedInvoice({ saleId, tenantId, userId, reason }) {
  const invoice = await Sale.findOne({
    where: { id: saleId, tenant_id: tenantId },
    include: [{ model: SaleItem, as: 'items' }],
  });
  if (!invoice) throw httpError(404, 'Venta no encontrada');
  if (!invoice.is_consolidated_invoice || invoice.document_type !== 'factura') {
    throw httpError(400, 'Esta acción solo aplica a facturas que agrupan remisiones');
  }
  if (invoice.status === 'cancelled') throw httpError(400, 'Esta factura ya está anulada');
  if (invoice.dian_status !== 'accepted' || !invoice.cufe) {
    throw httpError(400, REVERTIBLE_DIAN_STATUSES.includes(invoice.dian_status)
      ? 'La DIAN no aceptó esta factura: usa "Revertir agrupación".'
      : 'La factura todavía no ha sido aceptada por la DIAN.');
  }
  const existing = await Sale.findOne({
    where: { reference_sale_id: invoice.id, document_type: 'nota_credito', status: { [Op.ne]: 'cancelled' } },
  });
  if (existing) {
    throw httpError(409, `Esta factura ya tiene la nota crédito ${existing.dian_invoice_number || existing.sale_number} (DIAN: ${existing.dian_status}). Si fue rechazada, reenvíala desde su detalle.`);
  }

  const transaction = await sequelize.transaction();
  let note;
  let noteItems;
  try {
    note = await Sale.create({
      tenant_id: tenantId,
      branch_id: invoice.branch_id,
      reference_sale_id: invoice.id,
      sale_number: `NC-${Date.now()}`, // el definitivo lo asigna la DIAN al enviar
      document_type: 'nota_credito',
      is_consolidated_invoice: true,
      sale_date: new Date(),
      customer_id: invoice.customer_id,
      customer_name: invoice.customer_name,
      customer_tax_id: invoice.customer_tax_id,
      customer_email: invoice.customer_email,
      customer_phone: invoice.customer_phone,
      customer_address: invoice.customer_address,
      customer_city_code: invoice.customer_city_code,
      customer_city_name: invoice.customer_city_name,
      customer_department_name: invoice.customer_department_name,
      customer_document_type: invoice.customer_document_type,
      subtotal: invoice.subtotal,
      tax_amount: invoice.tax_amount,
      discount_amount: invoice.discount_amount,
      total_amount: invoice.total_amount,
      payment_method: invoice.payment_method,
      payment_form: invoice.payment_form,
      payment_status: 'paid',
      paid_amount: invoice.total_amount,
      payment_history: [],
      status: 'completed',
      dian_status: 'pending',
      notes: `Anulación de la factura ${invoice.dian_invoice_number || invoice.sale_number} (agrupa remisiones).${reason ? ' Motivo: ' + reason : ''}`,
      created_by: userId,
    }, { transaction });

    noteItems = [];
    for (const item of invoice.items) {
      const data = item.get({ plain: true });
      for (const k of ['id', 'created_at', 'updated_at', 'createdAt', 'updatedAt']) delete data[k];
      noteItems.push(await SaleItem.create({ ...data, sale_id: note.id }, { transaction }));
    }
    await transaction.commit();
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    throw err;
  }

  const tenant = await Tenant.findByPk(tenantId);
  setImmediate(async () => {
    try {
      const dianService = require('../dian/dianService');
      await dianService.sendCreditNoteToDian({ ...note.toJSON(), items: noteItems.map((i) => i.toJSON()) }, tenant);
    } catch (err) {
      logger.error(`[DIAN] Error enviando NC de anulación ${note.sale_number} (factura ${invoice.sale_number}): ${err.message}`);
      await Sale.update({ dian_status: 'rejected', dian_error_message: err.message }, { where: { id: note.id } });
    }
  });

  logger.info(`[remision→factura] Anulación de ${invoice.sale_number} en curso con NC ${note.sale_number}`);
  return { note_id: note.id, note_number: note.sale_number, invoice_number: invoice.sale_number };
}

// Lo llama dianService cuando la DIAN acepta la NC de anulación (también en
// un reintento): la factura queda cancelada y libera sus remisiones.
async function releaseAnnulledConsolidated(invoiceId, noteNumber) {
  const transaction = await sequelize.transaction();
  try {
    const invoice = await Sale.findByPk(invoiceId, { lock: transaction.LOCK.UPDATE, transaction });
    if (!invoice || !invoice.is_consolidated_invoice || invoice.status === 'cancelled') {
      await transaction.rollback();
      return null;
    }
    const released = await Sale.findAll({ where: { invoiced_in_sale_id: invoice.id }, attributes: ['sale_number'], transaction });
    await Sale.update({ invoiced_in_sale_id: null }, { where: { invoiced_in_sale_id: invoice.id }, transaction });
    await invoice.update({
      status: 'cancelled',
      internal_notes: `Anulada con la nota crédito ${noteNumber}; remisiones liberadas: ${released.map((r) => r.sale_number).join(', ')}`,
    }, { transaction });
    await transaction.commit();
    logger.info(`[remision→factura] ${invoice.sale_number} anulada con ${noteNumber}; liberadas ${released.length} remisiones`);
    return released.map((r) => r.sale_number);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    throw err;
  }
}

// ── Revertir mientras la DIAN no la haya aceptado ──────────────────────────
async function revertInvoicing({ saleId, tenantId, userId }) {
  const transaction = await sequelize.transaction();
  try {
    const sale = await Sale.findOne({ where: { id: saleId, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
    if (!sale) throw httpError(404, 'Venta no encontrada');
    const fromRemision = sale.document_type === 'factura' && (sale.remision_number || sale.is_consolidated_invoice);
    if (!fromRemision) throw httpError(400, 'Esta factura no proviene de remisiones');
    if (!REVERTIBLE_DIAN_STATUSES.includes(sale.dian_status)) {
      throw httpError(400, 'Solo se puede revertir una factura rechazada por la DIAN o con error de envío. Si ya fue aceptada, anúlala con una nota crédito.');
    }

    let result;
    if (sale.is_consolidated_invoice) {
      const released = await Sale.findAll({ where: { invoiced_in_sale_id: sale.id }, attributes: ['sale_number'], transaction });
      await Sale.update({ invoiced_in_sale_id: null }, { where: { invoiced_in_sale_id: sale.id }, transaction });
      await sale.update({
        status: 'cancelled',
        internal_notes: `Agrupación revertida (DIAN: ${sale.dian_status}); remisiones liberadas: ${released.map((r) => r.sale_number).join(', ')}`,
      }, { transaction });
      result = { reverted: 'consolidated', released: released.map((r) => r.sale_number) };
    } else {
      // El número de factura queda sin usar: la DIAN no lo aceptó, así que no
      // cuenta como emitido.
      await sale.update({
        sale_number: sale.remision_number,
        remision_number: null,
        document_type: 'remision',
        dian_status: 'not_applicable',
        dian_invoice_number: null,
        cufe: null,
        converted_to_invoice_at: null,
        converted_to_invoice_by: null,
      }, { transaction });
      result = { reverted: 'individual', sale_number: sale.sale_number };
    }
    await transaction.commit();
    logger.info(`[remision→factura] Revertida ${saleId} por ${userId}: ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    throw err;
  }
}

module.exports = {
  FEATURE_KEY,
  isEnabled,
  isCurrentMonth,
  checkVehicleData,
  loadDianReadyCustomer,
  customerSnapshot,
  getEligibility,
  convertRemisionToInvoice,
  consolidateRemisiones,
  syncConsolidatedInvoice,
  lockPendingRemisiones,
  splitProportionally,
  lifecycleBlocker,
  revertInvoicing,
  annulConsolidatedInvoice,
  releaseAnnulledConsolidated,
  httpError,
};
