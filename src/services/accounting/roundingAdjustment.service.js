// backend/src/services/accounting/roundingAdjustment.service.js
//
// 5.1 — Ajuste al peso.
//
// Cuando un asiento automático (venta, compra, gasto...) queda descuadrado por
// 1 centavo o hasta 1 peso por redondeos de impuestos, en vez de aceptar el
// descuadre (antes: tolerancia de 0.01 y totales distintos) o rechazar el
// asiento, se agrega una línea de ajuste para que débitos y créditos queden
// iguales:
//   - a favor (los débitos superan a los créditos): crédito a 429581 Ajuste al peso
//   - en contra (los créditos superan a los débitos): débito a 529581 Ajuste al peso
//     (o 519581 si el contador lo lleva como gasto de administración: se cambia
//      el mapeo `rounding_adjustment_expense` en Mapeo de cuentas).
//
// Parametrización por empresa en tenants.tax_config.rounding_adjustment:
//   enabled     (default true)  — si es false, se conserva el comportamiento anterior
//   max_amount  (default 1)     — tope en pesos del descuadre que se ajusta solo
//   tolerance   (default 0.005) — por debajo de esto el descuadre es ruido numérico
//                                 y no genera línea
// Un descuadre mayor al tope NO se ajusta: sigue rechazándose (es un error real).
//
// Las líneas quedan marcadas (journal_entry_lines.is_rounding_adjustment) para la
// bitácora (listAdjustments) y para poder excluirlas de cualquier análisis.
'use strict';

const logger = require('../../config/logger');

const EVENT_INCOME = 'rounding_adjustment_income';   // 429581 — ajuste a favor
const EVENT_EXPENSE = 'rounding_adjustment_expense'; // 529581 — ajuste en contra
const ADJUSTMENT_LABEL = 'Ajuste al peso';

const DEFAULT_CONFIG = Object.freeze({ enabled: true, max_amount: 1, tolerance: 0.005 });
const MAX_ALLOWED_CAP = 1000; // ni el cliente puede abrir el tope más allá de un múltiplo de mil

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

/** Normaliza lo guardado por el cliente: valores inválidos vuelven al default. */
function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const max = Number(src.max_amount);
  const tol = Number(src.tolerance);
  const maxAmount = Number.isFinite(max) && max >= 0 ? Math.min(max, MAX_ALLOWED_CAP) : DEFAULT_CONFIG.max_amount;
  const tolerance = Number.isFinite(tol) && tol >= 0 ? Math.min(tol, maxAmount || DEFAULT_CONFIG.tolerance) : DEFAULT_CONFIG.tolerance;
  return {
    enabled: src.enabled === undefined ? DEFAULT_CONFIG.enabled : src.enabled === true || src.enabled === 'true',
    max_amount: round2(maxAmount),
    tolerance,
  };
}

async function getConfig(tenantId, transaction) {
  const { Tenant } = require('../../models');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'tax_config'], transaction });
  return normalizeConfig(tenant?.tax_config?.rounding_adjustment);
}

async function saveConfig(tenantId, input, transaction) {
  const { Tenant } = require('../../models');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'tax_config'], transaction });
  if (!tenant) throw new Error('Empresa no encontrada');

  const max = Number(input.max_amount);
  if (input.max_amount !== undefined && (!Number.isFinite(max) || max < 0 || max > MAX_ALLOWED_CAP)) {
    const err = new Error(`El tope debe estar entre 0 y ${MAX_ALLOWED_CAP} pesos`);
    err.statusCode = 400;
    throw err;
  }
  const current = normalizeConfig(tenant.tax_config?.rounding_adjustment);
  const next = normalizeConfig({ ...current, ...input });
  await tenant.update({ tax_config: { ...(tenant.tax_config || {}), rounding_adjustment: next } }, { transaction });
  return next;
}

/**
 * Pura: dado el descuadre decide si hay línea de ajuste.
 * @returns {null | { side: 'debit'|'credit', amount: number, kind: 'income'|'expense' }}
 */
function computeAdjustment(totalDebit, totalCredit, config = DEFAULT_CONFIG) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return null;
  const diff = round2(Number(totalDebit || 0) - Number(totalCredit || 0));
  const abs = Math.abs(diff);
  if (abs < cfg.tolerance || abs === 0) return null;
  if (abs > cfg.max_amount) return null;
  // Débitos de más → falta crédito: ingreso por ajuste (a favor).
  return diff > 0
    ? { side: 'credit', amount: abs, kind: 'income' }
    : { side: 'debit', amount: abs, kind: 'expense' };
}

async function accountFor(tenantId, kind, transaction) {
  const { getMappedAccountId } = require('./journalEntry.service');
  try {
    return await getMappedAccountId(tenantId, kind === 'income' ? EVENT_INCOME : EVENT_EXPENSE, transaction);
  } catch (e) {
    return null; // sin mapeo: se conserva el comportamiento anterior
  }
}

