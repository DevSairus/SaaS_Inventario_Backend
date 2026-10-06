// backend/src/services/accounting/accountMigration.service.js
//
// Migración de movimientos de una cuenta a otra (solo contabilidad). Caso
// típico: un mapeo estuvo apuntando a la cuenta equivocada durante meses, o
// el contador abrió una subcuenta nueva y quiere llevar allí lo registrado.
//
// Dos modos (ver migración 2026100503-create-account-migrations.js):
//
//  reclassification (recomendado): no toca los asientos originales. Crea un
//    asiento nuevo, contabilizado, con source_type 'reclassification', que
//    por cada (sede, tercero) saca el saldo neto de la cuenta origen y lo
//    lleva a la destino. Respeta la regla de la casa: lo contabilizado es
//    inmutable y se corrige con asientos nuevos. Solo cuenta asientos
//    'posted' (los borradores todavía no afectan saldos).
//
//  direct: cambia account_id de las líneas existentes (draft y posted). El
//    auxiliar queda como si siempre se hubiera registrado en la destino. Solo
//    se permite si TODOS los asientos afectados están en períodos abiertos:
//    cambiar un período cerrado alteraría estados financieros ya emitidos.
//
// En ambos modos, opcionalmente, los mapeos (account_mappings) que apuntan a
// la cuenta origen se repuntan a la destino para que lo nuevo ya no caiga
// allí (con su registro en account_mapping_audits).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { createDraftEntry } = require('./journalEntry.service');

const MODES = ['reclassification', 'direct'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function loadAccounts(tenantId, fromAccountId, toAccountId, transaction) {
  const { ChartOfAccount } = require('../../models');
  if (!fromAccountId || !toAccountId) throw badRequest('Cuenta origen y cuenta destino son obligatorias');
  if (fromAccountId === toAccountId) throw badRequest('La cuenta destino debe ser distinta a la cuenta origen');

  const [from, to] = await Promise.all([
    ChartOfAccount.findOne({ where: { id: fromAccountId, tenant_id: tenantId }, transaction }),
    ChartOfAccount.findOne({ where: { id: toAccountId, tenant_id: tenantId }, transaction }),
  ]);
  if (!from) throw badRequest('Cuenta origen no encontrada');
  if (!to) throw badRequest('Cuenta destino no encontrada');
  if (!to.is_active || !to.accepts_entries) {
    throw badRequest(`La cuenta destino ${to.code} debe estar activa y ser de movimiento (no una cuenta de agrupación)`);
  }
  return { from, to };
}

function validateRange(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) throw badRequest('El rango de fechas (desde/hasta) es obligatorio');
  if (dateFrom > dateTo) throw badRequest('La fecha inicial debe ser anterior a la final');
}

// Filtro común de líneas: cuenta origen, rango, estados según el modo y
// filtros opcionales de tercero/sede.
function linesWhere({ mode, thirdPartyId, branchId }) {
  const statuses = mode === 'direct' ? `('draft', 'posted')` : `('posted')`;
  let sql = `
    l.account_id = :fromAccountId
    AND e.tenant_id = :tenantId
    AND e.status IN ${statuses}
    AND e.entry_date BETWEEN :dateFrom AND :dateTo`;
  if (thirdPartyId) sql += ` AND l.third_party_id = :thirdPartyId`;
  if (branchId) sql += branchId === 'null' ? ` AND e.branch_id IS NULL` : ` AND e.branch_id = :branchId`;
  return sql;
}

