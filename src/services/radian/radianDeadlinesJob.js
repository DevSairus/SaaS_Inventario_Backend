// backend/src/services/radian/radianDeadlinesJob.js
/**
 * Job diario `radian-deadlines` (ver
 * 00 - Documentación/RADIAN-Analisis-y-Plan.md §5.5 y §5.7): SOLO avisa,
 * nunca emite un evento por sí mismo — 031/033/034 siempre requieren acción
 * explícita del usuario (decisión de producto §5.7). Genera/resuelve filas
 * en radian_alerts:
 *   - purchases con 032 aceptado: aviso "por vencer" (dentro de 24h) o
 *     "vencido" del plazo para 031/033.
 *   - sales con un 032 recibido del cliente (ver
 *     radianService.js#recordSaleReceivedEvent) y el plazo ya vencido sin
 *     033/031: aviso de que el 034 ya está disponible para emitir.
 */
'use strict';

const { Op } = require('sequelize');
const logger = console;

const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

async function upsertAlert(RadianAlert, { tenantId, purchaseId, saleId, alertType, severity, deadlineAt }) {
  const where = { tenant_id: tenantId, alert_type: alertType, status: 'active' };
  if (purchaseId) where.purchase_id = purchaseId; else where.sale_id = saleId;

  const existing = await RadianAlert.findOne({ where });
  if (existing) return existing.id;

  try {
    const row = await RadianAlert.create({
      tenant_id: tenantId, purchase_id: purchaseId || null, sale_id: saleId || null,
      alert_type: alertType, severity, deadline_at: deadlineAt, status: 'active',
    });
    return row.id;
  } catch (err) {
    // Carrera con otra corrida del job (no debería pasar con el advisory
    // lock del scheduler, pero por si se dispara también vía /api/cron a
    // mano) — el índice único parcial ya lo evita, se ignora.
    if (err.name === 'SequelizeUniqueConstraintError') return null;
    throw err;
  }
}

async function processTenantSchema(models) {
  const { Purchase, Sale, RadianAlert } = models;
  const now = new Date();
  const dueSoonThreshold = new Date(now.getTime() + DUE_SOON_WINDOW_MS);

  const purchasesPending = await Purchase.findAll({
    where: { radian_status: '032', radian_deadline_at: { [Op.not]: null } },
    attributes: ['id', 'tenant_id', 'radian_deadline_at'],
  });

  const overdueIds = [], dueSoonIds = [];
  for (const p of purchasesPending) {
    const deadline = new Date(p.radian_deadline_at);
    if (deadline <= now) {
      const id = await upsertAlert(RadianAlert, {
        tenantId: p.tenant_id, purchaseId: p.id,
        alertType: 'purchase_deadline_overdue', severity: 'critical', deadlineAt: deadline,
      });
      if (id) overdueIds.push(id);
      // El "por vencer" queda superado por el "vencido" — se resuelve para
      // no mostrar dos avisos activos sobre el mismo plazo.
      await RadianAlert.update(
        { status: 'resolved', resolved_at: now },
        { where: { tenant_id: p.tenant_id, purchase_id: p.id, alert_type: 'purchase_deadline_due_soon', status: 'active' } }
      );
    } else if (deadline <= dueSoonThreshold) {
      const id = await upsertAlert(RadianAlert, {
        tenantId: p.tenant_id, purchaseId: p.id,
        alertType: 'purchase_deadline_due_soon', severity: 'warning', deadlineAt: deadline,
      });
      if (id) dueSoonIds.push(id);
    }
  }

  // Compras que ya salieron de 032 (033/031 emitidos) — sus avisos activos
  // ya no aplican, se resuelven aunque el job no los haya tocado hoy.
  const pendingPurchaseIds = purchasesPending.map(p => p.id);
  await RadianAlert.update(
    { status: 'resolved', resolved_at: now },
    {
      where: {
        alert_type: { [Op.in]: ['purchase_deadline_overdue', 'purchase_deadline_due_soon'] },
        status: 'active',
        purchase_id: pendingPurchaseIds.length ? { [Op.notIn]: pendingPurchaseIds } : { [Op.ne]: null },
      },
    }
  );

  const salesReady = await Sale.findAll({
    where: { radian_status: '032_received', radian_deadline_at: { [Op.lte]: now } },
    attributes: ['id', 'tenant_id', 'radian_deadline_at'],
  });

  const readyIds = [];
  for (const s of salesReady) {
    const id = await upsertAlert(RadianAlert, {
      tenantId: s.tenant_id, saleId: s.id,
      alertType: 'sale_tacit_acceptance_ready', severity: 'info', deadlineAt: s.radian_deadline_at,
    });
    if (id) readyIds.push(id);
  }

  const readySaleIds = salesReady.map(s => s.id);
  await RadianAlert.update(
    { status: 'resolved', resolved_at: now },
    {
      where: {
        alert_type: 'sale_tacit_acceptance_ready',
        status: 'active',
        sale_id: readySaleIds.length ? { [Op.notIn]: readySaleIds } : { [Op.ne]: null },
      },
    }
  );

  return { overdue: overdueIds.length, dueSoon: dueSoonIds.length, tacitReady: readyIds.length };
}

async function runRadianDeadlinesJob() {
  const Tenant = require('../../models/auth/Tenant');
  const { runWithTenantSchema } = require('../../config/tenantContext');
  const models = require('../../models');

  const tenants = await Tenant.findAll({ where: { schema_name: { [Op.not]: null } }, attributes: ['id', 'schema_name'] });

  const results = [];
  for (const tenant of tenants) {
    try {
      const r = await runWithTenantSchema(tenant.schema_name, () => processTenantSchema(models));
      if (r.overdue || r.dueSoon || r.tacitReady) {
        results.push({ tenant: tenant.schema_name, ...r });
      }
    } catch (err) {
      logger.error(`[RADIAN-Deadlines] Error en tenant "${tenant.schema_name}":`, err.message);
    }
  }

  logger.log(`[RADIAN-Deadlines] Completado — ${results.length} tenant(s) con avisos nuevos/actualizados`);
  return results;
}

module.exports = { runRadianDeadlinesJob };
