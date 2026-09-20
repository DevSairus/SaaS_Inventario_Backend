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
 * Monto a depreciar de UN activo en UN período específico.
 *
 * - Si es el primer período del activo (accumulatedBefore === 0) y la fecha
 *   de compra no cae el día 1, se prorratea por días calendario de ese mes.
 * - En cualquier caso, el monto nunca excede el saldo por depreciar
 *   restante -- esto prorratea también el ÚLTIMO período automáticamente
 *   (matemáticamente equivalente a prorratear por complemento de días: la
 *   suma de useful_life_months períodos siempre cierra exacto en la base
 *   depreciable, sin necesidad de una regla aparte para "el último mes").
 */
function computeDepreciationForPeriod(asset, period, accumulatedBefore) {
  const base = round2(Number(asset.acquisition_cost) - Number(asset.salvage_value || 0));
  const remaining = round2(base - Number(accumulatedBefore || 0));
  if (remaining <= 0.01) return 0;

  const monthly = getMonthlyBaseAmount(asset);
  const [year, month] = period.split('-').map(Number);
  const acqDate = new Date(asset.acquisition_date);
  const isFirstPeriod = Number(accumulatedBefore || 0) === 0;
  const isAcquisitionMonth = isFirstPeriod
    && acqDate.getUTCFullYear() === year
    && (acqDate.getUTCMonth() + 1) === month;

  let amount;
  if (isAcquisitionMonth) {
    const totalDays = daysInMonth(year, month);
    const dayAcquired = acqDate.getUTCDate();
    const daysUsed = totalDays - dayAcquired + 1;
    amount = round2(monthly * (daysUsed / totalDays));
  } else {
    amount = round2(monthly);
  }

  return Math.min(amount, remaining);
}

/**
 * Genera (si faltan) las entradas de depreciación de UN activo, desde la
 * siguiente al último período ya generado hasta `targetPeriod` inclusive.
 */
async function processAssetDepreciation(asset, targetPeriod, tenantId, userId) {
  const { sequelize } = require('../../config/database');
  const { FixedAssetDepreciationEntry } = require('../../models');
  const { generateDepreciationEntry } = require('./autoEntries.service');

  const created = [];

  const lastEntry = await FixedAssetDepreciationEntry.findOne({
    where: { fixed_asset_id: asset.id },
    order: [['period', 'DESC']],
  });

  let accumulatedBefore = lastEntry ? Number(lastEntry.accumulated_after) : 0;
  let period = lastEntry ? nextPeriod(lastEntry.period) : periodOf(asset.acquisition_date);

  while (comparePeriods(period, targetPeriod) <= 0) {
    const amount = computeDepreciationForPeriod(asset, period, accumulatedBefore);
    if (amount <= 0) break; // ya se depreció por completo

    const depreciableBase = round2(Number(asset.acquisition_cost) - Number(asset.salvage_value || 0));
    const accumulatedAfter = round2(accumulatedBefore + amount);
    const fullyDepreciated = accumulatedAfter >= depreciableBase - 0.01;

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
    period = nextPeriod(period);
    if (fullyDepreciated) break;
  }

  return created;
}

/**
 * Corre la depreciación pendiente de todos los activos 'activo' de un
 * tenant, hasta `targetPeriod` (por defecto, el último período cerrado).
 */
async function runDepreciationForTenant(tenantId, { targetPeriod, userId } = {}) {
  const { FixedAsset } = require('../../models');
  const period = targetPeriod || lastClosedPeriod();

  if (!PERIOD_RE.test(period)) {
    throw new Error(`Período inválido: "${period}" (formato esperado YYYY-MM)`);
  }

  const assets = await FixedAsset.findAll({ where: { tenant_id: tenantId, status: 'activo' } });
  const results = [];

  for (const asset of assets) {
    try {
      const created = await processAssetDepreciation(asset, period, tenantId, userId);
      results.push(...created);
    } catch (error) {
      logger.warn(`[fixed-assets] Error procesando depreciación del activo ${asset.id} (tenant ${tenantId}): ${error.message}`);
    }
  }

  return results;
}

/**
 * Job mensual: recorre todos los tenants y corre su depreciación pendiente
 * hasta el último período cerrado. Los activos fijos viven en tablas
 * compartidas (tenant_id, igual que chart_of_accounts/journal_entries), no
 * en el schema propio del tenant -- no hace falta runWithTenantSchema acá
 * (a diferencia de stock-alerts/vehicle-reminders, que sí operan sobre
 * tablas ya migradas a schema-per-tenant).
 */
async function runMonthlyDepreciationAllTenants() {
  const { Tenant } = require('../../models');
  const targetPeriod = lastClosedPeriod();

  const tenants = await Tenant.findAll({ attributes: ['id'] });
  const allResults = [];

  for (const tenant of tenants) {
    try {
      const results = await runDepreciationForTenant(tenant.id, { targetPeriod });
      allResults.push(...results);
    } catch (error) {
      logger.warn(`[fixed-assets] Error corriendo depreciación del tenant ${tenant.id}: ${error.message}`);
    }
  }

  return allResults;
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
};