async function thirdPartyNames(schema, ids, transaction) {
  const list = ids.filter(Boolean);
  if (!list.length) return {};
  const rows = await sequelize.query(
    `SELECT id, COALESCE(NULLIF(business_name, ''), TRIM(CONCAT(first_name, ' ', last_name))) AS name FROM "${schema}"."customers" WHERE id IN (:ids)
     UNION ALL
     SELECT id, COALESCE(NULLIF(business_name, ''), name) AS name FROM "${schema}"."suppliers" WHERE id IN (:ids)
     UNION ALL
     SELECT id, TRIM(CONCAT(first_name, ' ', first_surname)) AS name FROM "${schema}"."employees" WHERE id IN (:ids)`,
    { replacements: { ids: list }, type: QueryTypes.SELECT, transaction }
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/**
 * Lo que se movería, agrupado por sede y tercero, más las advertencias.
 */
async function previewMigration(tenantId, params, transaction) {
  const { mode = 'reclassification', fromAccountId, toAccountId, dateFrom, dateTo, thirdPartyId, branchId } = params;
  if (!MODES.includes(mode)) throw badRequest(`Modo inválido: ${mode}`);
  validateRange(dateFrom, dateTo);
  const { from, to } = await loadAccounts(tenantId, fromAccountId, toAccountId, transaction);
  const schema = getCurrentSchema() || 'public';
  const replacements = { tenantId, fromAccountId, dateFrom, dateTo, thirdPartyId: thirdPartyId || null, branchId: branchId || null };

  const groups = await sequelize.query(
    `SELECT e.branch_id, l.third_party_id,
            COUNT(*)::int AS lines_count,
            COALESCE(SUM(l.debit), 0) AS debit,
            COALESCE(SUM(l.credit), 0) AS credit
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE ${linesWhere({ mode, thirdPartyId, branchId })}
     GROUP BY e.branch_id, l.third_party_id
     ORDER BY e.branch_id NULLS FIRST, l.third_party_id NULLS FIRST`,
    { replacements, type: QueryTypes.SELECT, transaction }
  );

  // Períodos cerrados entre los asientos afectados: bloquean el modo direct.
  const closedPeriods = await sequelize.query(
    `SELECT DISTINCT p.year, p.month
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     JOIN "${schema}"."fiscal_periods" p ON p.id = e.period_id
     WHERE ${linesWhere({ mode, thirdPartyId, branchId })} AND p.status = 'closed'
     ORDER BY p.year, p.month`,
    { replacements, type: QueryTypes.SELECT, transaction }
  );

  const { AccountMapping } = require('../../models');
  const mappings = await AccountMapping.findAll({
    where: { tenant_id: tenantId, account_id: from.id },
    attributes: ['event_type'],
    transaction,
  });

  const names = await thirdPartyNames(schema, [...new Set(groups.map((g) => g.third_party_id))], transaction);
  const rows = groups.map((g) => ({
    branch_id: g.branch_id,
    third_party_id: g.third_party_id,
    third_party_name: g.third_party_id ? (names[g.third_party_id] || g.third_party_id) : null,
    lines_count: g.lines_count,
    debit: round2(g.debit),
    credit: round2(g.credit),
    net: round2(Number(g.debit) - Number(g.credit)),
  }));

  const warnings = [];
  if (from.account_type !== to.account_type) {
    warnings.push(`Las cuentas son de distinta naturaleza (${from.account_type} → ${to.account_type}). Verifique que la reclasificación sea correcta.`);
  }
  if (mode === 'direct' && closedPeriods.length) {
    warnings.push(`Hay movimientos en períodos cerrados (${closedPeriods.map((p) => `${p.month}/${p.year}`).join(', ')}). La migración directa no está permitida; use reclasificación o reabra los períodos.`);
  }

  return {
    mode,
    from_account: { id: from.id, code: from.code, name: from.name, account_type: from.account_type },
    to_account: { id: to.id, code: to.code, name: to.name, account_type: to.account_type },
    rows,
    totals: {
      lines_count: rows.reduce((s, r) => s + r.lines_count, 0),
      debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
      credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
      net: round2(rows.reduce((s, r) => s + r.net, 0)),
    },
    closed_periods: closedPeriods,
    mappings: mappings.map((m) => m.event_type),
    warnings,
    can_execute: rows.length > 0 && !(mode === 'direct' && closedPeriods.length > 0),
  };
}

async function repointMappings(tenantId, fromAccountId, toAccountId, userId, transaction) {
  const { AccountMapping, AccountMappingAudit } = require('../../models');
  const mappings = await AccountMapping.findAll({ where: { tenant_id: tenantId, account_id: fromAccountId }, transaction });
  for (const m of mappings) {
    await m.update({ account_id: toAccountId }, { transaction });
    await AccountMappingAudit.create({
      tenant_id: tenantId,
      event_type: m.event_type,
      previous_account_id: fromAccountId,
      new_account_id: toAccountId,
      changed_by: userId || null,
    }, { transaction });
  }
  return mappings.map((m) => m.event_type);
}

/**
 * Ejecuta la migración. Devuelve el registro de bitácora (AccountMigration).
 */
async function executeMigration(tenantId, params, userId) {
  const { AccountMigration, JournalEntry } = require('../../models');
  const { mode = 'reclassification', fromAccountId, toAccountId, dateFrom, dateTo, thirdPartyId, branchId, reason, updateMappings } = params;
  if (!reason || !String(reason).trim()) throw badRequest('El motivo es obligatorio');

  const t = await sequelize.transaction();
  try {
    const preview = await previewMigration(tenantId, params, t);
    if (!preview.rows.length) throw badRequest('No hay movimientos para migrar con esos filtros');
    if (mode === 'direct' && preview.closed_periods.length) throw badRequest(preview.warnings[preview.warnings.length - 1]);

    const schema = getCurrentSchema() || 'public';
    const from = preview.from_account;
    const to = preview.to_account;
    let lineIds = [];
    const entryIds = [];

    if (mode === 'direct') {
      const rows = await sequelize.query(
        `UPDATE "${schema}"."journal_entry_lines" AS l
         SET account_id = :toAccountId
         FROM "${schema}"."journal_entries" e
         WHERE e.id = l.entry_id AND ${linesWhere({ mode, thirdPartyId, branchId })}
         RETURNING l.id`,
        {
          replacements: { tenantId, fromAccountId, toAccountId, dateFrom, dateTo, thirdPartyId: thirdPartyId || null, branchId: branchId || null },
          type: QueryTypes.SELECT,
          transaction: t,
        }
      );
      lineIds = rows.map((r) => r.id);
    } else {
      // Un asiento por sede (el branch_id va en la cabecera), una pareja de
      // líneas por tercero con saldo neto distinto de cero.
      const entryDate = params.entryDate || dateTo;
      const byBranch = new Map();
      for (const r of preview.rows) {
        if (Math.abs(r.net) < 0.01) continue;
        const key = r.branch_id || '';
        if (!byBranch.has(key)) byBranch.set(key, []);
        const tp = r.third_party_id || null;
        const amount = Math.abs(r.net);
        // Saldo débito en origen: se acredita origen y se debita destino; al revés si es crédito.
        const isDebit = r.net > 0;
        byBranch.get(key).push(
          { account_id: from.id, debit: isDebit ? 0 : amount, credit: isDebit ? amount : 0, description: `Reclasificación a ${to.code}`, third_party_id: tp },
          { account_id: to.id, debit: isDebit ? amount : 0, credit: isDebit ? 0 : amount, description: `Reclasificación desde ${from.code}`, third_party_id: tp },
        );
      }
      if (!byBranch.size) throw badRequest('El saldo neto de los movimientos es cero: no hay nada que reclasificar');

      for (const [branch, lines] of byBranch) {
        const entry = await createDraftEntry(tenantId, {
          branchId: branch || null,
          entryDate,
          sourceType: 'reclassification',
          sourceId: null,
          description: `Reclasificación ${from.code} → ${to.code} (${dateFrom} a ${dateTo}) — ${reason}`.slice(0, 500),
          lines,
          createdBy: userId,
        }, t);
        await JournalEntry.update(
          { status: 'posted', posted_by: userId || null, posted_at: new Date() },
          { where: { id: entry.id }, transaction: t }
        );
        entryIds.push(entry.id);
      }
    }

    const mappingsUpdated = updateMappings ? await repointMappings(tenantId, from.id, to.id, userId, t) : [];

    const log = await AccountMigration.create({
      tenant_id: tenantId,
      mode,
      from_account_id: from.id,
      to_account_id: to.id,
      date_from: dateFrom,
      date_to: dateTo,
      filters: { third_party_id: thirdPartyId || null, branch_id: branchId || null, entry_date: mode === 'reclassification' ? (params.entryDate || dateTo) : null },
      lines_count: preview.totals.lines_count,
      total_debit: preview.totals.debit,
      total_credit: preview.totals.credit,
      line_ids: lineIds,
      entry_ids: entryIds,
      mappings_updated: mappingsUpdated,
      reason,
      created_by: userId || null,
    }, { transaction: t });

    // En modo reclassification, el asiento queda enlazado a su bitácora.
    if (entryIds.length) {
      await JournalEntry.update({ source_id: log.id }, { where: { id: entryIds }, transaction: t });
    }

    await t.commit();
    return log;
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

module.exports = { MODES, previewMigration, executeMigration };
