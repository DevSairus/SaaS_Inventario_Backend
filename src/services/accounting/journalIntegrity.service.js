// backend/src/services/accounting/journalIntegrity.service.js
//
// Fase 3 del Asistente de IA — control de integridad contable.
//
// `autoEntries.service.js` genera el asiento en borrador de cada venta
// confirmada, compra recibida, gasto y cierre de caja con diferencia, pero
// lo hace de forma "fire and forget" (setImmediate + safeAutoGenerate): si
// falla (típicamente por un AccountMapping sin configurar), el movimiento
// real queda registrado igual y solo se loguea un warning que nadie de
// negocio lee. Este servicio expone esos huecos como datos consultables,
// para que NEXA (o cualquier pantalla futura) pueda decir "estos N
// movimientos no tienen su asiento contable".
//
// Es intencionalmente de SOLO LECTURA — no reintenta ni corrige nada.

const { Op, fn, col } = require('sequelize');
const { Sale, Purchase, Expense, CashSession, JournalEntry, JournalEntryLine } = require('../../models');

/**
 * Busca ventas confirmadas, compras recibidas, gastos y cierres de caja con
 * diferencia dentro de un rango de fechas, y determina cuáles NO tienen su
 * JournalEntry correspondiente (source_type + source_id).
 *
 * @param {string} tenantId
 * @param {{ from: string, to: string, branchId?: string }} params
 * @returns {Promise<{ total_missing: number, by_type: Object, items: Array }>}
 */
