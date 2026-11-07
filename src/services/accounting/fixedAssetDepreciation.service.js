// backend/src/services/accounting/fixedAssetDepreciation.service.js
//
// Cálculo y generación de depreciación mensual de Activos Fijos (línea
// recta, con prorrateo del primer mes según el día de compra). Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md — Fase 1.
//
// El job mensual (jobs/scheduler.js, "fixed-asset-depreciation") procesa el
// mes calendario recién cerrado, no el mes en curso: corre el día 1 a las
// 4:00am hora Colombia, momento en el que el mes anterior ya transcurrió
// por completo y puede depreciarse en firme. `runDepreciationForTenant` es
// además naturalmente "catch-up": si el job no corrió uno o varios meses
// (caída del proceso, tenant creado fuera de horario, etc.), procesa todos
// los períodos pendientes desde el último ya generado hasta el período
// objetivo, en orden, para que `accumulated_after` quede consistente.
//
// Todas las fechas se manejan en UTC a propósito: `acquisition_date` es un
// DATEONLY ('YYYY-MM-DD') y Node lo parsea como medianoche UTC sin importar
// la zona horaria del proceso -- usar getters *locales* (getMonth/getDate)
// sobre esa fecha en un proceso corriendo en America/Bogota (UTC-5) puede
// leer el día/mes anterior. Por eso todo acá usa getUTC*/Date.UTC.
const logger = require('../../config/logger');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function pad2(n) { return String(n).padStart(2, '0'); }

function periodOf(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function previousPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function nextPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// Período recién cerrado — es el que procesa el job automático por defecto.
function lastClosedPeriod() { return previousPeriod(currentPeriod()); }

// 'YYYY-MM' ordena lexicográficamente igual que cronológicamente.
function comparePeriods(a, b) { return a.localeCompare(b); }

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); } // month 1-indexed

function round2(n) { return Math.round(n * 100) / 100; }

function getMonthlyBaseAmount(asset) {
  const base = Number(asset.acquisition_cost) - Number(asset.salvage_value || 0);
  return base / Number(asset.useful_life_months);
}

/**
 * Última fecha calendario de un período 'YYYY-MM' — la depreciación se
 * contabiliza al cierre del mes, no al día 1.
 */
function periodEndDate(period) {
  const [year, month] = period.split('-').map(Number);
  const last = daysInMonth(year, month);
  return `${year}-${pad2(month)}-${pad2(last)}`;
}

/**
 * Monto a depreciar de UN activo en UN período, según su método:
 *
 * - linea_recta: (costo − residual) / vida útil. El mes de compra se
 *   prorratea por días; desde basis_period (saldo inicial, cambio de
 *   estimación o deterioro) la cuota es basis_amount / basis_months.
 * - saldos_decrecientes: doble saldo decreciente sobre el valor en libros
 *   (valor en libros × 2 / vida útil en meses), pasando a línea recta sobre
 *   los meses restantes cuando esta da más, para cerrar exacto en el residual.
 * - unidades_produccion: saldo por depreciar × uso del mes / unidades que le
 *   quedan (opts.units = uso del mes; opts.unitsUsedBefore = uso anterior).
 * - menor_cuantia: todo el saldo en el primer mes (≤ 50 UVT).
 * - no_deprecia: nada (terrenos).
 *
 * El mes de la baja se prorratea hasta el día de la baja, y nunca se pasa del
 * saldo por depreciar (costo − residual − depreciación − deterioro).
 */
