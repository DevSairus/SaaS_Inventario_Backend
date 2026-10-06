// backend/src/services/tax/ica.service.js
//
// Impuesto de Industria y Comercio (ICA) por municipio.
//
// El ICA lo paga el contribuyente sobre sus ingresos brutos en cada
// municipio; NO se le cobra al cliente en la factura (antes Pitbox lo sumaba
// al total y lo llevaba a la cuenta de IVA -- se quitó en taxService).
//
// Base gravable: se toma de la contabilidad (asientos contabilizados) para
// que ya incluya devoluciones, notas crédito y anulaciones:
//   ingresos netos (crédito - débito) de las cuentas tipo 'ingreso' del
//   período, de las sedes que declaran en ese municipio, sin el asiento de
//   cierre de año y sin los prefijos excluidos del municipio (p.ej. 4210
//   financieros). Cada cuenta se asigna a la actividad CIIU cuyo prefijo
//   coincida (el más largo); si ninguna coincide, a la actividad por defecto.
//
// Liquidación:
//   ICA = Σ base × tarifa‰         Avisos y tableros = ICA × avisos_pct%
//   Bomberil = ICA × bomberil_pct%  Total impuesto = ICA + avisos + bomberil
//   Saldo = Total impuesto − ReteICA que le practicaron − autorretenciones
//
// Sedes → municipio: branches.ica_municipality_id. Si el tenant tiene UN solo
// municipio activo, todas las sedes (y los asientos sin sede) declaran allí.
// Con varios, los asientos sin sede van al municipio de la sede principal.
//
// Contabilidad (mapeos en accountingSeed.service.js#ensureIcaMappings):
//   Autorretención (kind 'autoica', source_type 'ica_autoretention'):
//     D autoica_receivable (135518)  /  C autoica_payable (236810)
//   Causación del período (kind 'ica', source_type 'ica_settlement'):
//     D ica_expense (511505) por el total del impuesto
//     C sale_reteica_receivable (135518) por la ReteICA recibida, por tercero
//     C autoica_receivable (135518) por las autorretenciones del período
//     C ica_payable (241205) por el saldo a pagar (o D si queda a favor)
const { QueryTypes, Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { createDraftEntry, getMappedAccountId, reverseEntry } = require('../accounting/journalEntry.service');

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
// Ningún UUID real: deja un IN (...) válido cuando no hay sedes asignadas.
const NO_BRANCH = '00000000-0000-0000-0000-000000000000';

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function loadMunicipality(tenantId, municipalityId, transaction) {
  const { IcaMunicipality, IcaActivity } = require('../../models');
  const mun = await IcaMunicipality.findOne({
    where: { id: municipalityId, tenant_id: tenantId },
    include: [{ model: IcaActivity, as: 'activities' }],
    transaction,
  });
  if (!mun) throw badRequest('Municipio no encontrado');
  return mun;
}

/**
 * Filtro SQL de sedes que declaran en el municipio.
 */
async function branchScope(tenantId, mun, transaction) {
  const { IcaMunicipality, Branch } = require('../../models');
  const activeCount = await IcaMunicipality.count({ where: { tenant_id: tenantId, is_active: true }, transaction });
  if (activeCount <= 1) return { sql: '', replacements: {}, label: 'Todas las sedes' };

  const branches = await Branch.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'name', 'is_main', 'ica_municipality_id'], transaction });
  const mine = branches.filter((b) => b.ica_municipality_id === mun.id);
  const main = branches.find((b) => b.is_main);
  const includeUnassigned = !!main && main.ica_municipality_id === mun.id;
  return {
    sql: ` AND (e.branch_id IN (:branchIds)${includeUnassigned ? ' OR e.branch_id IS NULL' : ''})`,
    replacements: { branchIds: mine.length ? mine.map((b) => b.id) : [NO_BRANCH] },
    label: mine.length ? mine.map((b) => b.name).join(', ') : 'Ninguna sede asignada',
  };
}

function matchActivity(code, activities) {
  let best = null;
  let bestLen = -1;
  for (const act of activities) {
    for (const prefix of act.account_prefixes || []) {
      const p = String(prefix).trim();
      if (p && code.startsWith(p) && p.length > bestLen) { best = act; bestLen = p.length; }
    }
  }
  return best || activities.find((a) => a.is_default) || null;
}