async function findMissingJournalEntries(tenantId, { from, to, branchId } = {}) {
  if (!from || !to) {
    throw new Error('from y to (YYYY-MM-DD) son obligatorios');
  }

  const branchFilter = branchId ? { branch_id: branchId } : {};

  // ── 1. Traer los movimientos "fuente" que deberían tener asiento ─────────
  const [sales, purchases, expenses, cashSessions] = await Promise.all([
    Sale.findAll({
      where: {
        tenant_id: tenantId,
        status: 'completed',
        sale_date: { [Op.between]: [from, to] },
        ...branchFilter,
      },
      attributes: ['id', 'sale_number', 'sale_date', 'total_amount', 'branch_id'],
    }),
    Purchase.findAll({
      where: {
        tenant_id: tenantId,
        status: 'received',
        purchase_date: { [Op.between]: [from, to] },
        ...branchFilter,
      },
      attributes: ['id', 'purchase_number', 'purchase_date', 'total_amount', 'branch_id'],
    }),
    Expense.findAll({
      where: {
        tenant_id: tenantId,
        expense_date: { [Op.between]: [from, to] },
        ...branchFilter,
      },
      attributes: ['id', 'expense_number', 'expense_date', 'total_amount', 'branch_id', 'description'],
    }),
    CashSession.findAll({
      where: {
        tenant_id: tenantId,
        status: 'closed',
        session_date: { [Op.between]: [from, to] },
        ...branchFilter,
      },
      attributes: ['id', 'session_date', 'differences', 'branch_id'],
    }),
  ]);

  // Los cierres de caja SOLO generan asiento si hubo sobrante/faltante real
  // (ver generateCashSessionEntry) — si la caja cuadró, no tener asiento es
  // correcto, no un hueco. Filtramos antes de comparar.
  const cashSessionsWithDifference = cashSessions.filter((session) => {
    const differences = session.differences || {};
    return Object.values(differences).some((v) => Math.abs(Number(v || 0)) > 0.01);
  });

  const sourcesToCheck = [
    ...sales.map((s) => ({
      source_type: 'sale',
      source_id: s.id,
      label: `Venta ${s.sale_number || s.id}`,
      date: s.sale_date,
      amount: s.total_amount,
      branch_id: s.branch_id,
    })),
    ...purchases.map((p) => ({
      source_type: 'purchase',
      source_id: p.id,
      label: `Compra ${p.purchase_number || p.id}`,
      date: p.purchase_date,
      amount: p.total_amount,
      branch_id: p.branch_id,
    })),
    ...expenses.map((e) => ({
      source_type: 'expense',
      source_id: e.id,
      label: `Gasto ${e.expense_number || e.id} (${e.description})`,
      date: e.expense_date,
      amount: e.total_amount,
      branch_id: e.branch_id,
    })),
    ...cashSessionsWithDifference.map((c) => ({
      source_type: 'cash_session',
      source_id: c.id,
      label: `Cierre de caja ${c.session_date}`,
      date: c.session_date,
      amount: null,
      branch_id: c.branch_id,
    })),
  ];

  if (sourcesToCheck.length === 0) {
    return { total_missing: 0, by_type: {}, items: [] };
  }

  // ── 2. Traer los JournalEntry existentes que cubran esas fuentes ─────────
  const existingEntries = await JournalEntry.findAll({
    where: {
      tenant_id: tenantId,
      source_id: { [Op.in]: sourcesToCheck.map((s) => s.source_id) },
    },
    attributes: ['source_type', 'source_id'],
  });
  const existingKeys = new Set(existingEntries.map((e) => `${e.source_type}:${e.source_id}`));

  // ── 3. Los que no aparecen en existingKeys son los huérfanos ─────────────
  const missing = sourcesToCheck.filter((s) => !existingKeys.has(`${s.source_type}:${s.source_id}`));

  const byType = missing.reduce((acc, item) => {
    acc[item.source_type] = (acc[item.source_type] || 0) + 1;
    return acc;
  }, {});

  const sorted = missing.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Cap el detalle devuelto: un backlog histórico grande (ej. movimientos de
  // antes de tener contabilidad) puede tener cientos de items — listarlos
  // todos infla el prompt y el TPM sin agregar valor real en un solo mensaje.
  // El conteo total (`total_missing`/`by_type`) siempre es exacto; el
  // `truncated` avisa que hay más de los que se listan.
  const MAX_ITEMS = 40;
  const items = sorted.slice(0, MAX_ITEMS);

  return {
    total_missing: missing.length,
    by_type: byType,
    items,
    truncated: missing.length > MAX_ITEMS,
    shown: items.length,
  };
}

/**
 * Busca asientos en estado 'draft' (automáticos o manuales) creados hace
 * más de `olderThanDays` días — es decir, ya se contabilizó el movimiento
 * pero nadie lo revisó/posteó todavía. Es el otro lado del hueco de
 * integridad que `findMissingJournalEntries` no cubre: ahí falta el
 * asiento; acá el asiento existe pero quedó a medias.
 *
 * @param {string} tenantId
 * @param {{ olderThanDays?: number, branchId?: string }} params
 * @returns {Promise<{ total: number, older_than_days: number, items: Array, truncated: boolean, shown: number }>}
 */
async function getDraftEntriesPendingReview(tenantId, { olderThanDays = 7, branchId } = {}) {
  const days = Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) >= 0 ? Number(olderThanDays) : 7;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const where = {
    tenant_id: tenantId,
    status: 'draft',
    created_at: { [Op.lte]: cutoff },
  };
  if (branchId) where.branch_id = branchId;

  const entries = await JournalEntry.findAll({
    where,
    order: [['created_at', 'ASC']],
    attributes: [
      'id', 'entry_number', 'entry_date', 'source_type', 'source_id',
      'description', 'total_debit', 'total_credit', 'branch_id', 'created_at',
    ],
  });

  const now = new Date();
  const sorted = entries.map((e) => ({
    id: e.id,
    entry_number: e.entry_number,
    entry_date: e.entry_date,
    source_type: e.source_type,
    source_id: e.source_id,
    description: e.description,
    total_debit: e.total_debit,
    total_credit: e.total_credit,
    days_pending: Math.floor((now - new Date(e.created_at)) / (1000 * 60 * 60 * 24)),
  }));

  // Mismo criterio de recorte que findMissingJournalEntries: el conteo total
  // siempre es exacto, el detalle listado se cap para no inflar el prompt.
  const MAX_ITEMS = 40;
  const items = sorted.slice(0, MAX_ITEMS);

  return {
    total: sorted.length,
    older_than_days: days,
    items,
    truncated: sorted.length > MAX_ITEMS,
    shown: items.length,
  };
}