function computeDepreciationForPeriod(asset, period, accumulatedBefore, opts = {}) {
  const { untilDate = null, impaired = 0, units = 0, unitsUsedBefore = 0 } = opts;
  const method = asset.category === 'terrenos' ? 'no_deprecia' : (asset.depreciation_method || 'linea_recta');
  if (method === 'no_deprecia') return 0;
  const base = round2(Number(asset.acquisition_cost) - Number(asset.salvage_value || 0));
  const remaining = round2(base - Number(accumulatedBefore || 0) - Number(impaired || 0));
  if (remaining <= 0.01) return 0;

  const [year, month] = period.split('-').map(Number);
  const totalDays = daysInMonth(year, month);
  const acqDate = new Date(asset.acquisition_date);
  const isAcquisitionMonth = Number(accumulatedBefore || 0) === 0 && !asset.opening_period
    && acqDate.getUTCFullYear() === year && (acqDate.getUTCMonth() + 1) === month;
  const acquisitionFraction = isAcquisitionMonth ? (totalDays - acqDate.getUTCDate() + 1) / totalDays : 1;
  let amount;

  if (method === 'menor_cuantia') {
    amount = remaining;
  } else if (method === 'unidades_produccion') {
    const unitsLeft = Number(asset.total_units || 0) - Number(unitsUsedBefore || 0);
    if (!(units > 0) || !(unitsLeft > 0)) return 0;
    amount = round2(remaining * Math.min(1, units / unitsLeft));
  } else if (method === 'saldos_decrecientes') {
    const life = Number(asset.useful_life_months);
    const monthsLeft = Math.max(1, life - monthsBetween(periodOf(asset.acquisition_date), period));
    const book = Number(asset.acquisition_cost) - Number(accumulatedBefore || 0) - Number(impaired || 0);
    const declining = book * (2 / life);
    const straight = remaining / monthsLeft;
    amount = round2(Math.max(declining, straight) * acquisitionFraction);
  } else if (asset.basis_period && comparePeriods(period, asset.basis_period) >= 0 && Number(asset.basis_months) > 0) {
    // Hacia adelante (saldo inicial, cambio de estimación o deterioro).
    amount = round2(Number(asset.basis_amount) / Number(asset.basis_months));
  } else {
    amount = round2(getMonthlyBaseAmount(asset) * acquisitionFraction);
  }

  // Mes de la baja o venta: solo hasta el día de la baja (en unidades de
  // producción el uso del mes ya refleja lo trabajado).
  if (untilDate && periodOf(untilDate) === period && method !== 'unidades_produccion' && method !== 'menor_cuantia') {
    const day = new Date(untilDate).getUTCDate();
    amount = round2(amount * (day / totalDays));
  }

  return Math.min(amount, remaining);
}

/** Depreciación acumulada antes de cualquier entrada generada en Pitbox (saldo inicial). */
function openingAccumulated(asset) {
  return asset.opening_period ? Number(asset.opening_accumulated_depreciation || 0) : 0;
}

/** Primer período que deprecia Pitbox: el siguiente al saldo inicial, o el mes de compra. */
function firstPeriodOf(asset) {
  return asset.opening_period ? nextPeriod(asset.opening_period) : periodOf(asset.acquisition_date);
}

/** Meses entre dos períodos 'YYYY-MM' (b − a). */
function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/** Deterioro registrado hasta el fin de un período (o todo, sin período). */
async function impairedUpTo(asset, period = null) {
  const { FixedAssetImpairment } = require('../../models');
  const rows = await FixedAssetImpairment.findAll({ where: { fixed_asset_id: asset.id }, attributes: ['impairment_date', 'amount'] });
  return round2(rows
    .filter((r) => !period || String(r.impairment_date) <= periodEndDate(period))
    .reduce((sum, r) => sum + Number(r.amount), 0));
}

/**
 * Genera (si faltan) las entradas de depreciación de UN activo, desde la
 * siguiente al último período ya generado hasta `targetPeriod` inclusive.
 * En unidades de producción, los meses sin uso registrado no generan nada.
 */
