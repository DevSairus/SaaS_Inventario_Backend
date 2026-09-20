// backend/src/services/accounting/bankReconciliation.service.js
//
// Conciliación Bancaria — Fase 3 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3, punto 6.
//
// Motor de conciliación: por cada BankTransaction 'pendiente', busca líneas
// de asiento (journal_entry_lines) en la cuenta bancaria correspondiente con
// mismo monto y fecha dentro de un rango (±N días, para cubrir desfases de
// acreditación) que no estén ya conciliadas con OTRO movimiento del banco.
// Si hay un único candidato -> conciliación automática. Si hay varios o
// ninguno -> queda pendiente para conciliación manual.
//
// Nota sobre el rango: el usuario confirmó que ±3 días (default) sirve por
// ahora, preguntando si es fácil de ajustar luego -- sí: se pasa como
// parámetro en cada llamada (`toleranceDays`), no está hardcodeado ni
// requiere migración para cambiarlo. Si más adelante se quiere un valor
// persistente por tenant/cuenta, basta con agregar la columna y leerla acá.
const { Op } = require('sequelize');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');

const DEFAULT_TOLERANCE_DAYS = 3;

/**
 * Candidatos de journal_entry_lines para UN movimiento bancario: misma
 * cuenta contable de la BankAccount, mismo monto (según el signo: entrada
 * de banco = débito de la cuenta, salida = crédito), asiento posteado,
 * dentro de la ventana de fecha, y que ningún OTRO BankTransaction ya lo
 * tenga tomado.
 */
