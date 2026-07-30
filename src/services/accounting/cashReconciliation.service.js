// backend/src/services/accounting/cashReconciliation.service.js
//
// Hallazgo 3.5 del análisis contable: "Flujo de Caja" (finance/cashflow) y
// "Contabilidad" (accounting) son hoy dos fuentes de verdad independientes
// para la misma pregunta ("¿cuánto dinero entró/salió?"):
//
//   - Tesorería (cashflow.controller.js#buildCashFlow) suma payment_history
//     de Ventas/Compras/Gastos directamente, sin pasar por asientos.
//   - Contabilidad registra el mismo movimiento en las cuentas de Caja
//     (110505) y Bancos (111005) vía los asientos automáticos de
//     autoEntries.service.js, pero SOLO cuenta lo que ya está `posted`
//     (los reportes contables ignoran `draft` y `voided` a propósito).
//
// Este servicio no reemplaza ninguna de las dos vistas — arma la vista
// "desde Contabilidad" usando las mismas cuentas que ya reutiliza todo el
// motor de asientos automáticos, para que cashflow.controller.js pueda
// compararlas y decir explícitamente si coinciden o no, en vez de dejar que
// diverjan en silencio (el riesgo que señala el hallazgo 3.5).
//
// Nota: como los asientos automáticos nacen en `draft` y hay que postearlos
// manualmente (o vía un flujo de aprobación), es NORMAL y esperado que, en el
// día a día, Contabilidad muestre menos que Tesorería mientras haya asientos
// sin revisar. Por eso esta función también devuelve el monto en borrador
// (`pending_draft`) que toca esas mismas cuentas: es la explicación más común
// de una diferencia, y evita que una discrepancia normal ("faltan posteos")
// se confunda con una discrepancia real ("algo no cuadra").

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');

// Eventos cuyo account_mapping apunta a una cuenta de caja o bancos —
// son exactamente las cuentas que se debitan/acreditan cuando entra o sale
// dinero real, en todo el motor de asientos automáticos (ver
// autoEntries.service.js: generateSaleEntry, generatePurchaseEntry,
// generateExpenseEntry, generateCashSessionEntry, y las devoluciones).
const CASH_AND_BANK_EVENTS = [
  'sale_cash_account',
  'sale_bank_account',
  'purchase_cash_account',
  'expense_cash_account',
  'expense_bank_account',
];

/**
 * Resuelve, para un tenant, el conjunto (sin duplicados) de account_id que
 * representan caja o bancos según sus account_mappings actuales. Se resuelve
 * dinámicamente (no se hardcodea el código PUC) porque el mapeo es editable
 * por tenant desde /accounting/mapeo-cuentas.
 */
async function getCashAndBankAccountIds(tenantId) {
  const { AccountMapping } = require('../../models');
  const mappings = await AccountMapping.findAll({
    where: { tenant_id: tenantId, event_type: { [Op.in]: CASH_AND_BANK_EVENTS } },
    attributes: ['account_id'],
  });
  return [...new Set(mappings.map((m) => m.account_id))];
}

/**
 * Arma el flujo de caja "visto desde Contabilidad": movimientos posteados
 * sobre las cuentas de caja/bancos, por día, en el rango dado.
 *
 * Semántica: como son cuentas de activo, un débito es entrada de dinero
 * (cobro, reintegro) y un crédito es salida (pago, reducción por
 * devolución) — el mismo signo que usa `buildCashFlow` en cashflow.controller.js.
 *
 * @param {string} tenantId
 * @param {{ from_date?: string, to_date?: string, branch_id?: string }} params
 */
async function getAccountingCashFlow(tenantId, { from_date, to_date, branch_id } = {}) {
  const accountIds = await getCashAndBankAccountIds(tenantId);

  const empty = {
    summary: { total_in: 0, total_out: 0, net: 0 },
    by_day: [],
    pending_draft: { total_in: 0, total_out: 0, net: 0, entries: 0 },
    accounts_used: 0,
  };

  if (accountIds.length === 0) return empty; // tenant sin mapeo de caja/bancos configurado

  const dateFilter = [];
  if (from_date) dateFilter.push('e.entry_date >= :fromDate');
  if (to_date) dateFilter.push('e.entry_date <= :toDate');
  const dateClause = dateFilter.length ? `AND ${dateFilter.join(' AND ')}` : '';

  const replacements = {
    tenantId,
    accountIds,
    fromDate: from_date || null,
    toDate: to_date || null,
    branchId: branch_id || null,
  };

  // Movimientos ya posteados, por día — esto es lo que cuenta como
  // "verdad contable" hoy mismo (mismo criterio que financialReports.controller.js).
  //
  // Sin calificar schema, estas dos queries siempre leían "public" -- para
  // un tenant ya cortado a su propio schema la conciliación salía vacía sin
  // error visible.
  const schema = getCurrentSchema() || 'public';
  const postedRows = await sequelize.query(
    `SELECT e.entry_date::text AS date,
            COALESCE(SUM(l.debit), 0)  AS total_in,
            COALESCE(SUM(l.credit), 0) AS total_out
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE e.tenant_id = :tenantId
       AND l.account_id IN (:accountIds)
       AND e.status = 'posted'
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
       ${dateClause}
     GROUP BY e.entry_date
     ORDER BY e.entry_date ASC`,
    { replacements, type: QueryTypes.SELECT }
  );

  const by_day = postedRows.map((r) => ({
    date: r.date,
    in: Number(r.total_in),
    out: Number(r.total_out),
    net: Number(r.total_in) - Number(r.total_out),
  }));

  const summary = by_day.reduce(
    (acc, d) => ({ total_in: acc.total_in + d.in, total_out: acc.total_out + d.out, net: 0 }),
    { total_in: 0, total_out: 0, net: 0 }
  );
  summary.net = summary.total_in - summary.total_out;

  // Lo que está en borrador (creado pero no contabilizado todavía) sobre las
  // mismas cuentas — no cuenta en `summary`, pero explica por qué Tesorería
  // puede ir adelante de Contabilidad en un momento dado.
  const [draftRow] = await sequelize.query(
    `SELECT COALESCE(SUM(l.debit), 0)  AS total_in,
            COALESCE(SUM(l.credit), 0) AS total_out,
            COUNT(DISTINCT e.id)       AS entries
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE e.tenant_id = :tenantId
       AND l.account_id IN (:accountIds)
       AND e.status = 'draft'
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
       ${dateClause}`,
    { replacements, type: QueryTypes.SELECT }
  );

  const pending_draft = {
    total_in: Number(draftRow?.total_in || 0),
    total_out: Number(draftRow?.total_out || 0),
    net: Number(draftRow?.total_in || 0) - Number(draftRow?.total_out || 0),
    entries: Number(draftRow?.entries || 0),
  };

  return { summary, by_day, pending_draft, accounts_used: accountIds.length };
}

module.exports = { getAccountingCashFlow, getCashAndBankAccountIds, CASH_AND_BANK_EVENTS };