async function processAssetDepreciation(asset, targetPeriod, tenantId, userId, { untilDate = null, catchUp = true } = {}) {
  const { sequelize } = require('../../config/database');
  const { FixedAssetDepreciationEntry, FixedAssetUsage, FixedAssetImpairment } = require('../../models');
  const { generateDepreciationEntry } = require('./autoEntries.service');

  const created = [];
  const method = asset.category === 'terrenos' ? 'no_deprecia' : (asset.depreciation_method || 'linea_recta');
  if (method === 'no_deprecia') return created;

  const lastEntry = await FixedAssetDepreciationEntry.findOne({
    where: { fixed_asset_id: asset.id },
    order: [['period', 'DESC']],
  });

  let accumulatedBefore = lastEntry ? Number(lastEntry.accumulated_after) : openingAccumulated(asset);
  let period = lastEntry ? nextPeriod(lastEntry.period) : firstPeriodOf(asset);

  // Sin ponerse al día (job automático): solo el mes objetivo. Si hay meses
  // anteriores pendientes, no se generan solos: quedan para "Generar
  // depreciación pendiente" o para registrar el saldo inicial del activo.
  if (!catchUp && comparePeriods(period, targetPeriod) < 0) {
    created.pendingFrom = period;
    return created;
  }
  const { assertPeriodOpen } = require('./journalEntry.service');

  const impairments = await FixedAssetImpairment.findAll({ where: { fixed_asset_id: asset.id }, attributes: ['impairment_date', 'amount'] });
  const impairedAt = (p) => round2(impairments.filter((r) => String(r.impairment_date) <= periodEndDate(p)).reduce((s, r) => s + Number(r.amount), 0));
  let usage = new Map();
  let unitsUsedBefore = 0;
  if (method === 'unidades_produccion') {
    const rows = await FixedAssetUsage.findAll({ where: { fixed_asset_id: asset.id }, attributes: ['period', 'units'] });
    usage = new Map(rows.map((r) => [r.period, Number(r.units)]));
    unitsUsedBefore = rows.filter((r) => comparePeriods(r.period, period) < 0).reduce((s, r) => s + Number(r.units), 0);
  }

  while (comparePeriods(period, targetPeriod) <= 0) {
    // Un período contable cerrado ya fue validado: no se le agrega depreciación.
    try {
      await assertPeriodOpen(tenantId, `${periodEndDate(period)}T12:00:00`);
    } catch {
      created.blockedPeriod = period;
      break;
    }
    const units = usage.get(period) || 0;
    const impaired = impairedAt(period);
    const amount = computeDepreciationForPeriod(asset, period, accumulatedBefore, { untilDate, impaired, units, unitsUsedBefore });
    if (method === 'unidades_produccion' && amount <= 0) {
      // Mes sin uso: no se deprecia, se sigue con el siguiente.
      unitsUsedBefore += units;
      period = nextPeriod(period);
      continue;
    }
    if (amount <= 0) break; // ya se depreció por completo

    const pendingBase = round2(Number(asset.acquisition_cost) - Number(asset.salvage_value || 0) - impaired);
    const accumulatedAfter = round2(accumulatedBefore + amount);
    const fullyDepreciated = accumulatedAfter >= pendingBase - 0.01;

    const t = await sequelize.transaction();
    let depEntry;
    try {
      depEntry = await FixedAssetDepreciationEntry.create({
        tenant_id: tenantId,
        fixed_asset_id: asset.id,
        period,
        amount,
        accumulated_after: accumulatedAfter,
        journal_entry_id: null,
      }, { transaction: t });

      if (fullyDepreciated) {
        await asset.update({ status: 'totalmente_depreciado' }, { transaction: t });
      }

      await t.commit();
    } catch (error) {
      await t.rollback();
      // Índice único (fixed_asset_id, period) -- si otra corrida ya generó
      // este período (dos réplicas disparando el mismo cron a la vez, ver
      // advisory lock del scheduler), se detiene acá sin duplicar.
      if (error.name === 'SequelizeUniqueConstraintError') break;
      throw error;
    }

    created.push(depEntry);

    // Asiento contable, fire-and-forget (mismo criterio que el resto del
    // motor): si falta el mapeo de la cuenta de gasto por categoría, la
    // depreciación queda registrada igual (accumulated_after, valor en
    // libros y reporte de activos fijos siguen correctos) -- solo falta el
    // asiento, que se puede regenerar después desde Salud Contable una vez
    // se configure el mapeo faltante.
    try {
      const entry = await generateDepreciationEntry(asset, period, amount, tenantId, userId, { rethrow: true });
      if (entry) await depEntry.update({ journal_entry_id: entry.id });
    } catch (error) {
      logger.warn(`[fixed-assets] No se pudo generar el asiento de depreciación (activo ${asset.id}, período ${period}): ${error.message}`);
    }

    accumulatedBefore = accumulatedAfter;
    unitsUsedBefore += units;
    period = nextPeriod(period);
    if (fullyDepreciated) break;
  }

  return created;
}

