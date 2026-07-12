// backend/src/services/accounting/journalEntry.service.js
const { Op } = require('sequelize');
const logger = require('../../config/logger');

/**
 * Genera el consiguiente número de asiento para el tenant: AST-2026-00001
 */
async function generateEntryNumber(tenantId, transaction) {
  const { JournalEntry } = require('../../models');
  const year = new Date().getFullYear();
  const prefix = `AST-${year}-`;

  const last = await JournalEntry.findOne({
    where: { tenant_id: tenantId, entry_number: { [Op.like]: `${prefix}%` } },
    order: [['entry_number', 'DESC']],
    transaction,
  });

  let next = 1;
  if (last) {
    const lastNumber = parseInt(last.entry_number.split('-').pop(), 10);
    if (!isNaN(lastNumber)) next = lastNumber + 1;
  }
  return `${prefix}${String(next).padStart(5, '0')}`;
}

/**
 * Resuelve el account_id configurado para un evento del sistema.
 * Lanza error si el tenant no tiene mapeo para ese evento (evita generar
 * asientos con cuentas incorrectas por defecto silencioso).
 */
async function getMappedAccountId(tenantId, eventType, transaction) {
  const { AccountMapping } = require('../../models');
  const mapping = await AccountMapping.findOne({
    where: { tenant_id: tenantId, event_type: eventType },
    transaction,
  });
  if (!mapping) {
    throw new Error(`No hay mapeo contable configurado para el evento "${eventType}" en este tenant`);
  }
  return mapping.account_id;
}

/**
 * Resuelve (o crea) el período fiscal abierto correspondiente a una fecha.
 */
async function getOrCreatePeriod(tenantId, entryDate, transaction) {
  const { FiscalPeriod } = require('../../models');
  const d = new Date(entryDate);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;

  let period = await FiscalPeriod.findOne({ where: { tenant_id: tenantId, year, month }, transaction });
  if (!period) {
    period = await FiscalPeriod.create({ tenant_id: tenantId, year, month, status: 'open' }, { transaction });
  }
  return period;
}

/**
 * Crea un asiento en estado draft con sus líneas.
 * `lines`: [{ account_id, debit, credit, description, third_party_id }]
 * Valida que debe == haber antes de crear.
 */
async function createDraftEntry(tenantId, { branchId, entryDate, sourceType, sourceId, description, lines, createdBy }, transaction) {
  const { JournalEntry, JournalEntryLine } = require('../../models');

  if (!lines || lines.length < 2) {
    throw new Error('Un asiento contable necesita al menos 2 líneas (débito y crédito)');
  }

  const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit || 0), 0);
  const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit || 0), 0);

  // Tolerancia de 1 centavo por redondeos de impuestos
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`El asiento no cuadra: débito ${totalDebit} vs crédito ${totalCredit}`);
  }

  const entryNumber = await generateEntryNumber(tenantId, transaction);
  const period = await getOrCreatePeriod(tenantId, entryDate, transaction);

  if (period.status === 'closed') {
    throw new Error(`El período ${period.month}/${period.year} está cerrado, no se pueden crear asientos en esa fecha`);
  }

  const entry = await JournalEntry.create(
    {
      tenant_id: tenantId,
      branch_id: branchId || null,
      entry_number: entryNumber,
      entry_date: entryDate,
      period_id: period.id,
      source_type: sourceType || 'manual',
      source_id: sourceId || null,
      description: description || null,
      status: 'draft',
      total_debit: totalDebit,
      total_credit: totalCredit,
      created_by: createdBy || null,
    },
    { transaction }
  );

  await JournalEntryLine.bulkCreate(
    lines.map((l, idx) => ({
      entry_id: entry.id,
      account_id: l.account_id,
      debit: l.debit || 0,
      credit: l.credit || 0,
      description: l.description || null,
      third_party_id: l.third_party_id || null,
      line_order: idx,
    })),
    { transaction }
  );

  return entry;
}

/**
 * Contabiliza (posted) un asiento en draft. A partir de aquí el asiento
 * afecta reportes (balance de comprobación, balance general, P&G).
 */
async function postEntry(entryId, tenantId, userId) {
  const { JournalEntry } = require('../../models');
  const entry = await JournalEntry.findOne({ where: { id: entryId, tenant_id: tenantId } });
  if (!entry) throw new Error('Asiento no encontrado');
  if (entry.status !== 'draft') throw new Error(`Solo se pueden contabilizar asientos en borrador (estado actual: ${entry.status})`);

  await entry.update({ status: 'posted', posted_by: userId || null, posted_at: new Date() });
  return entry;
}

/**
 * Anula un asiento (draft o posted). No se borra físicamente para mantener
 * trazabilidad — queda status=voided y no cuenta en los reportes.
 */