async function findCandidateLines(tenantId, bankAccount, bankTransaction, toleranceDays, transaction) {
  const schema = getCurrentSchema() || 'public';
  const amount = Number(bankTransaction.amount);
  const isEntrada = amount > 0;
  const absAmount = Math.abs(amount);

  const rows = await sequelize.query(
    `SELECT l.id, l.entry_id, l.debit, l.credit, l.description, e.entry_date::text AS entry_date, e.entry_number
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE e.tenant_id = :tenantId
       AND l.account_id = :accountId
       AND e.status = 'posted'
       AND ${isEntrada ? 'l.debit' : 'l.credit'} = :amount
       AND e.entry_date BETWEEN (:txDate::date - :toleranceDays::int) AND (:txDate::date + :toleranceDays::int)
       AND l.id NOT IN (
         SELECT bt.matched_journal_entry_line_id FROM bank_transactions bt
         WHERE bt.matched_journal_entry_line_id IS NOT NULL AND bt.id != :bankTransactionId
       )
     ORDER BY e.entry_date ASC`,
    {
      replacements: {
        tenantId,
        accountId: bankAccount.chart_of_account_id,
        amount: absAmount,
        txDate: bankTransaction.transaction_date,
        toleranceDays,
        bankTransactionId: bankTransaction.id,
      },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  return rows;
}

/**
 * Corre el matching automático sobre todos los BankTransaction 'pendiente'
 * de una cuenta bancaria. Devuelve un resumen (cuántos quedaron
 * conciliados automáticamente vs. cuántos siguen pendientes por ambigüedad
 * o falta de candidato) -- no lanza error si no hay match, es el flujo
 * normal esperado.
 */
async function runAutoMatch(tenantId, bankAccountId, { toleranceDays = DEFAULT_TOLERANCE_DAYS } = {}) {
  const { BankAccount, BankTransaction } = require('../../models');

  const bankAccount = await BankAccount.findOne({ where: { id: bankAccountId, tenant_id: tenantId } });
  if (!bankAccount) throw new Error('Cuenta bancaria no encontrada');

  const pending = await BankTransaction.findAll({
    where: { tenant_id: tenantId, bank_account_id: bankAccountId, reconciliation_status: 'pendiente' },
    order: [['transaction_date', 'ASC']],
  });

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const tx of pending) {
    const candidates = await findCandidateLines(tenantId, bankAccount, tx, toleranceDays);
    if (candidates.length === 1) {
      await tx.update({ reconciliation_status: 'conciliada', matched_journal_entry_line_id: candidates[0].id });
      matched++;
    } else if (candidates.length > 1) {
      ambiguous++; // queda pendiente -- requiere que el usuario elija cuál
    } else {
      unmatched++;
    }
  }

  return { total: pending.length, matched, ambiguous, unmatched };
}

/**
 * Vista de conciliación de una cuenta bancaria: movimientos del banco (con
 * su estado) + candidatos disponibles del lado contable, para la UI de
 * "dos columnas lado a lado" que pide el plan. Los candidatos contables son
 * líneas posteadas de la cuenta que NINGÚN BankTransaction tiene tomada
 * todavía (independiente de monto/fecha -- el filtro fino de "qué pareja
 * con qué" lo hace el usuario al conciliar manualmente).
 */
async function getReconciliationView(tenantId, bankAccountId, { status, from_date, to_date } = {}) {
  const { BankAccount, BankTransaction } = require('../../models');

  const bankAccount = await BankAccount.findOne({ where: { id: bankAccountId, tenant_id: tenantId } });
  if (!bankAccount) throw new Error('Cuenta bancaria no encontrada');

  const where = { tenant_id: tenantId, bank_account_id: bankAccountId };
  if (status) where.reconciliation_status = status;
  if (from_date || to_date) {
    where.transaction_date = {};
    if (from_date) where.transaction_date[Op.gte] = from_date;
    if (to_date) where.transaction_date[Op.lte] = to_date;
  }

  const bankTransactions = await BankTransaction.findAll({ where, order: [['transaction_date', 'DESC']] });

  const schema = getCurrentSchema() || 'public';
  const dateFilter = [];
  if (from_date) dateFilter.push('e.entry_date >= :fromDate');
  if (to_date) dateFilter.push('e.entry_date <= :toDate');
  const dateClause = dateFilter.length ? `AND ${dateFilter.join(' AND ')}` : '';

  const accountingLines = await sequelize.query(
    `SELECT l.id, l.debit, l.credit, l.description, e.entry_date::text AS entry_date, e.entry_number
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE e.tenant_id = :tenantId
       AND l.account_id = :accountId
       AND e.status = 'posted'
       AND l.id NOT IN (
         SELECT bt.matched_journal_entry_line_id FROM bank_transactions bt
         WHERE bt.matched_journal_entry_line_id IS NOT NULL
       )
       ${dateClause}
     ORDER BY e.entry_date DESC`,
    {
      replacements: { tenantId, accountId: bankAccount.chart_of_account_id, fromDate: from_date || null, toDate: to_date || null },
      type: QueryTypes.SELECT,
    }
  );

  return { bank_account: bankAccount, bank_transactions: bankTransactions, accounting_candidates: accountingLines };
}

/** Concilia manualmente UN movimiento del banco con UNA línea contable elegida por el usuario. */
async function matchManually(tenantId, bankTransactionId, journalEntryLineId) {
  const { BankTransaction } = require('../../models');

  const tx = await BankTransaction.findOne({ where: { id: bankTransactionId, tenant_id: tenantId } });
  if (!tx) throw new Error('Movimiento bancario no encontrado');
  if (tx.reconciliation_status === 'conciliada') throw new Error('Este movimiento ya está conciliado');

  const alreadyTaken = await BankTransaction.findOne({
    where: { matched_journal_entry_line_id: journalEntryLineId, id: { [Op.ne]: tx.id } },
  });
  if (alreadyTaken) throw new Error('Esa línea contable ya está conciliada con otro movimiento del banco');

  await tx.update({ reconciliation_status: 'conciliada', matched_journal_entry_line_id: journalEntryLineId });
  return tx;
}

/** Deshace una conciliación (manual o automática), dejando el movimiento 'pendiente' de nuevo. */
async function unmatch(tenantId, bankTransactionId) {
  const { BankTransaction } = require('../../models');
  const tx = await BankTransaction.findOne({ where: { id: bankTransactionId, tenant_id: tenantId } });
  if (!tx) throw new Error('Movimiento bancario no encontrado');
  await tx.update({ reconciliation_status: 'pendiente', matched_journal_entry_line_id: null });
  return tx;
}

/**
 * Marca un movimiento del banco como 'ignorada' (no debe tener contrapartida
 * contable -- ej. rendimientos financieros aún no contabilizados). El plan
 * deja la opción disponible aunque el flujo correcto normalmente sea
 * contabilizar primero, no ignorar.
 */
async function markIgnored(tenantId, bankTransactionId) {
  const { BankTransaction } = require('../../models');
  const tx = await BankTransaction.findOne({ where: { id: bankTransactionId, tenant_id: tenantId } });
  if (!tx) throw new Error('Movimiento bancario no encontrado');
  if (tx.reconciliation_status === 'conciliada') throw new Error('Este movimiento ya está conciliado, no se puede ignorar');
  await tx.update({ reconciliation_status: 'ignorada' });
  return tx;
}

module.exports = {
  DEFAULT_TOLERANCE_DAYS,
  runAutoMatch,
  getReconciliationView,
  matchManually,
  unmatch,
  markIgnored,
};