/**
 * Corre la depreciación pendiente de todos los activos 'activo' de un
 * tenant, hasta `targetPeriod` (por defecto, el último período cerrado).
 */
async function runDepreciationForTenant(tenantId, { targetPeriod, userId, catchUp = true } = {}) {
  const { FixedAsset } = require('../../models');
  const period = targetPeriod || lastClosedPeriod();

  if (!PERIOD_RE.test(period)) {
    throw new Error(`Período inválido: "${period}" (formato esperado YYYY-MM)`);
  }

  const assets = await FixedAsset.findAll({ where: { tenant_id: tenantId, status: 'activo' } });
  const results = [];
  results.blocked = [];
  results.pending = [];

  for (const asset of assets) {
    try {
      const created = await processAssetDepreciation(asset, period, tenantId, userId, { catchUp });
      results.push(...created);
      if (created.blockedPeriod) results.blocked.push({ id: asset.id, name: asset.name, period: created.blockedPeriod });
      if (created.pendingFrom) results.pending.push({ id: asset.id, name: asset.name, from: created.pendingFrom });
    } catch (error) {
      logger.warn(`[fixed-assets] Error procesando depreciación del activo ${asset.id} (tenant ${tenantId}): ${error.message}`);
    }
  }

  return results;
}

/**
 * Job mensual: recorre todos los tenants y corre su depreciación pendiente
 * hasta el último período cerrado, dentro del esquema de cada negocio.
 */
async function runMonthlyDepreciationAllTenants() {
  const { Tenant } = require('../../models');
  const targetPeriod = lastClosedPeriod();

  const { runWithTenantSchema } = require('../../config/tenantContext');
  const tenants = await Tenant.findAll({ where: { is_active: true }, attributes: ['id', 'schema_name'] });
  const allResults = [];

  for (const tenant of tenants) {
    try {
      // Los activos viven en el esquema de cada negocio: sin entrar a él, la
      // consulta caía en public (vacío) y el job nunca depreciaba nada.
      // Sin ponerse al día: el job solo deprecia el mes recién cerrado. Los
      // meses viejos pendientes los decide el negocio (botón o saldo inicial),
      // así nunca se agregan asientos sobre meses que ya revisó.
      const results = await runWithTenantSchema(tenant.schema_name || null, () => runDepreciationForTenant(tenant.id, { targetPeriod, catchUp: false }));
      allResults.push(...results);
    } catch (error) {
      logger.warn(`[fixed-assets] Error corriendo depreciación del tenant ${tenant.id}: ${error.message}`);
    }
  }

  return allResults;
}

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/**
 * Saldo inicial de un activo que ya venía depreciándose fuera de Pitbox.
 * @param {object} p { acquisition_cost, salvage_value, acquisition_date, useful_life_months,
 *   opening_accumulated_depreciation, opening_period ('YYYY-MM', último mes ya depreciado),
 *   remaining_months? (por defecto: vida útil − meses ya transcurridos) }
 * @returns {object} campos para el modelo (opening_* y basis_*), o {} si no hay saldo inicial.
 */
