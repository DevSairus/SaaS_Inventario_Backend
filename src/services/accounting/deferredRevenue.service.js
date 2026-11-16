// backend/src/services/accounting/deferredRevenue.service.js
//
// Cuenta de ingreso por producto e ingresos diferidos (anualidades,
// semestralidades de software, contratos pagados por anticipado).
//
// Cada producto puede tener:
//   - revenue_account_id: su cuenta de ingreso (si no, el mapeo
//     sale_revenue_product / sale_revenue_service de siempre).
//   - deferred_months + deferred_account_id: el cobro es un ingreso recibido
//     por anticipado. La venta acredita la cuenta de pasivo (27...) y se crea
//     un diferido que se amortiza al cierre de cada mes, desde el mes de la
//     factura: débito pasivo / crédito cuenta de ingreso.
//
// Los asientos (venta, nota crédito, nota débito, devolución) siguen calculando
// el ingreso como siempre (descuento global, AIU); splitRevenue solo reparte
// ese valor entre las cuentas de los productos, en proporción a sus líneas.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { createDraftEntry, getMappedAccountId } = require('./journalEntry.service');
const logger = require('../../config/logger');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DEFAULT_EVENT = { product: 'sale_revenue_product', service: 'sale_revenue_service' };
const kindOf = (item) => ((item.item_type || 'product') === 'product' ? 'product' : 'service');

