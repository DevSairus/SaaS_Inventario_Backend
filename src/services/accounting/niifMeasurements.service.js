// backend/src/services/accounting/niifMeasurements.service.js
//
// Mediciones NIIF para Pymes que se hacen al cierre (mensual o anual):
//
//   - receivable_impairment  Deterioro de cartera (sección 11.21-26). Sobre la
//     cartera abierta por antigüedad (mismo FIFO del informe de antigüedad)
//     se aplica una matriz de % por tramo de días, con excepciones por
//     cliente. Es el modelo de pérdida incurrida de Pymes, no la pérdida
//     esperada de la NIIF 9.
//   - inventory_nrv  Valor neto realizable de inventarios (secciones 13.19
//     y 27.2-4): si el costo promedio supera el precio de venta neto de IVA
//     menos los gastos estimados de venta, la diferencia es deterioro.
//   - fx_remeasurement  Diferencia en cambio (sección 30.9-10): las partidas
//     monetarias en moneda extranjera se llevan a la tasa de cierre.
//
// Deterioro y VNR funcionan como cuenta correctora: se calcula el saldo que
// DEBE tener la provisión al corte y se contabiliza solo la diferencia con
// el saldo que ya tiene (gasto si sube, recuperación si baja). Por eso se
// puede correr las veces que sea: una segunda corrida al mismo corte da
// ajuste cero. La diferencia en cambio también ajusta contra el saldo en
// libros de cada partida.
//
// preview() no escribe nada; apply() recalcula (no confía en los números
// del cliente salvo parámetros y excepciones), crea el asiento ya
// contabilizado y guarda la corrida en niif_measurements.

const axios = require('axios');
const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const logger = require('../../config/logger');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const KINDS = {
  receivable_impairment: {
    label: 'Deterioro de cartera', sourceType: 'niif_receivable_impairment',
    allowance: 'receivable_impairment_allowance', expense: 'receivable_impairment_expense', recovery: 'receivable_impairment_recovery',
  },
  inventory_nrv: {
    label: 'Deterioro de inventarios (valor neto realizable)', sourceType: 'niif_inventory_nrv',
    allowance: 'inventory_nrv_allowance', expense: 'inventory_nrv_expense', recovery: 'inventory_nrv_recovery',
  },
  fx_remeasurement: { label: 'Diferencia en cambio', sourceType: 'niif_fx_remeasurement' },
  deferred_tax: { label: 'Impuesto diferido', sourceType: 'niif_deferred_tax' },
};

// Matriz por defecto (días desde la factura). La política es de cada
// empresa: el contador la ajusta y Pitbox recuerda la última usada.
const DEFAULT_MATRIX = [
  { from_days: 0, pct: 0 },
  { from_days: 91, pct: 25 },
  { from_days: 181, pct: 50 },
  { from_days: 361, pct: 100 },
];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function schemaName() {
  return getCurrentSchema() || 'public';
}

function checkCutoff(cutoff) {
  if (!cutoff || !DATE_RE.test(String(cutoff))) throw badRequest('La fecha de corte es obligatoria (YYYY-MM-DD)');
  return String(cutoff);
}

async function mappedAccount(tenantId, eventType) {
  const [row] = await sequelize.query(
    `SELECT a.id, a.code, a.name FROM "${schemaName()}"."account_mappings" m
     JOIN "${schemaName()}"."chart_of_accounts" a ON a.id = m.account_id
     WHERE m.tenant_id = :tenantId AND m.event_type = :eventType LIMIT 1`,
    { replacements: { tenantId, eventType }, type: QueryTypes.SELECT }
  );
  return row || null;
}

async function requireMappings(tenantId, events) {
  const out = {};
  const missing = [];
  for (const e of events) {
    const acc = await mappedAccount(tenantId, e);
    if (acc) out[e] = acc; else missing.push(e);
  }
  if (missing.length) {
    throw badRequest(`Falta configurar en Mapeo de Cuentas: ${missing.join(', ')}`);
  }
  return out;
}