function openingFields(p) {
  const blank = (v) => v === undefined || v === null || v === '';
  if (blank(p.opening_period) && blank(p.opening_accumulated_depreciation)) return {};
  if (!PERIOD_RE.test(String(p.opening_period || ''))) throw httpError(400, 'Indica el mes de corte del saldo inicial (último mes ya depreciado)');
  const acqPeriod = periodOf(p.acquisition_date);
  if (comparePeriods(p.opening_period, acqPeriod) < 0) throw httpError(400, 'El mes de corte no puede ser anterior a la compra');
  const accumulated = round2(Number(p.opening_accumulated_depreciation) || 0);
  const base = round2(Number(p.acquisition_cost) - Number(p.salvage_value || 0));
  if (accumulated < 0 || accumulated > base) throw httpError(400, 'La depreciación acumulada no puede superar el costo menos el valor residual');
  const elapsed = monthsBetween(acqPeriod, p.opening_period) + 1;
  const remainingDefault = Math.max(0, Number(p.useful_life_months) - elapsed);
  const remaining = blank(p.remaining_months) ? remainingDefault : parseInt(p.remaining_months, 10);
  const pending = round2(base - accumulated);
  if (pending > 0.01 && !(remaining > 0)) throw httpError(400, 'Indica cuántos meses de vida útil le quedan al activo');
  return {
    opening_accumulated_depreciation: accumulated,
    opening_period: p.opening_period,
    basis_period: nextPeriod(p.opening_period),
    basis_amount: pending,
    basis_months: pending > 0.01 ? remaining : 0,
    useful_life_months: pending > 0.01 ? elapsed + remaining : Number(p.useful_life_months),
    status: pending > 0.01 ? 'activo' : 'totalmente_depreciado',
  };
}

/** Depreciación acumulada actual y siguiente período a depreciar. */
async function currentState(asset) {
  const { FixedAssetDepreciationEntry } = require('../../models');
  const last = await FixedAssetDepreciationEntry.findOne({ where: { fixed_asset_id: asset.id }, order: [['period', 'DESC']] });
  return {
    last,
    accumulated: last ? Number(last.accumulated_after) : openingAccumulated(asset),
    nextPeriod: last ? nextPeriod(last.period) : firstPeriodOf(asset),
    impaired: await impairedUpTo(asset),
  };
}

/**
 * Cambio de estimación (vida útil y/o valor residual) hacia adelante: lo ya
 * depreciado no se toca y el saldo por depreciar se reparte en los meses que
 * le quedan, desde el siguiente período sin depreciar (NIIF para Pymes 10.15
 * y 17.19).
 * @param {object} p { remaining_months, salvage_value?, reason? }
 */
async function changeEstimate(asset, p, userId) {
  if (asset.status === 'dado_de_baja') throw httpError(409, 'El activo está dado de baja');
  if (['unidades_produccion', 'menor_cuantia', 'no_deprecia'].includes(asset.depreciation_method)) {
    throw httpError(400, 'Este método no usa vida útil en meses');
  }
  const { accumulated, nextPeriod: effective, impaired } = await currentState(asset);
  const blank = (v) => v === undefined || v === null || v === '';
  const salvage = blank(p.salvage_value) ? Number(asset.salvage_value || 0) : round2(Number(p.salvage_value));
  if (!(salvage >= 0)) throw httpError(400, 'Valor residual inválido');
  const pending = round2(Number(asset.acquisition_cost) - salvage - accumulated - impaired);
  if (pending < -0.01) {
    throw httpError(400, `El valor residual no puede superar el valor en libros ($ ${Math.round(Number(asset.acquisition_cost) - accumulated - impaired).toLocaleString('es-CO')})`);
  }
  const remaining = parseInt(p.remaining_months, 10);
  if (pending > 0.01 && !(remaining > 0)) throw httpError(400, 'Indica cuántos meses de vida útil le quedan');
  const elapsed = monthsBetween(periodOf(asset.acquisition_date), effective);
  const before = { useful_life_months: asset.useful_life_months, salvage_value: Number(asset.salvage_value || 0) };
  const after = {
    useful_life_months: elapsed + (remaining || 0),
    salvage_value: salvage,
    remaining_months: remaining || 0,
    monthly: pending > 0.01 ? round2(pending / remaining) : 0,
  };
  const changes = [...(asset.estimate_changes || []), {
    at: new Date().toISOString(), by: userId || null, effective_period: effective, accumulated, before, after, reason: p.reason || null,
  }];
  await asset.update({
    salvage_value: salvage,
    useful_life_months: after.useful_life_months,
    basis_period: effective,
    basis_amount: Math.max(0, pending),
    basis_months: pending > 0.01 ? remaining : 0,
    estimate_changes: changes,
    status: pending > 0.01 ? 'activo' : 'totalmente_depreciado',
  });
  return { effective_period: effective, accumulated, pending: Math.max(0, pending), monthly: after.monthly };
}

