// backend/src/services/sales/recurringInvoices.service.js
//
// Facturación recurrente de ventas (contratos: mensualidades, anualidades...).
//
// Cada contrato dice a qué cliente, qué líneas (precio pactado), cada cuántos
// meses, qué día y con qué plazo de crédito. Un job diario (y el botón
// "Facturar ahora") emite la factura de cada período vencido:
//   1. crea la venta y la confirma con los MISMOS controladores de la pantalla
//      de Ventas (impuestos, retenciones, numeración DIAN, asiento, envío a la
//      DIAN y correo al cliente: nada se duplica aquí);
//   2. queda a crédito (pagado 0) con el plazo del contrato, así que entra a
//      cartera y a los recordatorios de cobro;
//   3. un registro por contrato y período (UNIQUE) impide facturar dos veces
//      el mismo período, aunque el job y el botón corran a la vez.
// Si un producto tiene ingreso diferido (anualidad), su asiento va a la 27 y
// se amortiza solo (accounting/deferredRevenue.service.js).

const logger = require('../../config/logger');

const FREQUENCIES = { 1: 'Mensual', 2: 'Bimestral', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
const MAX_CATCH_UP = 12; // períodos atrasados que se emiten en una sola corrida

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
function colombiaToday() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Fecha del mes de `dateStr` + `months`, con el día de facturación. */
function addMonths(dateStr, months, day) {
  const [y, m] = ymd(dateStr).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(day)}`;
}

/** Primera fecha de facturación: el día de facturación en el mes de inicio, o en el siguiente si ya pasó. */
function firstRunDate(startDate, billingDay) {
  const start = ymd(startDate);
  const sameMonth = `${start.slice(0, 7)}-${pad(billingDay)}`;
  return sameMonth >= start ? sameMonth : addMonths(start, 1, billingDay);
}

/** ¿El contrato ya no tiene más períodos? (fin o número de facturas). */
function isOver(contract, nextDate, invoicesCount) {
  if (contract.max_invoices && invoicesCount >= contract.max_invoices) return true;
  if (contract.end_date && nextDate > ymd(contract.end_date)) return true;
  return false;
}

const periodLabel = (contract, period) => {
  const months = contract.frequency_months;
  const to = addMonths(period, months - 1, 1).slice(0, 7);
  const from = ymd(period).slice(0, 7);
  return months === 1 ? from : `${from} a ${to}`;
};

/** Ejecuta un controlador Express sin HTTP (mismo patrón que notificationsBundle.controller). */
function invoke(controllerFn, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
      setHeader() {}, send(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    Promise.resolve(controllerFn(req, res)).catch((err) => resolve({ statusCode: 500, body: { success: false, message: err.message } }));
  });
}

/** Usuario a nombre de quien se emite: el que creó el contrato o un administrador activo. */
async function issuerUser(tenantId, contract) {
  const { User } = require('../../models');
  const { Op } = require('sequelize');
  const creator = contract.created_by
    ? await User.findOne({ where: { id: contract.created_by, tenant_id: tenantId, is_active: true } })
    : null;
  return creator || User.findOne({ where: { tenant_id: tenantId, is_active: true, role: { [Op.in]: ['admin', 'manager'] } }, order: [['created_at', 'ASC']] });
}

/** Líneas del contrato en el formato del controlador de ventas. */
async function saleItemsFor(tenantId, contract) {
  const { Product } = require('../../models');
  const ids = (contract.items || []).map((i) => i.product_id).filter(Boolean);
  const products = ids.length ? await Product.findAll({ where: { id: ids, tenant_id: tenantId }, attributes: ['id', 'product_type', 'is_labor', 'is_active'] }) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  return (contract.items || []).map((i) => {
    const p = byId.get(i.product_id);
    if (!p) throw new Error(`El producto "${i.description || i.product_id}" del contrato ya no existe`);
    return {
      product_id: p.id,
      item_type: p.product_type === 'service' || p.is_labor ? 'service' : 'product',
      quantity: Number(i.quantity) || 1,
      unit_price: Number(i.unit_price) || 0,
      discount_percentage: Number(i.discount_percentage) || 0,
    };
  });
}

/**
 * Emite (o termina de emitir) la factura de UN período del contrato.
 * @returns {Promise<{ status: 'issued'|'failed'|'skipped', sale_id?, message? }>}
 */
async function issuePeriod(tenantId, contract, period, userId) {
  const { RecurringInvoiceRun, Sale } = require('../../models');
  const salesController = require('../../controllers/sales/sales.controller');

  const [run] = await RecurringInvoiceRun.findOrCreate({
    where: { recurring_invoice_id: contract.id, period_date: period },
    defaults: { tenant_id: tenantId, status: 'processing' },
  });
  if (run.status === 'issued') return { status: 'skipped', sale_id: run.sale_id };
  // Otro proceso lo está emitiendo ahora mismo (job y botón a la vez).
  if (run.status === 'processing' && run.updated_at && Date.now() - new Date(run.updated_at).getTime() < 10 * 60 * 1000 && run.sale_id) {
    return { status: 'skipped', sale_id: run.sale_id };
  }
  await run.update({ status: 'processing', message: null });

  const fail = async (message, saleId = run.sale_id) => {
    await run.update({ status: 'failed', message, sale_id: saleId || null });
    return { status: 'failed', sale_id: saleId, message };
  };

  try {
    const user = await issuerUser(tenantId, contract);
    if (!user) return fail('No hay un usuario administrador activo a nombre de quien emitir la factura');
    const baseReq = { tenant_id: tenantId, user: { id: userId || user.id, role: user.role, tenant_id: tenantId }, user_id: userId || user.id, branch_id: contract.branch_id || null, params: {}, query: {}, headers: {} };

    // 1. La venta (borrador). Si un intento anterior ya la creó, se reutiliza.
    let saleId = run.sale_id;
    if (saleId) {
      const existing = await Sale.findByPk(saleId, { attributes: ['id', 'status'] });
      if (!existing) saleId = null;
      else if (existing.status !== 'draft') {
        await run.update({ status: 'issued', message: null });
        return { status: 'issued', sale_id: saleId };
      }
    }
    if (!saleId) {
      const items = await saleItemsFor(tenantId, contract);
      const notes = [contract.notes, `${contract.name} — período ${periodLabel(contract, period)}`].filter(Boolean).join('\n');
      const created = await invoke(salesController.create, {
        ...baseReq,
        body: { customer_id: contract.customer_id, items, notes, document_type: 'factura', payment_terms: contract.credit_days },
      });
      if (!created.body?.success) return fail(created.body?.message || `No se pudo crear la venta (${created.statusCode})`);
      saleId = created.body.data?.id;
      await run.update({ sale_id: saleId });
    }

    // 2. Confirmar como factura a crédito (pagado 0) con el plazo del contrato:
    // numeración DIAN, asiento contable, envío a la DIAN y correo al cliente.
    const confirmed = await invoke(salesController.confirm, {
      ...baseReq,
      params: { id: saleId },
      body: { payment_method: contract.payment_method || 'Transferencia', paid_amount: 0, document_type: 'factura', credit_days: contract.credit_days },
    });
    if (!confirmed.body?.success) return fail(confirmed.body?.message || `No se pudo confirmar la venta (${confirmed.statusCode})`, saleId);

    await run.update({ status: 'issued', message: null });
    return { status: 'issued', sale_id: saleId };
  } catch (error) {
    logger.error(`[recurring-invoices] contrato ${contract.id} período ${period}: ${error.message}`);
    return fail(error.message);
  }
}

/**
 * Emite los períodos vencidos (hasta `today`) de los contratos activos. Si un
 * período falla, el contrato no avanza: se reintenta en la siguiente corrida
 * (el error queda en el contrato y en su historial).
 */
async function runDue(tenantId, { today = colombiaToday(), contractId = null, userId = null } = {}) {
  const { RecurringInvoice } = require('../../models');
  const { Op } = require('sequelize');
  const where = { tenant_id: tenantId, status: 'active', next_run_date: { [Op.lte]: today } };
  if (contractId) where.id = contractId;
  const contracts = await RecurringInvoice.findAll({ where, order: [['next_run_date', 'ASC']] });
  const results = [];
  for (const contract of contracts) {
    for (let i = 0; i < MAX_CATCH_UP && contract.status === 'active' && contract.next_run_date && ymd(contract.next_run_date) <= today; i++) {
      const period = ymd(contract.next_run_date);
      const r = await issuePeriod(tenantId, contract, period, userId);
      results.push({ contract_id: contract.id, name: contract.name, period, ...r });
      if (r.status === 'failed') {
        await contract.update({ last_error: r.message, last_run_at: new Date() });
        break;
      }
      const count = contract.invoices_count + (r.status === 'issued' ? 1 : 0);
      const next = addMonths(period, contract.frequency_months, contract.billing_day);
      const over = isOver(contract, next, count);
      await contract.update({
        invoices_count: count,
        next_run_date: over ? null : next,
        status: over ? 'finished' : 'active',
        last_run_at: new Date(),
        last_error: null,
      });
    }
  }
  return results;
}

/** Job diario: todas las empresas. */
async function runAllTenants() {
  const { Tenant } = require('../../models');
  const { runWithTenantSchema } = require('../../config/tenantContext');
  const tenants = await Tenant.findAll({ where: { is_active: true }, attributes: ['id', 'schema_name'] });
  const all = [];
  for (const tenant of tenants) {
    try {
      all.push(...await runWithTenantSchema(tenant.schema_name || null, () => runDue(tenant.id)));
    } catch (error) {
      logger.warn(`[recurring-invoices] tenant ${tenant.id}: ${error.message}`);
    }
  }
  return all;
}

module.exports = { runDue, runAllTenants, issuePeriod, firstRunDate, addMonths, isOver, periodLabel, FREQUENCIES, colombiaToday };