/** Saldo (crédito - débito) de una cuenta al corte, opcionalmente de un tercero. */
async function creditBalance(tenantId, accountId, cutoff, thirdPartyId = null) {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS bal
     FROM "${schemaName()}"."journal_entry_lines" l
     JOIN "${schemaName()}"."journal_entries" e ON e.id = l.entry_id
     WHERE e.tenant_id = :tenantId AND e.status = 'posted' AND l.account_id = :accountId
       AND e.entry_date <= :cutoff
       AND (:thirdPartyId::uuid IS NULL OR l.third_party_id = :thirdPartyId::uuid)`,
    { replacements: { tenantId, accountId, cutoff, thirdPartyId }, type: QueryTypes.SELECT }
  );
  return Number(row.bal);
}

async function lastParams(tenantId, kind) {
  const [row] = await sequelize.query(
    `SELECT params FROM "${schemaName()}"."niif_measurements"
     WHERE tenant_id = :tenantId AND kind = :kind AND status = 'posted'
     ORDER BY cutoff_date DESC, created_at DESC LIMIT 1`,
    { replacements: { tenantId, kind }, type: QueryTypes.SELECT }
  );
  return row?.params || null;
}

/* ═══════════════════════════ Deterioro de cartera ═══════════════════════════ */

function normalizeMatrix(raw) {
  const rows = Array.isArray(raw) && raw.length ? raw : DEFAULT_MATRIX;
  const out = rows.map((r) => ({ from_days: Math.max(0, Math.floor(Number(r.from_days) || 0)), pct: Number(r.pct) }))
    .sort((a, b) => a.from_days - b.from_days);
  for (const r of out) {
    if (!Number.isFinite(r.pct) || r.pct < 0 || r.pct > 100) throw badRequest('Cada % de la matriz debe estar entre 0 y 100');
  }
  if (out[0].from_days !== 0) out.unshift({ from_days: 0, pct: 0 });
  // Sin tramos repetidos.
  return out.filter((r, i) => i === 0 || r.from_days !== out[i - 1].from_days);
}

function pctForDays(matrix, days) {
  let pct = 0;
  for (const r of matrix) if (days >= r.from_days) pct = r.pct;
  return pct;
}

// overrides: { [third_party_id]: pct } — p. ej. 100 para un cliente en
// liquidación, 0 para una entidad pública que paga tarde pero paga.
function normalizeOverrides(raw) {
  const out = {};
  for (const [id, v] of Object.entries(raw || {})) {
    if (!UUID_RE.test(id) || v === null || v === '' || v === undefined) continue;
    const pct = Number(v);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw badRequest('El % de una excepción por cliente debe estar entre 0 y 100');
    out[id] = pct;
  }
  return out;
}

async function computeReceivableImpairment(tenantId, cutoff, rawParams = {}) {
  const { fetchAging } = require('../../controllers/accounting/agingReport.controller');
  const matrix = normalizeMatrix(rawParams.matrix);
  const overrides = normalizeOverrides(rawParams.overrides);
  const accounts = await requireMappings(tenantId, ['receivable_impairment_allowance', 'receivable_impairment_expense', 'receivable_impairment_recovery']);

  const aging = await fetchAging({ tenant_id: tenantId, query: { type: 'customer', as_of: cutoff } });
  if (aging.warning) throw badRequest(aging.warning);

  const detail = aging.third_parties.map((tp) => {
    const override = overrides[tp.third_party_id];
    let required = 0;
    const lines = tp.detail.map((c) => {
      const pct = override !== undefined ? override : pctForDays(matrix, c.days_open);
      const amount = round2(c.amount * pct / 100);
      required += amount;
      return { date: c.date, entry_number: c.entry_number, days_open: c.days_open, balance: round2(c.amount), pct, impairment: amount };
    });
    return {
      third_party_id: tp.third_party_id, name: tp.name, tax_id: tp.tax_id,
      balance: round2(tp.total), override: override !== undefined ? override : null,
      oldest_days: Math.max(...tp.detail.map((c) => c.days_open)),
      required: round2(required), documents: lines,
    };
  }).sort((a, b) => b.required - a.required || b.balance - a.balance);

  const required = round2(detail.reduce((s, d) => s + d.required, 0));
  const previous = round2(await creditBalance(tenantId, accounts.receivable_impairment_allowance.id, cutoff));
  return {
    kind: 'receivable_impairment', cutoff_date: cutoff,
    params: { matrix, overrides },
    accounts,
    summary: {
      receivables: round2(detail.reduce((s, d) => s + d.balance, 0)),
      required, previous, adjustment: round2(required - previous),
    },
    detail,
  };
}

/* ═══════════════════════════ Valor neto realizable ═══════════════════════════ */

function normalizeNrvParams(raw = {}) {
  const sellingCostPct = raw.selling_cost_pct === undefined || raw.selling_cost_pct === '' ? 0 : Number(raw.selling_cost_pct);
  if (!Number.isFinite(sellingCostPct) || sellingCostPct < 0 || sellingCostPct >= 100) {
    throw badRequest('El % de gastos de venta debe estar entre 0 y 99');
  }
  // overrides: { [product_id]: VNR unitario fijado a mano (precio esperado de liquidación) }
  const overrides = {};
  for (const [id, v] of Object.entries(raw.overrides || {})) {
    if (!UUID_RE.test(id) || v === null || v === '' || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw badRequest('El valor neto realizable fijado debe ser un número mayor o igual a 0');
    overrides[id] = n;
  }
  return { selling_cost_pct: sellingCostPct, overrides };
}

/**
 * Existencias y costo promedio de cada producto a una fecha de corte, desde
 * el kardex:
 *   - cantidad = existencia actual − lo que entró/salió DESPUÉS del corte
 *     (no depende del orden en que se digitaron los movimientos, así que
 *     sirve aunque haya movimientos con fecha atrasada);
 *   - costo = promedio ponderado recorriendo el kardex en orden de fecha
 *     hasta el corte (misma regla que el recálculo de kardex).
 * La cantidad cuenta TODOS los movimientos posteriores, traslados incluidos:
 * la existencia actual los refleja (un traslado recibido incompleto la baja).
 * Si el corte es hoy o futuro, devuelve las existencias y el costo actuales.
 *
 * @returns {Map<productId, { qty, avg }>}
 */
async function stockAndCostAt(tenantId, cutoff, products) {
  const out = new Map();
  const { localDateStr } = require('../../utils/tenantTime');
  if (cutoff >= localDateStr(new Date())) {
    for (const p of products) out.set(p.id, { qty: Number(p.current_stock), avg: Number(p.average_cost || 0) });
    return out;
  }
  const { recomputeKardex } = require('../inventory/kardexRecalc.service');
  const after = await sequelize.query(
    `SELECT product_id,
            COALESCE(SUM(CASE WHEN direction = 'in' THEN quantity WHEN direction = 'out' THEN -quantity ELSE 0 END), 0) AS net
     FROM "${schemaName()}"."inventory_movements"
     WHERE tenant_id = :tenantId AND movement_date::date > :cutoff
     GROUP BY product_id`,
    { replacements: { tenantId, cutoff }, type: QueryTypes.SELECT }
  );
  const netAfter = new Map(after.map((r) => [r.product_id, Number(r.net)]));

  const qtyAt = new Map();
  for (const p of products) {
    const qty = round2(Number(p.current_stock || 0) - (netAfter.get(p.id) || 0));
    if (qty > 0.0001) qtyAt.set(p.id, qty);
  }
  if (!qtyAt.size) return out;

  // Kardex hasta el corte de los productos con existencias, en orden de fecha.
  const movements = await sequelize.query(
    `SELECT id, product_id, movement_type, movement_reason, direction, quantity, unit_cost, previous_stock
     FROM "${schemaName()}"."inventory_movements"
     WHERE tenant_id = :tenantId AND product_id IN (:ids) AND movement_date::date <= :cutoff
     ORDER BY product_id, movement_date, created_at, id`,
    { replacements: { tenantId, ids: [...qtyAt.keys()], cutoff }, type: QueryTypes.SELECT }
  );
  const byProduct = new Map();
  for (const m of movements) {
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
    byProduct.get(m.product_id).push(m);
  }
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const [id, qty] of qtyAt.entries()) {
    const list = byProduct.get(id) || [];
    const product = productById.get(id);
    if (!list.length) {
      // Existencias anteriores al primer movimiento registrado: costo actual.
      out.set(id, { qty, avg: Number(product?.average_cost || 0) });
      continue;
    }
    // Lo que había antes del primer movimiento entra al costo de ese movimiento.
    const openingQty = Math.max(0, Number(list[0].previous_stock) || 0);
    const { finalAvg } = recomputeKardex(list, { qty: openingQty, avg: Number(list[0].unit_cost) || Number(product?.average_cost || 0) });
    out.set(id, { qty, avg: finalAvg > 0 ? finalAvg : Number(product?.average_cost || 0) });
  }
  return out;
}

async function computeInventoryNrv(tenantId, cutoff, rawParams = {}) {
  const params = normalizeNrvParams(rawParams);
  const accounts = await requireMappings(tenantId, ['inventory_nrv_allowance', 'inventory_nrv_expense', 'inventory_nrv_recovery']);

  // Productos con existencias hoy o con movimientos después del corte (los
  // que se agotaron después del corte también tenían existencias ese día).
  // El precio es el actual: Pitbox no guarda historial de precios.
  const products = await sequelize.query(
    `SELECT p.id, p.sku, p.name, p.current_stock, p.average_cost, p.sale_price, p.price_includes_tax, p.has_tax, p.tax_percentage
     FROM "${schemaName()}"."products" p
     WHERE p.tenant_id = :tenantId AND p.is_active = true
       AND p.product_type NOT IN ('service', 'bundle')
       AND (p.current_stock > 0 OR EXISTS (
         SELECT 1 FROM "${schemaName()}"."inventory_movements" m
         WHERE m.product_id = p.id AND m.tenant_id = :tenantId AND m.movement_date::date > :cutoff))`,
    { replacements: { tenantId, cutoff }, type: QueryTypes.SELECT }
  );
  const atCutoff = await stockAndCostAt(tenantId, cutoff, products);

  const detail = [];
  const noPrice = [];
  let inventoryCost = 0;
  for (const p of products) {
    const at = atCutoff.get(p.id);
    if (!at || at.qty <= 0) continue;
    const qty = at.qty;
    const cost = at.avg;
    inventoryCost += qty * cost;
    if (cost <= 0) continue;
    const override = params.overrides[p.id];
    let nrvUnit;
    if (override !== undefined) {
      nrvUnit = override;
    } else {
      const price = Number(p.sale_price || 0);
      if (price <= 0) { noPrice.push({ id: p.id, sku: p.sku, name: p.name, quantity: qty, cost }); continue; }
      const taxPct = p.has_tax ? Number(p.tax_percentage || 0) : 0;
      const netPrice = p.price_includes_tax ? price / (1 + taxPct / 100) : price;
      nrvUnit = netPrice * (1 - params.selling_cost_pct / 100);
    }
    const unitImpairment = Math.max(0, cost - nrvUnit);
    if (unitImpairment <= 0.005 && override === undefined) continue;
    detail.push({
      product_id: p.id, sku: p.sku, name: p.name, quantity: qty,
      unit_cost: round2(cost), nrv_unit: round2(nrvUnit), override: override !== undefined ? override : null,
      cost_total: round2(qty * cost), nrv_total: round2(qty * nrvUnit),
      required: round2(qty * unitImpairment),
    });
  }
  detail.sort((a, b) => b.required - a.required);

  const required = round2(detail.reduce((s, d) => s + d.required, 0));
  const previous = round2(await creditBalance(tenantId, accounts.inventory_nrv_allowance.id, cutoff));
  return {
    kind: 'inventory_nrv', cutoff_date: cutoff, params, accounts,
    summary: { inventory_cost: round2(inventoryCost), required, previous, adjustment: round2(required - previous), products_without_price: noPrice.length },
    detail,
    // Los de mayor costo primero: son los que pesan si no se pueden vender.
    products_without_price: noPrice.sort((a, b) => b.quantity * b.cost - a.quantity * a.cost).slice(0, 200),
  };
}

/* ═══════════════════════════ Diferencia en cambio ═══════════════════════════ */

// items: [{ account_id, third_party_id?, currency, foreign_amount, rate, label? }]
// Cuentas bancarias en moneda extranjera se proponen solas en el preview;
// el usuario pone el saldo en la moneda y la TRM del corte.
async function computeFx(tenantId, cutoff, rawParams = {}) {
  const accounts = await requireMappings(tenantId, ['fx_gain', 'fx_loss']);
  const rawItems = Array.isArray(rawParams.items) ? rawParams.items : [];
  const defaultRate = rawParams.rate === undefined || rawParams.rate === '' ? null : Number(rawParams.rate);

  const banks = await sequelize.query(
    `SELECT b.id, b.bank_name, b.account_number, b.account_alias, b.currency, b.chart_of_account_id,
            a.code, a.name AS account_name, a.account_type
     FROM "${schemaName()}"."bank_accounts" b
     JOIN "${schemaName()}"."chart_of_accounts" a ON a.id = b.chart_of_account_id
     WHERE b.tenant_id = :tenantId AND b.is_active = true AND b.currency <> 'COP'
     ORDER BY b.bank_name`,
    { replacements: { tenantId }, type: QueryTypes.SELECT }
  );

  const accIds = [...new Set(rawItems.map((i) => i.account_id).filter((id) => UUID_RE.test(String(id || ''))))];
  const chart = accIds.length ? await sequelize.query(
    `SELECT id, code, name, account_type FROM "${schemaName()}"."chart_of_accounts" WHERE tenant_id = :tenantId AND id IN (:ids)`,
    { replacements: { tenantId, ids: accIds }, type: QueryTypes.SELECT }
  ) : [];
  const chartById = new Map(chart.map((a) => [a.id, a]));

  // Partidas: las bancarias (siempre) + las libres que mandó el usuario.
  const itemKey = (accountId, tp) => `${accountId}|${tp || ''}`;
  const sent = new Map(rawItems.map((i) => [itemKey(i.account_id, i.third_party_id), i]));
  const items = [];
  for (const b of banks) {
    const s = sent.get(itemKey(b.chart_of_account_id, null)) || {};
    items.push({
      source: 'bank', account_id: b.chart_of_account_id, third_party_id: null,
      code: b.code, account_name: b.account_name, account_type: b.account_type,
      label: `${b.bank_name} ${b.account_alias || b.account_number}`,
      currency: b.currency, foreign_amount: s.foreign_amount, rate: s.rate,
    });
    sent.delete(itemKey(b.chart_of_account_id, null));
  }
  for (const i of sent.values()) {
    const acc = chartById.get(i.account_id);
    if (!acc) continue;
    if (!['activo', 'pasivo'].includes(acc.account_type)) throw badRequest(`La cuenta ${acc.code} no es de activo ni de pasivo`);
    if (i.third_party_id && !UUID_RE.test(String(i.third_party_id))) throw badRequest('Tercero inválido');
    items.push({
      source: 'manual', account_id: acc.id, third_party_id: i.third_party_id || null,
      code: acc.code, account_name: acc.name, account_type: acc.account_type,
      label: i.label ? String(i.label).slice(0, 120) : acc.name,
      currency: String(i.currency || 'USD').toUpperCase().slice(0, 3), foreign_amount: i.foreign_amount, rate: i.rate,
    });
  }

  const detail = [];
  for (const it of items) {
    const credit = await creditBalance(tenantId, it.account_id, cutoff, it.third_party_id);
    const book = round2(it.account_type === 'activo' ? -credit : credit); // saldo natural en COP
    const hasAmount = it.foreign_amount !== undefined && it.foreign_amount !== null && it.foreign_amount !== '';
    const rate = it.rate !== undefined && it.rate !== null && it.rate !== '' ? Number(it.rate) : defaultRate;
    const row = { ...it, book_balance: book, foreign_amount: hasAmount ? Number(it.foreign_amount) : null, rate: Number.isFinite(rate) ? rate : null };
    if (hasAmount && (!Number.isFinite(row.foreign_amount) || row.foreign_amount < 0)) throw badRequest(`Saldo en moneda extranjera inválido en ${it.label}`);
    if (hasAmount && row.rate !== null && row.rate > 0) {
      row.remeasured = round2(row.foreign_amount * row.rate);
      const delta = round2(row.remeasured - book); // variación del saldo natural
      // Activo que sube o pasivo que baja = ganancia.
      row.difference = it.account_type === 'activo' ? delta : -delta;
    } else {
      row.remeasured = null;
      row.difference = null;
    }
    detail.push(row);
  }

  const ready = detail.filter((d) => d.difference !== null);
  const gains = round2(ready.filter((d) => d.difference > 0).reduce((s, d) => s + d.difference, 0));
  const losses = round2(ready.filter((d) => d.difference < 0).reduce((s, d) => s - d.difference, 0));
  return {
    kind: 'fx_remeasurement', cutoff_date: cutoff,
    params: {
      rate: defaultRate,
      items: detail.filter((d) => d.foreign_amount !== null).map((d) => ({
        account_id: d.account_id, third_party_id: d.third_party_id, currency: d.currency,
        foreign_amount: d.foreign_amount, rate: d.rate, label: d.label,
      })),
    },
    accounts,
    summary: { gains, losses, adjustment: round2(gains - losses), items_pending: detail.length - ready.length },
    detail,
  };
}

/* ═══════════════════════════ Impuesto diferido ═══════════════════════════ */

// Diferencias temporarias de la conciliación fiscal × tarifa
// (fiscalReconciliation.service.js). Los parámetros (tarifa, pérdidas,
// reconocimiento) son los de la conciliación del año del corte.
async function computeDeferredTax(tenantId, cutoff) {
  const { deferredTax } = require('./fiscalReconciliation.service');
  const accounts = await requireMappings(tenantId, ['deferred_tax_asset', 'deferred_tax_liability', 'deferred_tax_expense']);
  const dt = await deferredTax(tenantId, cutoff);
  const dtaBook = round2(-(await creditBalance(tenantId, accounts.deferred_tax_asset.id, cutoff)));
  const dtlBook = round2(await creditBalance(tenantId, accounts.deferred_tax_liability.id, cutoff));
  const required = round2(dt.dta - dt.dtl);
  const previous = round2(dtaBook - dtlBook);
  return {
    kind: 'deferred_tax', cutoff_date: cutoff,
    params: dt.settings,
    accounts,
    summary: {
      dta_gross: dt.dta_gross, dta_required: dt.dta, dtl_required: dt.dtl, dta_book: dtaBook, dtl_book: dtlBook,
      required, previous, adjustment: round2(required - previous),
      // Gasto (+) o ingreso (−) por impuesto diferido del ajuste.
      expense: round2(previous - required),
    },
    detail: dt.items,
  };
}

function deferredTaxLines(result) {
  const { summary: s, accounts: acc, cutoff_date: d } = result;
  const lines = [];
  const dA = round2(s.dta_required - s.dta_book);
  const dL = round2(s.dtl_required - s.dtl_book);
  if (Math.abs(dA) >= 0.01) lines.push({ account_id: acc.deferred_tax_asset.id, debit: dA > 0 ? dA : 0, credit: dA < 0 ? -dA : 0, description: `Activo por impuesto diferido al ${d}` });
  if (Math.abs(dL) >= 0.01) lines.push({ account_id: acc.deferred_tax_liability.id, debit: dL < 0 ? -dL : 0, credit: dL > 0 ? dL : 0, description: `Pasivo por impuesto diferido al ${d}` });
  const exp = round2(dL - dA);
  if (Math.abs(exp) >= 0.01) lines.push({ account_id: acc.deferred_tax_expense.id, debit: exp > 0 ? exp : 0, credit: exp < 0 ? -exp : 0, description: exp > 0 ? `Gasto por impuesto diferido al ${d}` : `Ingreso por impuesto diferido al ${d}` });
  return lines;
}

/* ═════════════════════════════ Orquestación ═════════════════════════════ */

const COMPUTE = {
  receivable_impairment: computeReceivableImpairment,
  inventory_nrv: computeInventoryNrv,
  fx_remeasurement: computeFx,
  deferred_tax: computeDeferredTax,
};

function checkKind(kind) {
  if (!COMPUTE[kind]) throw badRequest('Tipo de medición desconocido');
  return kind;
}

async function preview(tenantId, kind, { cutoff_date, params } = {}) {
  checkKind(kind);
  const cutoff = checkCutoff(cutoff_date);
  const base = kind === 'deferred_tax' ? {} : (params && Object.keys(params).length ? params : (await lastParams(tenantId, kind)) || {});
  const result = await COMPUTE[kind](tenantId, cutoff, base);
  return { ...result, label: KINDS[kind].label };
}

function allowanceLines(result, kindDef) {
  const { adjustment } = result.summary;
  const acc = result.accounts;
  const amount = Math.abs(adjustment);
  const what = kindDef.label.toLowerCase();
  if (adjustment > 0) {
    return [
      { account_id: acc[kindDef.expense].id, debit: amount, credit: 0, description: `Gasto por ${what} al ${result.cutoff_date}` },
      { account_id: acc[kindDef.allowance].id, debit: 0, credit: amount, description: `Aumento de la provisión por ${what}` },
    ];
  }
  return [
    { account_id: acc[kindDef.allowance].id, debit: amount, credit: 0, description: `Disminución de la provisión por ${what}` },
    { account_id: acc[kindDef.recovery].id, debit: 0, credit: amount, description: `Recuperación de ${what} al ${result.cutoff_date}` },
  ];
}

function fxLines(result) {
  const lines = [];
  for (const d of result.detail) {
    if (d.difference === null || Math.abs(d.difference) < 0.005) continue;
    const amt = Math.abs(d.difference);
    const gain = d.difference > 0;
    const desc = `Diferencia en cambio ${d.label}: ${d.foreign_amount} ${d.currency} a ${d.rate}`;
    // Ganancia = activo que sube o pasivo que baja: ambos son débito a la
    // partida. Pérdida (activo que baja o pasivo que sube): crédito.
    const itemDebit = gain;
    lines.push({ account_id: d.account_id, third_party_id: d.third_party_id, debit: itemDebit ? amt : 0, credit: itemDebit ? 0 : amt, description: desc });
  }
  if (result.summary.gains > 0) lines.push({ account_id: result.accounts.fx_gain.id, debit: 0, credit: result.summary.gains, description: `Ingreso por diferencia en cambio al ${result.cutoff_date}` });
  if (result.summary.losses > 0) lines.push({ account_id: result.accounts.fx_loss.id, debit: result.summary.losses, credit: 0, description: `Gasto por diferencia en cambio al ${result.cutoff_date}` });
  return lines;
}

async function apply(tenantId, kind, { cutoff_date, params } = {}, userId) {
  checkKind(kind);
  const cutoff = checkCutoff(cutoff_date);
  const result = await COMPUTE[kind](tenantId, cutoff, params || {});
  const kindDef = KINDS[kind];

  let noChange;
  if (kind === 'fx_remeasurement') noChange = result.summary.gains === 0 && result.summary.losses === 0;
  // Activo y pasivo diferidos pueden moverse igual (neto cero) y aun así hay asiento.
  else if (kind === 'deferred_tax') noChange = deferredTaxLines(result).length < 2;
  else noChange = Math.abs(result.summary.adjustment) < 0.01;
  if (noChange) throw badRequest('No hay ajuste por contabilizar: la provisión o el saldo ya están al valor calculado.');

  const { createDraftEntry } = require('./journalEntry.service');
  const lines = kind === 'fx_remeasurement' ? fxLines(result) : kind === 'deferred_tax' ? deferredTaxLines(result) : allowanceLines(result, kindDef);

  const t = await sequelize.transaction();
  try {
    const entry = await createDraftEntry(tenantId, {
      entryDate: cutoff,
      sourceType: kindDef.sourceType,
      description: `${kindDef.label} — medición NIIF al ${cutoff}`,
      lines,
      createdBy: userId,
    }, t);
    await entry.update({ status: 'posted', posted_by: userId || null, posted_at: new Date() }, { transaction: t });

    const required = kind === 'fx_remeasurement' ? result.summary.gains : result.summary.required;
    const previous = kind === 'fx_remeasurement' ? result.summary.losses : result.summary.previous;
    const [[row]] = await sequelize.query(
      `INSERT INTO "${schemaName()}"."niif_measurements"
         (tenant_id, kind, cutoff_date, params, detail, required_amount, previous_amount, adjustment, journal_entry_id, created_by)
       VALUES (:tenantId, :kind, :cutoff, :params::jsonb, :detail::jsonb, :required, :previous, :adjustment, :entryId, :userId)
       RETURNING id`,
      {
        replacements: {
          tenantId, kind, cutoff, params: JSON.stringify(result.params), detail: JSON.stringify(result.detail),
          required, previous, adjustment: result.summary.adjustment, entryId: entry.id, userId: userId || null,
        },
        transaction: t,
      }
    );
    await entry.update({ source_id: row.id }, { transaction: t });
    await t.commit();
    return { id: row.id, entry_id: entry.id, entry_number: entry.entry_number, summary: result.summary };
  } catch (error) {
    await t.rollback();
    if (/período .* está cerrado/i.test(error.message)) throw badRequest(error.message);
    throw error;
  }
}

async function history(tenantId, kind) {
  return sequelize.query(
    `SELECT m.id, m.kind, m.cutoff_date, m.required_amount, m.previous_amount, m.adjustment, m.status,
            m.created_at, m.reversed_at, e.entry_number, e.id AS entry_id,
            TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS created_by_name
     FROM "${schemaName()}"."niif_measurements" m
     LEFT JOIN "${schemaName()}"."journal_entries" e ON e.id = m.journal_entry_id
     LEFT JOIN "public"."users" u ON u.id = m.created_by
     WHERE m.tenant_id = :tenantId AND (:kind::text IS NULL OR m.kind = :kind)
     ORDER BY m.cutoff_date DESC, m.created_at DESC LIMIT 100`,
    { replacements: { tenantId, kind: kind || null }, type: QueryTypes.SELECT }
  );
}

// Reversa una corrida: asiento con débitos/créditos invertidos FECHADO EN EL
// MISMO CORTE (reverseEntry fecha hoy, y entonces la provisión del corte
// original seguiría incluyendo el ajuste). Si ese periodo está cerrado, hay
// que reabrirlo: no se reescribe un periodo cerrado.
async function reverse(tenantId, id, userId, reason) {
  if (!UUID_RE.test(String(id))) throw badRequest('Medición inválida');
  const { JournalEntry, JournalEntryLine } = require('../../models');
  const { createDraftEntry } = require('./journalEntry.service');
  const t = await sequelize.transaction();
  try {
    const [[m]] = await sequelize.query(
      `SELECT id, kind, status, journal_entry_id FROM "${schemaName()}"."niif_measurements" WHERE tenant_id = :tenantId AND id = :id FOR UPDATE`,
      { replacements: { tenantId, id }, transaction: t }
    );
    if (!m) { const e = new Error('Medición no encontrada'); e.statusCode = 404; throw e; }
    if (m.status !== 'posted') throw badRequest('Esta medición ya fue reversada');

    const original = m.journal_entry_id ? await JournalEntry.findOne({
      where: { id: m.journal_entry_id, tenant_id: tenantId },
      include: [{ model: JournalEntryLine, as: 'lines' }],
      transaction: t,
    }) : null;
    if (original && original.status === 'posted' && !original.reversed_by_entry_id) {
      const reversal = await createDraftEntry(tenantId, {
        entryDate: original.entry_date,
        sourceType: original.source_type,
        sourceId: m.id,
        description: `Reversión de ${original.entry_number} — ${reason || 'medición NIIF reversada'}`,
        lines: original.lines.map((l) => ({
          account_id: l.account_id, debit: Number(l.credit || 0), credit: Number(l.debit || 0),
          third_party_id: l.third_party_id || null, description: `Reversión — ${l.description || ''}`.trim(),
        })),
        createdBy: userId,
      }, t);
      await reversal.update({ status: 'posted', posted_by: userId || null, posted_at: new Date(), reversal_of_entry_id: original.id }, { transaction: t });
      await original.update({ reversed_by_entry_id: reversal.id }, { transaction: t });
    }
    await sequelize.query(
      `UPDATE "${schemaName()}"."niif_measurements" SET status = 'reversed', reversed_at = NOW(), reversed_by = :userId, updated_at = NOW() WHERE id = :id`,
      { replacements: { id, userId: userId || null }, transaction: t }
    );
    await t.commit();
  } catch (error) {
    await t.rollback();
    if (/período .* está cerrado/i.test(error.message)) throw badRequest(`${error.message}. Reábrelo para reversar esta medición.`);
    throw error;
  }
}

/**
 * TRM oficial (Superfinanciera, datos abiertos) vigente en una fecha. Solo
 * USD. Si el servicio no responde, el usuario la escribe a mano.
 */
async function officialTrm(date) {
  const d = checkCutoff(date);
  try {
    const { data } = await axios.get('https://www.datos.gov.co/resource/32sa-8pi3.json', {
      params: { $where: `vigenciadesde <= '${d}T00:00:00.000' AND vigenciahasta >= '${d}T00:00:00.000'`, $limit: 1 },
      timeout: 6000,
    });
    const v = Number(data?.[0]?.valor);
    if (!Number.isFinite(v) || v <= 0) return null;
    return { rate: v, from: data[0].vigenciadesde?.slice(0, 10), to: data[0].vigenciahasta?.slice(0, 10) };
  } catch (error) {
    logger.warn(`[NIIF] No se pudo consultar la TRM (${d}): ${error.message}`);
    return null;
  }
}

module.exports = {
  preview, apply, history, reverse, officialTrm,
  // para pruebas
  normalizeMatrix, pctForDays, DEFAULT_MATRIX, KINDS, allowanceLines, fxLines, deferredTaxLines, stockAndCostAt,
};