/**
 * Baja por retiro o venta: deprecia hasta el día de la baja (el último mes
 * prorrateado por días), genera el asiento (activo, depreciación acumulada,
 * venta y utilidad o pérdida) y marca el activo como dado de baja.
 * @param {object} p { disposal_date, disposal_reason?, disposal_type: 'retiro'|'venta', sale_amount?, sale_account_id? }
 */
async function disposeAsset(asset, p, tenantId, userId) {
  const { generateFixedAssetDisposalEntry } = require('./autoEntries.service');
  if (asset.status === 'dado_de_baja') throw httpError(409, 'El activo ya está dado de baja');
  const date = String(p.disposal_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, 'La fecha de baja es obligatoria');
  if (date < String(asset.acquisition_date)) throw httpError(400, 'La fecha de baja no puede ser anterior a la compra');
  const type = p.disposal_type === 'venta' ? 'venta' : 'retiro';
  const saleAmount = type === 'venta' ? round2(Number(p.sale_amount) || 0) : 0;
  if (type === 'venta' && !(saleAmount > 0)) throw httpError(400, 'Escribe el valor de la venta');
  if (type === 'venta' && !p.sale_account_id) throw httpError(400, 'Elige la cuenta donde entra el dinero de la venta (caja, bancos o cuenta por cobrar)');

  const disposalPeriod = periodOf(date);
  const { last } = await currentState(asset);
  if (last && comparePeriods(last.period, disposalPeriod) > 0) {
    throw httpError(409, `Ya hay depreciación generada hasta ${last.period}, después de la fecha de baja. Usa una fecha de ${last.period} o posterior.`);
  }
  if (asset.status === 'activo') {
    await processAssetDepreciation(asset, disposalPeriod, tenantId, userId, { untilDate: date });
  }
  const { accumulated, impaired } = await currentState(asset);
  const bookValue = round2(Number(asset.acquisition_cost) - accumulated - impaired);
  const entry = await generateFixedAssetDisposalEntry(
    asset, { date, accumulated, impaired, saleAmount, saleAccountId: p.sale_account_id || null }, tenantId, userId, { rethrow: true },
  );
  await asset.update({
    status: 'dado_de_baja',
    disposal_date: date,
    disposal_reason: p.disposal_reason || null,
    disposal_type: type,
    sale_amount: type === 'venta' ? saleAmount : null,
    sale_account_id: type === 'venta' ? p.sale_account_id : null,
    disposal_journal_entry_id: entry?.id || null,
  });
  return { accumulated, impaired, book_value: bookValue, result: round2(saleAmount - bookValue), entry };
}

/**
 * Deterioro de valor (NIIF para Pymes, Sección 27): baja el valor en libros
 * hasta el valor recuperable. Genera el asiento (gasto por deterioro contra
 * deterioro acumulado) y, en línea recta, reparte el nuevo saldo por
 * depreciar en los meses que quedan desde el próximo mes sin depreciar.
 * @param {object} p { impairment_date, amount, reason? }
 */