/** Configuración contable de los productos de las líneas: Map(product_id -> {...}). */
async function productTargets(tenantId, items, transaction) {
  const { Product } = require('../../models');
  const ids = [...new Set((items || []).map((i) => i.product_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await Product.findAll({
    where: { id: { [Op.in]: ids }, tenant_id: tenantId },
    attributes: ['id', 'name', 'revenue_account_id', 'deferred_months', 'deferred_account_id'],
    transaction,
  });
  return new Map(rows.map((p) => [p.id, p]));
}

/**
 * Reparte el ingreso ya calculado de cada tipo entre las cuentas de sus líneas.
 * @param {{product: number, service: number}} totals ingreso por tipo (ya con descuento/AIU)
 * @returns {Promise<Array<{ kind, account_id, amount, deferred: null|{ liability_account_id, revenue_account_id, months }, names: string[] }>>}
 *   Para un diferido, account_id es la cuenta de pasivo.
 */
async function splitRevenue(tenantId, items, totals, transaction) {
  const targets = await productTargets(tenantId, items, transaction);
  const defaults = {};
  const defaultAccount = async (kind) => {
    if (!defaults[kind]) defaults[kind] = await getMappedAccountId(tenantId, DEFAULT_EVENT[kind], transaction);
    return defaults[kind];
  };

  const out = [];
  for (const kind of ['product', 'service']) {
    const total = round2(totals[kind]);
    if (total <= 0) continue;
    const kindItems = (items || []).filter((i) => kindOf(i) === kind && i.approval_status !== 'rechazado');
    const buckets = new Map();
    let weightSum = 0;
    for (const item of kindItems) {
      const w = Math.max(Number(item.subtotal || 0), 0);
      const p = targets.get(item.product_id);
      const deferred = p && Number(p.deferred_months) > 0 && p.deferred_account_id;
      const revenue = p?.revenue_account_id || null;
      const key = deferred ? `d:${p.deferred_account_id}:${revenue || ''}:${p.deferred_months}` : `r:${revenue || ''}`;
      if (!buckets.has(key)) buckets.set(key, { kind, weight: 0, revenue, deferred: deferred ? { liability_account_id: p.deferred_account_id, months: Number(p.deferred_months) } : null, names: [] });
      const b = buckets.get(key);
      b.weight += w;
      if (p?.name && !b.names.includes(p.name)) b.names.push(p.name);
      weightSum += w;
    }
    // Sin líneas con valor (p. ej. solo AIU): todo a la cuenta por defecto.
    if (weightSum <= 0) {
      out.push({ kind, account_id: await defaultAccount(kind), amount: total, deferred: null, names: [] });
      continue;
    }
    const list = [...buckets.values()];
    let assigned = 0;
    list.forEach((b, i) => {
      b.amount = i === list.length - 1 ? round2(total - assigned) : round2(total * b.weight / weightSum);
      assigned = round2(assigned + b.amount);
    });
    for (const b of list) {
      if (b.amount === 0) continue;
      const revenueAccount = b.revenue || await defaultAccount(kind);
      out.push(b.deferred
        ? { kind, account_id: b.deferred.liability_account_id, amount: b.amount, deferred: { ...b.deferred, revenue_account_id: revenueAccount }, names: b.names }
        : { kind, account_id: revenueAccount, amount: b.amount, deferred: null, names: b.names });
    }
  }
  return out;
}

const firstOfMonth = (d) => `${String(d).slice(0, 7)}-01`;
function colombiaToday() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Crea los diferidos de una venta (uno por cuenta de pasivo/ingreso/meses).
 * Idempotente: si la venta ya tiene diferidos no crea otros (p. ej. cuando el
 * asiento se vuelve a generar desde Salud Contable).
 */
async function createDeferrals(tenantId, sale, buckets, userId, transaction) {
  const { DeferredRevenue } = require('../../models');
  const deferred = buckets.filter((b) => b.deferred);
  if (!deferred.length) return [];
  const existing = await DeferredRevenue.count({ where: { tenant_id: tenantId, sale_id: sale.id }, transaction });
  if (existing) return [];
  const saleDate = String(sale.sale_date instanceof Date ? sale.sale_date.toISOString() : sale.sale_date || new Date().toISOString()).slice(0, 10);
  const rows = [];
  for (const b of deferred) {
    rows.push(await DeferredRevenue.create({
      tenant_id: tenantId,
      sale_id: sale.id,
      branch_id: sale.branch_id || null,
      customer_id: sale.customer_id || null,
      description: `${b.names.join(', ') || 'Ingreso diferido'} — ${sale.dian_invoice_number || sale.sale_number || ''}`.slice(0, 300),
      liability_account_id: b.deferred.liability_account_id,
      revenue_account_id: b.deferred.revenue_account_id,
      total_amount: b.amount,
      months: b.deferred.months,
      start_date: firstOfMonth(saleDate),
      created_by: userId || null,
    }, { transaction }));
  }
  return rows;
}

/**
 * Nota crédito o devolución sobre una venta con diferido: primero se reversa
 * lo que aún no se ha causado (débito al pasivo, el diferido baja), y solo el
 * resto, ya reconocido como ingreso, se debita a la cuenta de ingreso.
 * @returns {Promise<Array<{ account_id, amount, description }>>} líneas débito
 */
async function reverseDeferredBucket(tenantId, originalSaleId, bucket, transaction) {
  const { DeferredRevenue } = require('../../models');
  const lines = [];
  let pending = round2(bucket.amount);
  const deferrals = originalSaleId ? await DeferredRevenue.findAll({
    where: { tenant_id: tenantId, sale_id: originalSaleId, liability_account_id: bucket.deferred.liability_account_id, status: 'active' },
    order: [['created_at', 'ASC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  }) : [];
  for (const d of deferrals) {
    if (pending <= 0) break;
    const remaining = round2(Number(d.total_amount) - Number(d.amortized_amount));
    const take = Math.min(pending, remaining);
    if (take <= 0) continue;
    const newTotal = round2(Number(d.total_amount) - take);
    const done = round2(newTotal - Number(d.amortized_amount)) <= 0;
    await d.update({ total_amount: newTotal, status: done ? (Number(d.amortized_amount) > 0 ? 'finished' : 'cancelled') : 'active' }, { transaction });
    lines.push({ account_id: d.liability_account_id, amount: take, description: 'Reversión de ingreso diferido (aún no causado)' });
    pending = round2(pending - take);
  }
  if (pending > 0) lines.push({ account_id: bucket.deferred.revenue_account_id, amount: pending, description: 'Reversión de ingreso ya causado' });
  return lines;
}

/** Último día del mes k (1 = mes de inicio) de un diferido, YYYY-MM-DD. */
function monthEnd(startDate, k) {
  const [y, m] = String(startDate).slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + k, 0)).toISOString().slice(0, 10);
}

/**
 * Amortiza los meses cerrados de los diferidos activos: un asiento en borrador
 * por diferido y mes, fechado el ÚLTIMO día de ese mes (cierre mensual: el
 * mes de la factura se causa el último día de ese mes, no el día de la
 * factura). Una cuota se genera cuando `upTo` llega al fin de su mes; el job
 * diario corre a las 4:20 a. m., así que la del mes sale el último día. Se
 * pone al día solo (si el job no corrió algún día).
 */
async function amortizeDue(tenantId, { upTo = colombiaToday(), saleId = null, deferralId = null, userId = null } = {}) {
  const { DeferredRevenue } = require('../../models');
  const where = { tenant_id: tenantId, status: 'active' };
  if (saleId) where.sale_id = saleId;
  if (deferralId) where.id = deferralId;
  const deferrals = await DeferredRevenue.findAll({ where, order: [['start_date', 'ASC']] });
  const results = [];
  for (const d of deferrals) {
    let due = d.months_amortized;
    while (due < d.months && monthEnd(d.start_date, due + 1) <= String(upTo).slice(0, 10)) due += 1;
    let created = 0;
    while (d.months_amortized < due) {
      const k = d.months_amortized + 1;
      const remainingMonths = d.months - d.months_amortized;
      const remaining = round2(Number(d.total_amount) - Number(d.amortized_amount));
      const amount = remainingMonths === 1 ? remaining : round2(remaining / remainingMonths);
      const entryDate = monthEnd(d.start_date, k);
      const t = await sequelize.transaction();
      try {
        if (amount > 0) {
          await createDraftEntry(tenantId, {
            branchId: d.branch_id,
            entryDate,
            sourceType: 'deferred_revenue',
            sourceId: d.id,
            description: `Amortización ingreso diferido ${k}/${d.months} — ${d.description}`.slice(0, 500),
            lines: [
              { account_id: d.liability_account_id, debit: amount, credit: 0, description: `Causación mes ${k} de ${d.months}`, third_party_id: d.customer_id || null },
              { account_id: d.revenue_account_id, debit: 0, credit: amount, description: `Ingreso causado mes ${k} de ${d.months}` },
            ],
            createdBy: userId || d.created_by,
          }, t);
        }
        const amortized = round2(Number(d.amortized_amount) + amount);
        await d.update({
          months_amortized: k,
          amortized_amount: amortized,
          status: k >= d.months || round2(Number(d.total_amount) - amortized) <= 0 ? 'finished' : 'active',
          last_error: null,
        }, { transaction: t });
        await t.commit();
        created += 1;
        if (d.status === 'finished') break;
      } catch (error) {
        await t.rollback();
        await d.update({ last_error: error.message }).catch(() => {});
        logger.warn(`[deferred-revenue] ${d.id} mes ${k}: ${error.message}`);
        results.push({ id: d.id, error: error.message });
        break;
      }
    }
    if (created) results.push({ id: d.id, entries: created });
  }
  return results;
}

/** Job diario: amortiza lo vencido en todas las empresas. */
async function amortizeAllTenants() {
  const { Tenant } = require('../../models');
  const { runWithTenantSchema } = require('../../config/tenantContext');
  const tenants = await Tenant.findAll({ where: { is_active: true }, attributes: ['id', 'schema_name'] });
  const all = [];
  for (const tenant of tenants) {
    try {
      const r = await runWithTenantSchema(tenant.schema_name || null, () => amortizeDue(tenant.id));
      all.push(...r);
    } catch (error) {
      // Tablas aún sin migrar en un schema, etc.: no frena a los demás.
      logger.warn(`[deferred-revenue] tenant ${tenant.id}: ${error.message}`);
    }
  }
  return all;
}

module.exports = { splitRevenue, createDeferrals, reverseDeferredBucket, amortizeDue, amortizeAllTenants, colombiaToday };
