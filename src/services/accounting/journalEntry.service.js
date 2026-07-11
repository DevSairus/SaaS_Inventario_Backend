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
 * Envoltorio "silencioso" para generadores automáticos: si falla, se
 * registra en el log pero NUNCA rompe el flujo del módulo origen (venta,
 * compra, gasto). La contabilidad es fase draft/revisión, no puede tumbar
 * una venta por un problema de mapeo contable.
 */
async function safeAutoGenerate(fn, context) {
  try {
    return await fn();
  } catch (error) {
    logger.warn(`[accounting] No se pudo generar asiento automático (${context}): ${error.message}`);
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
  safeAutoGenerate,
};