async function registerImpairment(asset, p, tenantId, userId) {
  const { FixedAssetImpairment } = require('../../models');
  const { generateImpairmentEntry } = require('./autoEntries.service');
  if (asset.status === 'dado_de_baja') throw httpError(409, 'El activo está dado de baja');
  const date = String(p.impairment_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, 'La fecha del deterioro es obligatoria');
  if (date < String(asset.acquisition_date)) throw httpError(400, 'La fecha no puede ser anterior a la compra');
  const amount = round2(Number(p.amount) || 0);
  if (!(amount > 0)) throw httpError(400, 'Escribe el valor del deterioro');
  const { accumulated, nextPeriod: effective, impaired } = await currentState(asset);
  const book = round2(Number(asset.acquisition_cost) - accumulated - impaired);
  if (amount > book + 0.01) throw httpError(400, `El deterioro no puede superar el valor en libros ($ ${Math.round(book).toLocaleString('es-CO')})`);

  const row = await FixedAssetImpairment.create({
    tenant_id: tenantId, fixed_asset_id: asset.id, impairment_date: date, amount, reason: p.reason || null, created_by: userId || null,
  });
  const entry = await generateImpairmentEntry(asset, { date, amount, reason: p.reason }, tenantId, userId, { rethrow: true });
  if (entry) await row.update({ journal_entry_id: entry.id });

  // Nueva cuota hacia adelante (línea recta): saldo por depreciar / meses restantes.
  const pending = round2(Number(asset.acquisition_cost) - Number(asset.salvage_value || 0) - accumulated - impaired - amount);
  if ((asset.depreciation_method || 'linea_recta') === 'linea_recta' && asset.category !== 'terrenos') {
    const monthsLeft = Math.max(1, Number(asset.useful_life_months) - monthsBetween(periodOf(asset.acquisition_date), effective));
    await asset.update({ basis_period: effective, basis_amount: Math.max(0, pending), basis_months: pending > 0.01 ? monthsLeft : 0 });
  }
  if (pending <= 0.01 && asset.category !== 'terrenos') await asset.update({ status: 'totalmente_depreciado' });
  return { impairment: row, entry, book_value: round2(book - amount), pending: Math.max(0, pending) };
}

/**
 * Reversión de deterioro (NIIF para Pymes 27.30): cuando el valor recuperable
 * vuelve a subir. Se registra con monto negativo en fixed_asset_impairments y
 * su asiento (deterioro acumulado contra ingreso por recuperación). No puede
 * pasar del deterioro neto registrado ni dejar el activo por encima del valor
 * en libros que tendría sin el deterioro (lo depreciado según la vida útil
 * original). La cuota siguiente se recalcula hacia adelante.
 * @param {object} p { impairment_date, amount, reason? }
 */
