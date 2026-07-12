// backend/src/services/accounting/fiscalPeriod.service.js
//
// El modelo FiscalPeriod y createDraftEntry (journalEntry.service.js) ya
// validaban status === 'closed' desde el principio, pero no existía forma
// de llegar a ese estado. Este servicio agrega el flujo de cierre/reapertura
// que faltaba, con las validaciones mínimas que un cierre contable real
// necesita:
//
//  1. No se puede cerrar un período que tiene asientos en 'draft' sin
//     revisar — si se cierra igual, esos borradores quedan huérfanos para
//     siempre (no se pueden postear en un período cerrado).
//  2. No se puede cerrar un período cuyos asientos posteados no cuadran
//     (reutiliza el mismo chequeo que ya existe para integridad contable).
//  3. Reabrir un período cerrado es una acción excepcional: exige motivo y
//     queda registrada aparte del cierre original (no se sobreescribe
//     closed_at/closed_by).

const { validateTrialBalanceConsistency } = require('./journalIntegrity.service');

function monthRange(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate(); // día 0 del mes siguiente = último día del mes actual
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

/**
 * Cierra un período fiscal. A partir de este momento, createDraftEntry
 * rechaza cualquier asiento nuevo con entry_date dentro de ese período.
 */
async function closePeriod(periodId, tenantId, userId) {
  const { FiscalPeriod, JournalEntry } = require('../../models');

  const period = await FiscalPeriod.findOne({ where: { id: periodId, tenant_id: tenantId } });
  if (!period) throw new Error('Período fiscal no encontrado');
  if (period.status === 'closed') throw new Error(`El período ${period.month}/${period.year} ya está cerrado`);

  // 1. Sin borradores pendientes de revisión
  const pendingDrafts = await JournalEntry.count({
    where: { tenant_id: tenantId, period_id: period.id, status: 'draft' },
  });
  if (pendingDrafts > 0) {
    throw new Error(
      `No se puede cerrar: hay ${pendingDrafts} asiento(s) en borrador sin revisar en ${period.month}/${period.year}. ` +
      `Postéalos o anúlalos antes de cerrar el período.`
    );
  }

  // 2. Asientos posteados del período deben cuadrar (red de seguridad, no
  //    debería fallar nunca si createDraftEntry hizo bien su trabajo — pero
  //    un cierre es el punto natural para confirmarlo antes de sellar el mes)
  const { from, to } = monthRange(period.year, period.month);
  const consistency = await validateTrialBalanceConsistency(tenantId, { from, to });
  if (!consistency.is_consistent) {
    throw new Error(
      `No se puede cerrar: ${consistency.total_inconsistent} asiento(s) del período no cuadran o tienen ` +
      `inconsistencias entre su cabecera y sus líneas. Revisa el reporte de integridad contable antes de cerrar.`
    );
  }

  await period.update({ status: 'closed', closed_at: new Date(), closed_by: userId || null });
  return period;
}

/**
 * Reabre un período cerrado. Acción excepcional — exige motivo explícito y
 * se registra por separado de los datos del cierre original (para que quede
 * trazado que el período se cerró, se reabrió, y por qué).
 */
async function reopenPeriod(periodId, tenantId, userId, reason) {
  const { FiscalPeriod } = require('../../models');

  if (!reason || !reason.trim()) {
    throw new Error('Reabrir un período cerrado requiere un motivo');
  }

  const period = await FiscalPeriod.findOne({ where: { id: periodId, tenant_id: tenantId } });
  if (!period) throw new Error('Período fiscal no encontrado');
  if (period.status !== 'closed') throw new Error('Solo se pueden reabrir períodos cerrados');

  await period.update({
    status: 'open',
    reopened_at: new Date(),
    reopened_by: userId || null,
    reopen_reason: reason,
  });
  return period;
}

/**
 * Lista los períodos fiscales de un tenant, más recientes primero.
 */
async function listPeriods(tenantId, { year } = {}) {
  const { FiscalPeriod } = require('../../models');
  const where = { tenant_id: tenantId };
  if (year) where.year = year;
  return FiscalPeriod.findAll({ where, order: [['year', 'DESC'], ['month', 'DESC']] });
}

/**
 * Cierre de ejercicio (año completo). Resuelve el hallazgo 3.3 del análisis
 * contable: hoy la utilidad del período se calcula "al vuelo" en el Balance
 * General (resultado_no_cerrado) pero nunca se traslada a una cuenta real
 * de patrimonio — no hay forma de "congelar" oficialmente un año cerrado.
 *
 * Qué hace, en orden:
 *  1. Cierra enero-noviembre del año si todavía no lo están (reutiliza
 *     closePeriod, con sus mismas validaciones de borradores/descuadres —
 *     si algún mes tiene problemas, el error ya indica cuál).
 *  2. Corre las mismas validaciones sobre diciembre, pero SIN cerrarlo
 *     todavía (se necesita abierto para poder postear el asiento de cierre
 *     fechado el 31 de diciembre).
 *  3. Si el año anterior ya había dejado un saldo en "Utilidad del
 *     Ejercicio" (360505), lo reclasifica a "Utilidades Acumuladas"
 *     (370505) — así 360505 siempre refleja solo el año que se cierra ahora.
 *  4. Calcula el saldo acumulado de cada cuenta de ingreso/gasto/costo
 *     (histórico completo: si los años anteriores ya se cerraron, su
 *     aporte ya está en cero, así que lo que queda es el resultado real
 *     del año que se está cerrando) y genera las líneas que las dejan en
 *     cero, con la contrapartida en "Utilidad del Ejercicio".
 *  5. Postea el asiento de cierre de inmediato (no queda en borrador: es
 *     una operación mecánica de cierre, no un asiento que necesite revisión
 *     humana adicional) y recién ahí cierra diciembre.
 *
 * Si el año ya fue cerrado antes (diciembre ya está 'closed'), lanza error
 * — hay que reabrir diciembre explícitamente (con motivo) para reintentar.
 *
 * @returns {Promise<{ entry: object|null, december: object }>} entry es
 *   null si no había nada que cerrar (año sin ningún movimiento contable).
 */
async function closeFiscalYear(tenantId, year, userId) {
  const { FiscalPeriod, JournalEntry } = require('../../models');
  const { QueryTypes } = require('sequelize');
  const { sequelize } = require('../../config/database');
  const { createDraftEntry, postEntry, getMappedAccountId } = require('./journalEntry.service');

  // 1. Diciembre debe existir y estar abierto.
  let december = await FiscalPeriod.findOne({ where: { tenant_id: tenantId, year, month: 12 } });
  if (!december) {
    december = await FiscalPeriod.create({ tenant_id: tenantId, year, month: 12, status: 'open' });
  }
  if (december.status === 'closed') {
    throw new Error(
      `El ejercicio ${year} ya está cerrado (diciembre ${year} está cerrado). ` +
      `Si necesitas corregir algo, reabre diciembre primero con un motivo explícito y vuelve a intentar.`
    );
  }

  // 2. Cierra enero-noviembre si no lo están, reusando las validaciones de closePeriod.
  for (let month = 1; month <= 11; month++) {
    let period = await FiscalPeriod.findOne({ where: { tenant_id: tenantId, year, month } });
    if (!period) {
      period = await FiscalPeriod.create({ tenant_id: tenantId, year, month, status: 'open' });
    }
    if (period.status !== 'closed') {
      await closePeriod(period.id, tenantId, userId); // si falla, el mensaje ya indica mes/motivo
    }
  }

  // 3. Diciembre pasa las mismas validaciones, pero sin cerrarse todavía.
  const pendingDrafts = await JournalEntry.count({ where: { tenant_id: tenantId, period_id: december.id, status: 'draft' } });
  if (pendingDrafts > 0) {
    throw new Error(
      `No se puede cerrar el ejercicio ${year}: hay ${pendingDrafts} asiento(s) en borrador sin revisar en diciembre. ` +
      `Postéalos o anúlalos antes de cerrar.`
    );
  }
  const { from, to } = monthRange(year, 12);
  const consistency = await validateTrialBalanceConsistency(tenantId, { from, to });
  if (!consistency.is_consistent) {
    throw new Error(
      `No se puede cerrar el ejercicio ${year}: ${consistency.total_inconsistent} asiento(s) de diciembre no cuadran o tienen inconsistencias.`
    );
  }

  const closeDate = `${year}-12-31`;
  const t = await sequelize.transaction();
  try {
    const currentYearResultAccountId = await getMappedAccountId(tenantId, 'year_end_result', t);
    const accumulatedResultAccountId = await getMappedAccountId(tenantId, 'year_end_accumulated', t);

    const lines = [];

    // 3. Reclasifica el saldo que haya quedado de un cierre anterior.
    const [[priorResult]] = await sequelize.query(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS balance
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.tenant_id = :tenantId AND e.status = 'posted'
         AND l.account_id = :accountId AND e.entry_date < :closeDate`,
      { replacements: { tenantId, accountId: currentYearResultAccountId, closeDate }, type: QueryTypes.SELECT, transaction: t }
    );
    const priorBalance = Number(priorResult.balance);
    if (Math.abs(priorBalance) > 0.01) {
      if (priorBalance > 0) {
        lines.push({ account_id: currentYearResultAccountId, debit: priorBalance, credit: 0, description: 'Traslado de utilidad de ejercicios anteriores' });
        lines.push({ account_id: accumulatedResultAccountId, debit: 0, credit: priorBalance, description: 'Utilidades acumuladas de ejercicios anteriores' });
      } else {
        const loss = Math.abs(priorBalance);
        lines.push({ account_id: accumulatedResultAccountId, debit: loss, credit: 0, description: 'Traslado de pérdida de ejercicios anteriores' });
        lines.push({ account_id: currentYearResultAccountId, debit: 0, credit: loss, description: 'Reclasificación de pérdida de ejercicios anteriores' });
      }
    }

    // 4. Cierra ingreso/gasto/costo del año (histórico acumulado; si los años
    //    anteriores ya se cerraron, lo que queda es solo el resultado de este año).
    const nominalRows = await sequelize.query(
      `SELECT a.id AS account_id, a.account_type,
              COALESCE(SUM(l.debit), 0) AS total_debit,
              COALESCE(SUM(l.credit), 0) AS total_credit
       FROM chart_of_accounts a
       JOIN journal_entry_lines l ON l.account_id = a.id
       JOIN journal_entries e ON e.id = l.entry_id
       WHERE a.tenant_id = :tenantId AND e.status = 'posted' AND e.entry_date <= :closeDate
         AND a.account_type IN ('ingreso', 'gasto', 'costo')
       GROUP BY a.id, a.account_type
       HAVING COALESCE(SUM(l.debit), 0) <> COALESCE(SUM(l.credit), 0)`,
      { replacements: { tenantId, closeDate }, type: QueryTypes.SELECT, transaction: t }
    );

    let resultNet = 0; // ingresos - (gastos + costos)
    for (const row of nominalRows) {
      const totalDebit = Number(row.total_debit);
      const totalCredit = Number(row.total_credit);
      if (row.account_type === 'ingreso') {
        const netCredit = totalCredit - totalDebit;
        if (netCredit > 0) {
          lines.push({ account_id: row.account_id, debit: netCredit, credit: 0, description: `Cierre de ingresos del ejercicio ${year}` });
          resultNet += netCredit;
        } else if (netCredit < 0) {
          lines.push({ account_id: row.account_id, debit: 0, credit: -netCredit, description: `Cierre de ingresos del ejercicio ${year}` });
          resultNet += netCredit;
        }
      } else {
        // 'gasto' o 'costo'
        const netDebit = totalDebit - totalCredit;
        if (netDebit > 0) {
          lines.push({ account_id: row.account_id, debit: 0, credit: netDebit, description: `Cierre de gastos/costos del ejercicio ${year}` });
          resultNet -= netDebit;
        } else if (netDebit < 0) {
          lines.push({ account_id: row.account_id, debit: -netDebit, credit: 0, description: `Cierre de gastos/costos del ejercicio ${year}` });
          resultNet += netDebit;
        }
      }
    }

    if (Math.abs(resultNet) > 0.01) {
      if (resultNet > 0) {
        lines.push({ account_id: currentYearResultAccountId, debit: 0, credit: resultNet, description: `Utilidad del ejercicio ${year}` });
      } else {
        lines.push({ account_id: currentYearResultAccountId, debit: Math.abs(resultNet), credit: 0, description: `Pérdida del ejercicio ${year}` });
      }
    }

    let entry = null;
    if (lines.length >= 2) {
      entry = await createDraftEntry(
        tenantId,
        {
          branchId: null, // el cierre de ejercicio consolida todas las sedes del tenant
          entryDate: closeDate,
          sourceType: 'year_end_close',
          sourceId: null,
          description: `Cierre del ejercicio ${year}`,
          lines,
          createdBy: userId,
        },
        t
      );
    }

    await t.commit();

    // postEntry no acepta transacción propia — se llama DESPUÉS del commit,
    // una vez que el asiento en borrador ya es visible fuera de `t`.
    if (entry) {
      entry = await postEntry(entry.id, tenantId, userId);
    }

    // 5. Ya con el asiento posteado, cierra diciembre (reusa closePeriod).
    await closePeriod(december.id, tenantId, userId);

    return { entry, december };
  } catch (error) {
    if (!t.finished) await t.rollback();
    throw error;
  }
}

module.exports = { closePeriod, reopenPeriod, listPeriods, closeFiscalYear, monthRange };