async function voidEntry(entryId, tenantId, userId, reason) {
  const { JournalEntry } = require('../../models');
  const entry = await JournalEntry.findOne({ where: { id: entryId, tenant_id: tenantId } });
  if (!entry) throw new Error('Asiento no encontrado');
  if (entry.status === 'voided') throw new Error('El asiento ya está anulado');

  await entry.update({ status: 'voided', voided_by: userId || null, voided_at: new Date(), void_reason: reason || null });
  return entry;
}

/**
 * Reversa el asiento contable de un movimiento que dejó de ser válido
 * (ej. una venta cancelada, una devolución de cliente/proveedor).
 *
 * Comportamiento según el estado del asiento original:
 *  - 'draft'  → nadie lo revisó ni afectó reportes todavía: simplemente se
 *               anula (voidEntry), no hace falta contrapartida.
 *  - 'posted' → ya afectó reportes (y puede estar en un período que hoy está
 *               cerrado). No se edita ni se anula el original — eso rompería
 *               inmutabilidad/trazabilidad. En su lugar se crea un asiento
 *               NUEVO con débito/crédito invertidos, fechado el día de la
 *               reversión (no el día del asiento original), y se enlazan
 *               entre sí. El asiento de reversión se postea de inmediato:
 *               es una corrección automática del sistema, no un movimiento
 *               nuevo que necesite revisión manual.
 *  - 'voided' → error, no se puede reversar algo que ya está anulado.
 *  - ya tiene reversed_by_entry_id → error, ya fue reversado antes (evita
 *    duplicar la contrapartida si dos flujos intentan reversar lo mismo).
 *
 * @returns {Promise<{ action: 'voided'|'reversed', entry: object, reversalEntry?: object }>}
 */
async function reverseEntry(originalEntryId, tenantId, userId, reason, transaction) {
  const { JournalEntry, JournalEntryLine } = require('../../models');

  const original = await JournalEntry.findOne({
    where: { id: originalEntryId, tenant_id: tenantId },
    include: [{ model: JournalEntryLine, as: 'lines' }],
    transaction,
  });
  if (!original) throw new Error('Asiento original no encontrado');
  if (original.status === 'voided') throw new Error('El asiento ya está anulado, no se puede reversar');
  if (original.reversed_by_entry_id) throw new Error('El asiento ya fue reversado anteriormente');

  if (original.status === 'draft') {
    const voided = await voidEntry(originalEntryId, tenantId, userId, reason || 'Reversado: origen cancelado');
    return { action: 'voided', entry: voided };
  }

  // status === 'posted' → asiento de reversión con líneas invertidas
  const reversalLines = original.lines.map((l) => ({
    account_id: l.account_id,
    debit: Number(l.credit || 0),
    credit: Number(l.debit || 0),
    description: `Reversión — ${l.description || ''}`.trim(),
    third_party_id: l.third_party_id || null,
  }));

  const reversalEntry = await createDraftEntry(
    tenantId,
    {
      branchId: original.branch_id,
      entryDate: new Date().toISOString().slice(0, 10),
      sourceType: 'adjustment',
      sourceId: original.source_id,
      description: `Reversión de ${original.entry_number} — ${reason || 'origen cancelado/devuelto'}`,
      lines: reversalLines,
      createdBy: userId,
    },
    transaction
  );

  await reversalEntry.update(
    { status: 'posted', posted_by: userId || null, posted_at: new Date(), reversal_of_entry_id: original.id },
    { transaction }
  );
  await original.update({ reversed_by_entry_id: reversalEntry.id }, { transaction });

  return { action: 'reversed', entry: original, reversalEntry };
}

/**
 * Envoltorio "silencioso" para generadores automáticos: si falla, se
 * registra en el log pero NUNCA rompe el flujo del módulo origen (venta,
 * compra, gasto). La contabilidad es fase draft/revisión, no puede tumbar
 * una venta por un problema de mapeo contable.
 */
// `rethrow`: por defecto false (comportamiento original, fire-and-forget:
// loguea y devuelve null). En true, además de loguear, relanza el error —
// lo usa la generación MANUAL desde la pantalla de Salud Contable, donde sí
// queremos mostrarle al usuario por qué falló (ej. "falta mapear la cuenta
// de IVA descontable") en vez de tragarnos el error silenciosamente.
async function safeAutoGenerate(fn, context, { rethrow = false } = {}) {
  try {
    return await fn();
  } catch (error) {
    logger.warn(`[accounting] No se pudo generar asiento automático (${context}): ${error.message}`);
    if (rethrow) throw error;
    return null;
  }
}

module.exports = {
  generateEntryNumber,
  getMappedAccountId,
  getOrCreatePeriod,
  createDraftEntry,
  postEntry,
  voidEntry,
  reverseEntry,
  safeAutoGenerate,
};