async function mappedAccountOrNull(tenantId, eventType, transaction) {
  try { return await getMappedAccountId(tenantId, eventType, transaction); } catch { return null; }
}

/**
 * Pre-liquidación del ICA (y de la ReteICA a declarar) de un municipio y
 * período. No escribe nada.
 */
async function computeIcaReport(tenantId, { municipalityId, dateFrom, dateTo }, transaction) {
  if (!dateFrom || !dateTo || dateFrom > dateTo) throw badRequest('Rango de fechas inválido');
  const { IcaSettlement } = require('../../models');
  const mun = await loadMunicipality(tenantId, municipalityId, transaction);
  const activities = mun.activities || [];
  if (!activities.length) throw badRequest(`Configure al menos una actividad (CIIU y tarifa) para ${mun.city_name}`);

  const schema = getCurrentSchema() || 'public';
  const scope = await branchScope(tenantId, mun, transaction);
  const repl = { tenantId, dateFrom, dateTo, ...scope.replacements };
  const periodWhere = `e.tenant_id = :tenantId AND e.status = 'posted' AND e.entry_date BETWEEN :dateFrom AND :dateTo${scope.sql}`;

  // ── Base gravable por cuenta de ingreso ──
  const incomeRows = await sequelize.query(
    `SELECT a.code, a.name, COALESCE(SUM(l.credit - l.debit), 0) AS net
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     JOIN "${schema}"."chart_of_accounts" a ON a.id = l.account_id
     WHERE ${periodWhere} AND a.account_type = 'ingreso' AND e.source_type <> 'year_end_close'
     GROUP BY a.code, a.name
     ORDER BY a.code`,
    { replacements: repl, type: QueryTypes.SELECT, transaction }
  );

  const excluded = (mun.excluded_account_prefixes || []).map((p) => String(p).trim()).filter(Boolean);
  const byActivity = new Map(activities.map((a) => [a.id, { activity: a, base: 0, accounts: [] }]));
  const excludedAccounts = [];
  const unassigned = [];
  for (const r of incomeRows) {
    const net = round2(r.net);
    if (!net) continue;
    if (excluded.some((p) => r.code.startsWith(p))) { excludedAccounts.push({ code: r.code, name: r.name, amount: net }); continue; }
    const act = matchActivity(r.code, activities);
    if (!act) { unassigned.push({ code: r.code, name: r.name, amount: net }); continue; }
    const bucket = byActivity.get(act.id);
    bucket.base = round2(bucket.base + net);
    bucket.accounts.push({ code: r.code, name: r.name, amount: net });
  }

  const activityRows = [...byActivity.values()].map(({ activity: a, base, accounts }) => {
    const rate = Number(a.rate || 0);
    const autoRate = a.autoica_rate != null ? Number(a.autoica_rate) : rate;
    return {
      activity_id: a.id, ciiu_code: a.ciiu_code, description: a.description, rate, autoica_rate: autoRate,
      base: round2(Math.max(base, 0)), accounts,
      ica: round2(Math.max(base, 0) * rate / 1000),
      autoica: round2(Math.max(base, 0) * autoRate / 1000),
    };
  });

  // Los formularios municipales se diligencian en múltiplos de mil: con
  // round_thousands cada renglón se aproxima al mil más cercano.
  const rnd = (v) => (mun.round_thousands ? Math.round(v / 1000) * 1000 : round2(v));
  const icaExact = activityRows.reduce((s, a) => s + a.ica, 0);
  const base = rnd(activityRows.reduce((s, a) => s + a.base, 0));
  const ica = rnd(icaExact);
  const avisos = mun.avisos_tableros ? rnd(icaExact * Number(mun.avisos_pct || 0) / 100) : 0;
  const bomberil = rnd(icaExact * Number(mun.bomberil_pct || 0) / 100);
  const totalTax = round2(ica + avisos + bomberil);

  // ── ReteICA que le practicaron (registrada en cartera), por tercero ──
  const reteicaAccount = await mappedAccountOrNull(tenantId, 'sale_reteica_receivable', transaction);
  const retentionRows = reteicaAccount ? await sequelize.query(
    `SELECT l.third_party_id, COALESCE(SUM(l.debit - l.credit), 0) AS amount
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE ${periodWhere} AND l.account_id = :reteicaAccount
       AND e.source_type NOT IN ('ica_settlement', 'ica_autoretention')
     GROUP BY l.third_party_id`,
    { replacements: { ...repl, reteicaAccount }, type: QueryTypes.SELECT, transaction }
  ) : [];
  const retentions = retentionRows.map((r) => ({ third_party_id: r.third_party_id, amount: round2(r.amount) })).filter((r) => r.amount > 0);
  const retentionsTotal = round2(retentions.reduce((s, r) => s + r.amount, 0));

  // ── Autorretenciones causadas en el período ──
  const autoSettlements = await IcaSettlement.findAll({
    where: { tenant_id: tenantId, municipality_id: mun.id, kind: 'autoica', status: 'causado', date_from: { [Op.gte]: dateFrom }, date_to: { [Op.lte]: dateTo } },
    transaction,
  });
  const autoicaCaused = round2(autoSettlements.reduce((s, x) => s + Number(x.tax_amount), 0));
  const autoicaExpected = mun.autoica_enabled ? round2(activityRows.reduce((s, a) => s + a.autoica, 0)) : 0;

  // ── ReteICA practicada a proveedores (para la declaración de ReteICA) ──
  const payableAccounts = (await Promise.all(['purchase_reteica_payable', 'expense_reteica_payable']
    .map((ev) => mappedAccountOrNull(tenantId, ev, transaction)))).filter(Boolean);
  let reteicaPracticed = 0;
  if (payableAccounts.length) {
    const [row] = await sequelize.query(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS amount
       FROM "${schema}"."journal_entry_lines" l
       JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
       WHERE ${periodWhere} AND l.account_id IN (:payableAccounts)`,
      { replacements: { ...repl, payableAccounts: [...new Set(payableAccounts)] }, type: QueryTypes.SELECT, transaction }
    );
    reteicaPracticed = round2(row.amount);
  }

  const settlements = await IcaSettlement.findAll({
    where: {
      tenant_id: tenantId, municipality_id: mun.id, status: 'causado',
      date_from: { [Op.lte]: dateTo }, date_to: { [Op.gte]: dateFrom },
    },
    order: [['created_at', 'DESC']],
    transaction,
  });

  // Los reportes contables solo cuentan asientos contabilizados: se avisa si
  // hay borradores con ingresos en el período (quedarían fuera de la base).
  const [draftRow] = await sequelize.query(
    `SELECT COUNT(DISTINCT e.id)::int AS n
     FROM "${schema}"."journal_entries" e
     JOIN "${schema}"."journal_entry_lines" l ON l.entry_id = e.id
     JOIN "${schema}"."chart_of_accounts" a ON a.id = l.account_id
     WHERE ${periodWhere.replace("e.status = 'posted'", "e.status = 'draft'")} AND a.account_type = 'ingreso'`,
    { replacements: repl, type: QueryTypes.SELECT, transaction }
  );

  // credits: valores exactos (los que se cruzan contra 135518).
  // balance: saldo del formulario, con las retenciones también redondeadas.
  const credits = round2(retentionsTotal + autoicaCaused);
  const balance = round2(totalTax - rnd(retentionsTotal) - rnd(autoicaCaused));
  return {
    municipality: {
      id: mun.id, city_name: mun.city_name, city_code: mun.city_code, periodicity: mun.periodicity,
      avisos_tableros: mun.avisos_tableros, avisos_pct: Number(mun.avisos_pct), bomberil_pct: Number(mun.bomberil_pct),
      autoica_enabled: mun.autoica_enabled,
    },
    date_from: dateFrom,
    date_to: dateTo,
    branches: scope.label,
    draft_income_entries: draftRow.n,
    activities: activityRows,
    excluded_accounts: excludedAccounts,
    unassigned_accounts: unassigned,
    totals: {
      base, ica, avisos, bomberil, total_tax: totalTax,
      retentions: retentionsTotal, autoica: autoicaCaused, credits,
      balance,
      // Diferencia por redondeo que absorbe el gasto del ICA, para que el
      // pasivo quede igual al valor a pagar del formulario.
      rounding_adjustment: round2(credits + balance - totalTax),
    },
    retentions,
    autoica_expected: autoicaExpected,
    autoica_pending: round2(Math.max(autoicaExpected - autoicaCaused, 0)),
    reteica_declaration: {
      practiced: reteicaPracticed,
      autoica: autoicaCaused,
      total: rnd(reteicaPracticed + autoicaCaused),
    },
    settlements: settlements.map((s) => ({ id: s.id, kind: s.kind, date_from: s.date_from, date_to: s.date_to, tax_amount: Number(s.tax_amount), entry_id: s.entry_id })),
  };
}

async function assertNoOverlap(tenantId, municipalityId, kind, dateFrom, dateTo, transaction) {
  const { IcaSettlement } = require('../../models');
  const overlap = await IcaSettlement.findOne({
    where: {
      tenant_id: tenantId, municipality_id: municipalityId, kind, status: 'causado',
      date_from: { [Op.lte]: dateTo }, date_to: { [Op.gte]: dateFrom },
    },
    transaction,
  });
  if (overlap) {
    throw badRequest(`Ya hay una ${kind === 'ica' ? 'causación de ICA' : 'autorretención'} contabilizada que cruza el período (${overlap.date_from} a ${overlap.date_to}). Anúlela primero si necesita rehacerla.`);
  }
}

async function postEntry(entry, userId, transaction) {
  const { JournalEntry } = require('../../models');
  await JournalEntry.update(
    { status: 'posted', posted_by: userId || null, posted_at: new Date() },
    { where: { id: entry.id }, transaction }
  );
}

/**
 * Causa la autorretención de ICA del período (municipios que la exigen).
 */
async function causeAutoIca(tenantId, params, userId) {
  const { IcaSettlement } = require('../../models');
  const t = await sequelize.transaction();
  try {
    const report = await computeIcaReport(tenantId, params, t);
    if (!report.municipality.autoica_enabled) throw badRequest(`${report.municipality.city_name} no tiene autorretención de ICA habilitada`);
    await assertNoOverlap(tenantId, params.municipalityId, 'autoica', params.dateFrom, params.dateTo, t);
    const amount = report.autoica_expected;
    if (!(amount > 0)) throw badRequest('No hay base para autorretención en el período');

    const settlement = await IcaSettlement.create({
      tenant_id: tenantId, municipality_id: params.municipalityId, kind: 'autoica',
      date_from: params.dateFrom, date_to: params.dateTo,
      base_amount: report.totals.base, tax_amount: amount, balance_amount: amount,
      detail: { activities: report.activities.map(({ accounts, ...a }) => a) },
      created_by: userId || null,
    }, { transaction: t });

    const entry = await createDraftEntry(tenantId, {
      branchId: null,
      entryDate: params.dateTo,
      sourceType: 'ica_autoretention',
      sourceId: settlement.id,
      description: `Autorretención ICA ${report.municipality.city_name} ${params.dateFrom} a ${params.dateTo}`,
      lines: [
        { account_id: await getMappedAccountId(tenantId, 'autoica_receivable', t), debit: amount, credit: 0, description: 'Autorretención de ICA' },
        { account_id: await getMappedAccountId(tenantId, 'autoica_payable', t), debit: 0, credit: amount, description: 'Autorretención de ICA por pagar' },
      ],
      createdBy: userId,
    }, t);
    await postEntry(entry, userId, t);
    await settlement.update({ entry_id: entry.id }, { transaction: t });

    await t.commit();
    return settlement;
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

/**
 * Causa el ICA del período y cruza retenciones y autorretenciones.
 */
async function causeIca(tenantId, params, userId) {
  const { IcaSettlement } = require('../../models');
  const t = await sequelize.transaction();
  try {
    const report = await computeIcaReport(tenantId, params, t);
    await assertNoOverlap(tenantId, params.municipalityId, 'ica', params.dateFrom, params.dateTo, t);
    const { totals } = report;
    if (!(totals.total_tax > 0)) throw badRequest('El impuesto del período es cero: no hay nada que causar');

    const settlement = await IcaSettlement.create({
      tenant_id: tenantId, municipality_id: params.municipalityId, kind: 'ica',
      date_from: params.dateFrom, date_to: params.dateTo,
      base_amount: totals.base, tax_amount: totals.total_tax, credits_amount: totals.credits, balance_amount: totals.balance,
      detail: {
        totals,
        activities: report.activities.map(({ accounts, ...a }) => a),
        excluded_accounts: report.excluded_accounts,
        unassigned_accounts: report.unassigned_accounts,
      },
      created_by: userId || null,
    }, { transaction: t });

    const city = report.municipality.city_name;
    const lines = [
      // total_tax + ajuste al mil: así el pasivo queda en el valor del formulario.
      { account_id: await getMappedAccountId(tenantId, 'ica_expense', t), debit: round2(totals.total_tax + totals.rounding_adjustment), credit: 0, description: `ICA ${city} (incluye avisos y bomberil)` },
    ];
    if (report.retentions.length) {
      const reteicaAccount = await getMappedAccountId(tenantId, 'sale_reteica_receivable', t);
      for (const r of report.retentions) {
        lines.push({ account_id: reteicaAccount, debit: 0, credit: r.amount, description: 'Cruce de ReteICA practicada por clientes', third_party_id: r.third_party_id || null });
      }
    }
    if (totals.autoica > 0) {
      lines.push({ account_id: await getMappedAccountId(tenantId, 'autoica_receivable', t), debit: 0, credit: totals.autoica, description: 'Cruce de autorretenciones de ICA' });
    }
    const payable = await getMappedAccountId(tenantId, 'ica_payable', t);
    if (totals.balance > 0) lines.push({ account_id: payable, debit: 0, credit: totals.balance, description: `ICA por pagar ${city}` });
    else if (totals.balance < 0) lines.push({ account_id: payable, debit: -totals.balance, credit: 0, description: `Saldo a favor ICA ${city}` });

    const entry = await createDraftEntry(tenantId, {
      branchId: null,
      entryDate: params.dateTo,
      sourceType: 'ica_settlement',
      sourceId: settlement.id,
      description: `Causación ICA ${city} ${params.dateFrom} a ${params.dateTo}`,
      lines,
      createdBy: userId,
    }, t);
    await postEntry(entry, userId, t);
    await settlement.update({ entry_id: entry.id }, { transaction: t });

    await t.commit();
    return settlement;
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

/**
 * Anula una causación: reversa su asiento (contrapartida fechada hoy).
 */
async function voidSettlement(tenantId, settlementId, userId, reason) {
  const { IcaSettlement } = require('../../models');
  if (!reason || !String(reason).trim()) throw badRequest('El motivo es obligatorio');
  const t = await sequelize.transaction();
  try {
    const settlement = await IcaSettlement.findOne({ where: { id: settlementId, tenant_id: tenantId }, lock: t.LOCK.UPDATE, transaction: t });
    if (!settlement) throw badRequest('Causación no encontrada');
    if (settlement.status === 'anulado') throw badRequest('La causación ya está anulada');
    if (settlement.kind === 'autoica') {
      const ica = await IcaSettlement.findOne({
        where: {
          tenant_id: tenantId, municipality_id: settlement.municipality_id, kind: 'ica', status: 'causado',
          date_from: { [Op.lte]: settlement.date_from }, date_to: { [Op.gte]: settlement.date_to },
        },
        transaction: t,
      });
      if (ica) throw badRequest('Esta autorretención ya se cruzó en una causación de ICA: anule primero esa causación');
    }
    if (settlement.entry_id) await reverseEntry(settlement.entry_id, tenantId, userId, reason, t);
    await settlement.update({ status: 'anulado', voided_by: userId || null, voided_at: new Date(), void_reason: reason }, { transaction: t });
    await t.commit();
    return settlement;
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

module.exports = { computeIcaReport, causeIca, causeAutoIca, voidSettlement, matchActivity };