/**
 * Red de seguridad barata: confirma que débito == crédito, tanto a nivel
 * global como asiento por asiento, dentro de un rango de fechas. Por
 * diseño esto NUNCA debería fallar — `createDraftEntry` ya valida que
 * cuadre antes de crear el asiento — pero sirve para detectar corrupción
 * de datos (ej. una migración manual, un bug futuro, una edición directa
 * en base de datos) antes de que alguien note que el balance no cuadra
 * meses después.
 *
 * Compara, por cada asiento no anulado: (a) la suma real de sus líneas
 * (débito vs crédito) entre sí, y (b) esa suma real contra los totales
 * cacheados en la cabecera (`total_debit`/`total_credit`) — no basta con
 * confiar en la cabecera, porque si algo la desincroniza de las líneas
 * reales, es exactamente el tipo de corrupción que este chequeo debe
 * atrapar.
 *
 * @param {string} tenantId
 * @param {{ from: string, to: string, branchId?: string }} params
 * @returns {Promise<Object>}
 */
async function validateTrialBalanceConsistency(tenantId, { from, to, branchId } = {}) {
  if (!from || !to) {
    throw new Error('from y to (YYYY-MM-DD) son obligatorios');
  }

  const branchFilter = branchId ? { branch_id: branchId } : {};

  // Los asientos anulados no cuentan para el cuadre — es intencional que
  // queden "fuera" de los reportes (ver journalEntry.service.js#voidEntry).
  const entries = await JournalEntry.findAll({
    where: {
      tenant_id: tenantId,
      status: { [Op.ne]: 'voided' },
      entry_date: { [Op.between]: [from, to] },
      ...branchFilter,
    },
    attributes: ['id', 'entry_number', 'entry_date', 'status', 'total_debit', 'total_credit'],
  });

  if (entries.length === 0) {
    return {
      is_consistent: true,
      entries_checked: 0,
      global: { total_debit: 0, total_credit: 0, difference: 0 },
      inconsistent_entries: [],
    };
  }

  const entryIds = entries.map((e) => e.id);
  const entryById = new Map(entries.map((e) => [e.id, e]));

  // Suma real de líneas por asiento — la fuente de verdad, no la cabecera.
  const lineSums = await JournalEntryLine.findAll({
    attributes: [
      'entry_id',
      [fn('SUM', col('debit')), 'sum_debit'],
      [fn('SUM', col('credit')), 'sum_credit'],
    ],
    where: { entry_id: { [Op.in]: entryIds } },
    group: ['entry_id'],
    raw: true,
  });
  const lineSumsByEntry = new Map(lineSums.map((s) => [s.entry_id, s]));

  const TOLERANCE = 0.01; // redondeo de impuestos, mismo criterio que createDraftEntry
  const inconsistent = [];
  let globalDebit = 0;
  let globalCredit = 0;

  for (const entry of entries) {
    const sums = lineSumsByEntry.get(entry.id);
    const sumDebit = Number(sums?.sum_debit || 0);
    const sumCredit = Number(sums?.sum_credit || 0);

    globalDebit += sumDebit;
    globalCredit += sumCredit;

    const problems = [];
    if (!sums) {
      problems.push('El asiento no tiene ninguna línea (journal_entry_lines vacío)');
    } else {
      if (Math.abs(sumDebit - sumCredit) > TOLERANCE) {
        problems.push(`Sus líneas no cuadran entre sí: débito ${sumDebit} vs crédito ${sumCredit}`);
      }
      if (Math.abs(sumDebit - Number(entry.total_debit)) > TOLERANCE || Math.abs(sumCredit - Number(entry.total_credit)) > TOLERANCE) {
        problems.push(
          `La cabecera no coincide con sus líneas: cabecera dice ${entry.total_debit}/${entry.total_credit}, las líneas suman ${sumDebit}/${sumCredit}`
        );
      }
    }

    if (problems.length > 0) {
      inconsistent.push({
        entry_id: entry.id,
        entry_number: entry.entry_number,
        entry_date: entry.entry_date,
        status: entry.status,
        problems,
      });
    }
  }

  const MAX_ITEMS = 40;

  return {
    is_consistent: inconsistent.length === 0,
    entries_checked: entries.length,
    global: {
      total_debit: globalDebit,
      total_credit: globalCredit,
      difference: Math.round((globalDebit - globalCredit) * 100) / 100,
    },
    inconsistent_entries: inconsistent.slice(0, MAX_ITEMS),
    truncated: inconsistent.length > MAX_ITEMS,
    total_inconsistent: inconsistent.length,
  };
}

module.exports = { findMissingJournalEntries, getDraftEntriesPendingReview, validateTrialBalanceConsistency };