/** Línea de ajuste ya armada (o null si no hay mapeo de la cuenta). */
async function buildLine(tenantId, { side, amount, kind }, transaction, description = ADJUSTMENT_LABEL) {
  const accountId = await accountFor(tenantId, kind, transaction);
  if (!accountId) return null;
  return {
    account_id: accountId,
    debit: side === 'debit' ? amount : 0,
    credit: side === 'credit' ? amount : 0,
    description,
    is_rounding_adjustment: true,
  };
}

/**
 * Usada por createDraftEntry: si las líneas no cuadran por un monto dentro del
 * tope, devuelve las líneas con el ajuste agregado. Si no aplica, las devuelve igual.
 * Solo consulta la configuración cuando HAY descuadre (el caso normal no cuesta nada).
 */
async function balanceWithAdjustment(tenantId, lines, transaction) {
  const totalDebit = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) < 1e-9) return { lines, adjustment: null };

  const config = await getConfig(tenantId, transaction);
  const adjustment = computeAdjustment(totalDebit, totalCredit, config);
  if (!adjustment) return { lines, adjustment: null };

  const line = await buildLine(tenantId, adjustment, transaction);
  if (!line) return { lines, adjustment: null };

  logger.info(`[accounting] Ajuste al peso de ${adjustment.amount} (${adjustment.side === 'credit' ? 'a favor' : 'en contra'}) en asiento automático (tenant ${tenantId})`);
  return { lines: [...lines, line], adjustment: { ...adjustment, account_id: line.account_id } };
}

/**
 * Liquidación de impuestos (p. ej. ICA): el valor del formulario se aproxima al
 * múltiplo de mil y la diferencia va a la cuenta de ajuste al peso en vez de
 * quedar escondida en el gasto. `amount` es con signo: positivo = más gasto
 * (en contra), negativo = menos gasto (a favor). Sin tope: el redondeo del
 * formulario puede llegar a ±500 por renglón.
 * @returns {Promise<object|null>} línea, o null si no hay diferencia o falta el mapeo
 */
async function buildTaxRoundingLine(tenantId, amount, transaction, description = 'Ajuste al peso (aproximación al mil)') {
  const value = round2(amount);
  if (!value) return null;
  return buildLine(tenantId, value > 0
    ? { side: 'debit', amount: value, kind: 'expense' }
    : { side: 'credit', amount: Math.abs(value), kind: 'income' }, transaction, description);
}

/** Bitácora: asientos con línea de ajuste al peso en el rango. */
async function listAdjustments(tenantId, { dateFrom, dateTo, limit = 200, offset = 0 } = {}) {
  const { Op } = require('sequelize');
  const { JournalEntry, JournalEntryLine, ChartOfAccount } = require('../../models');

  const where = { tenant_id: tenantId, status: { [Op.ne]: 'voided' } };
  if (dateFrom || dateTo) {
    where.entry_date = {};
    if (dateFrom) where.entry_date[Op.gte] = dateFrom;
    if (dateTo) where.entry_date[Op.lte] = dateTo;
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const entries = await JournalEntry.findAll({
    where,
    include: [{ model: JournalEntryLine, as: 'lines', where: { is_rounding_adjustment: true }, required: true }],
    order: [['entry_date', 'DESC'], ['entry_number', 'DESC']],
    limit: safeLimit,
    offset: Math.max(parseInt(offset, 10) || 0, 0),
  });

  const accountIds = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.account_id)))];
  const accounts = accountIds.length
    ? await ChartOfAccount.findAll({ where: { id: accountIds }, attributes: ['id', 'code', 'name'] })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const rows = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);
      const account = byId.get(line.account_id);
      rows.push({
        entry_id: entry.id,
        entry_number: entry.entry_number,
        entry_date: entry.entry_date,
        source_type: entry.source_type,
        source_id: entry.source_id,
        status: entry.status,
        account_code: account?.code || null,
        account_name: account?.name || null,
        direction: credit > 0 ? 'a_favor' : 'en_contra',
        amount: credit > 0 ? credit : debit,
      });
    }
  }
  const totalFavor = round2(rows.filter((r) => r.direction === 'a_favor').reduce((s, r) => s + r.amount, 0));
  const totalContra = round2(rows.filter((r) => r.direction === 'en_contra').reduce((s, r) => s + r.amount, 0));
  return { rows, totals: { a_favor: totalFavor, en_contra: totalContra, neto: round2(totalFavor - totalContra) } };
}

module.exports = {
  EVENT_INCOME,
  EVENT_EXPENSE,
  DEFAULT_CONFIG,
  normalizeConfig,
  getConfig,
  saveConfig,
  computeAdjustment,
  balanceWithAdjustment,
  buildTaxRoundingLine,
  listAdjustments,
};