async function reverseImpairment(asset, p, tenantId, userId) {
  const { FixedAssetImpairment } = require('../../models');
  const { generateImpairmentReversalEntry } = require('./autoEntries.service');
  if (asset.status === 'dado_de_baja') throw httpError(409, 'El activo está dado de baja');
  const date = String(p.impairment_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, 'La fecha de la reversión es obligatoria');
  const amount = round2(Number(p.amount) || 0);
  if (!(amount > 0)) throw httpError(400, 'Escribe el valor a revertir');
  const { accumulated, nextPeriod: effective, impaired } = await currentState(asset);
  if (!(impaired > 0)) throw httpError(400, 'Este activo no tiene deterioro por revertir');
  const cost = Number(asset.acquisition_cost);
  const salvage = Number(asset.salvage_value || 0);
  const book = round2(cost - accumulated - impaired);
  // Valor en libros que tendría sin deterioro: lo depreciado con la cuota
  // original (sin la rebaja de cuota que trajo el deterioro).
  const monthsUsed = Math.max(0, monthsBetween(periodOf(asset.acquisition_date), effective));
  const life = Number(asset.useful_life_months) || 1;
  const hypothetical = asset.category === 'terrenos' || asset.depreciation_method === 'no_deprecia'
    ? 0
    : Math.min(cost - salvage, ((cost - salvage) / life) * monthsUsed);
  const ceiling = round2(cost - Math.max(accumulated, hypothetical));
  const maxReversal = round2(Math.max(0, Math.min(impaired, ceiling - book)));
  if (amount > maxReversal + 0.01) {
    throw httpError(400, `Se puede revertir hasta $ ${Math.round(maxReversal).toLocaleString('es-CO')} (deterioro neto $ ${Math.round(impaired).toLocaleString('es-CO')}; sin pasar del valor en libros que tendría sin deterioro)`);
  }

  const row = await FixedAssetImpairment.create({
    tenant_id: tenantId, fixed_asset_id: asset.id, impairment_date: date, amount: -amount, reason: p.reason || 'Reversión de deterioro', created_by: userId || null,
  });
  const entry = await generateImpairmentReversalEntry(asset, { date, amount, reason: p.reason }, tenantId, userId, { rethrow: true });
  if (entry) await row.update({ journal_entry_id: entry.id });

  const pending = round2(cost - salvage - accumulated - (impaired - amount));
  if ((asset.depreciation_method || 'linea_recta') === 'linea_recta' && asset.category !== 'terrenos' && pending > 0.01) {
    const monthsLeft = Math.max(1, life - monthsBetween(periodOf(asset.acquisition_date), effective));
    await asset.update({ basis_period: effective, basis_amount: pending, basis_months: monthsLeft });
  }
  if (pending > 0.01 && asset.status === 'totalmente_depreciado') await asset.update({ status: 'activo' });
  return { reversal: row, entry, book_value: round2(book + amount), impaired: round2(impaired - amount) };
}

/**
 * Uso del mes de un activo por unidades de producción. Solo para meses que
 * aún no se han depreciado (lo ya depreciado no se recalcula).
 * @param {object} p { period: 'YYYY-MM', units, notes? }
 */
async function recordUsage(asset, p, tenantId, userId) {
  const { FixedAssetUsage } = require('../../models');
  if (asset.depreciation_method !== 'unidades_produccion') throw httpError(400, 'Este activo no se deprecia por unidades de producción');
  if (!PERIOD_RE.test(String(p.period || ''))) throw httpError(400, 'Indica el mes (AAAA-MM)');
  const units = round2(Number(p.units));
  if (!(units >= 0)) throw httpError(400, 'Escribe el uso del mes');
  if (comparePeriods(p.period, periodOf(asset.acquisition_date)) < 0) throw httpError(400, 'El mes es anterior a la compra');
  const { last } = await currentState(asset);
  if (last && comparePeriods(p.period, last.period) <= 0) {
    throw httpError(409, `${p.period} ya está depreciado (hasta ${last.period}): solo se registra uso de meses siguientes`);
  }
  const [row] = await FixedAssetUsage.upsert({
    tenant_id: tenantId, fixed_asset_id: asset.id, period: p.period, units, notes: p.notes || null, created_by: userId || null,
  }, { conflictFields: ['fixed_asset_id', 'period'] });
  return row;
}

module.exports = {
  computeDepreciationForPeriod,
  getMonthlyBaseAmount,
  periodOf,
  currentPeriod,
  lastClosedPeriod,
  nextPeriod,
  previousPeriod,
  periodEndDate,
  processAssetDepreciation,
  runDepreciationForTenant,
  runMonthlyDepreciationAllTenants,
  openingFields,
  openingAccumulated,
  changeEstimate,
  disposeAsset,
  monthsBetween,
  registerImpairment,
  reverseImpairment,
  recordUsage,
  impairedUpTo,
};
