// backend/src/services/crmGamificationService.js
//
// CRM — Gamificación, Fase 1. Ver gamificacion-crm-diseno.md §4. Mismo
// patrón que services/crmAutomationEngine.js (applyOpportunityCreatedRules):
// un hook de evento invocado in-line desde los controllers existentes justo
// después de la operación que le importa al usuario, no por polling. Un
// fallo acá nunca debe tumbar la respuesta del controller que lo llamó.
const { getMetric } = require('../utils/crmGoalMetrics');
const { resolveCurrentPeriod } = require('../utils/crmGoalPeriods');

// Qué métricas puede mover cada tipo de evento (ver §4, tabla de eventos).
const EVENT_METRIC_MAP = {
  opportunity_won: ['opportunities_won', 'revenue_won', 'conversion_rate'],
  followup_completed: ['followups_completed'],
  customer_created: ['new_customers'],
  // 'no_leads_unattended' no se mueve por un evento puntual — la revisa el
  // job de automatizaciones existente (crmAutomationEngine, cada 30 min).
};

// Resuelve el target_id a recalcular según el scope de la meta. Si no hay
// dato suficiente para atribuir (ej. meta de sede pero el registro no tiene
// branch_id), se omite esa meta para este evento — no se inventa un target.
function resolveTargetId(goal, { user_id, branch_id, tenant_id }) {
  if (goal.scope === 'individual') return user_id || null;
  if (goal.scope === 'branch') return branch_id || null;
  return tenant_id; // scope === 'tenant'
}

// % de avance. Para métricas invertidas (menos es mejor, ej.
// no_leads_unattended) un valor por debajo del target es 100% de
// cumplimiento; por encima, se degrada proporcionalmente hasta 0 en 2x el
// target. Para el resto, el % normal (puede superar 100, ver §5.1 "supera
// lo del mes pasado").
function computePercent(metricDef, current_value, target_value) {
  if (!target_value || target_value <= 0) return 0;
  if (metricDef.inverted) {
    if (current_value <= target_value) return 100;
    const overshoot = (current_value - target_value) / target_value;
    return Math.max(0, Math.round((1 - overshoot) * 10000) / 100);
  }
  return Math.round((current_value / target_value) * 10000) / 100;
}

// Fase 3 (§5.2) — la notificación de hito debe mostrar "nombre de la
// persona + logro". El motor original (Fase 1) no devolvía esto porque el
// endpoint de progreso todavía no tenía consumidor visual. Se resuelve acá,
// no en el controller, porque solo hace falta cuando de verdad se cruzó un
// milestone (evento raro) — no en cada recalculo de progreso.
async function resolveTargetLabel(goal, target_id) {
  try {
    if (goal.scope === 'individual') {
      const { User } = require('../models');
      const user = await User.findByPk(target_id, { attributes: ['first_name', 'last_name'] });
      return user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() || null : null;
    }
    if (goal.scope === 'branch') {
      const { Branch } = require('../models');
      const branch = await Branch.findByPk(target_id, { attributes: ['name'] });
      return branch ? branch.name : null;
    }
    return null; // scope 'tenant': meta colectiva del negocio, sin nombre de persona
  } catch {
    return null; // el nombre es decorativo — un fallo acá no debe tumbar la celebración
  }
}

// Milestone más alto ya alcanzado por `percent`, entre los que no se habían
// notificado todavía (índice > last_milestone_reached).
function findNewMilestone(milestones, percent, lastIndex) {
  if (!Array.isArray(milestones) || !milestones.length) return null;
  const sorted = milestones
    .map((m, originalIndex) => ({ ...m, originalIndex }))
    .sort((a, b) => a.percent - b.percent);

  let reached = null;
  sorted.forEach((m) => {
    if (percent >= m.percent && m.originalIndex > (lastIndex ?? -1)) {
      // Se queda con el de mayor índice alcanzado (si de un salto se
      // cruzan varios milestones a la vez, se notifica el más alto).
      if (!reached || m.originalIndex > reached.originalIndex) reached = m;
    }
  });
  return reached;
}

async function upsertProgress({ goal, target_id, period_start, period_end, current_value, percent }) {
  const { CrmGoalProgress } = require('../models');

  const [row] = await CrmGoalProgress.findOrCreate({
    where: { goal_id: goal.id, target_id, period_start },
    defaults: {
      tenant_id: goal.tenant_id,
      goal_id: goal.id,
      target_id,
      period_start,
      period_end,
      current_value,
      percent,
      last_milestone_reached: null,
    },
  });

  const milestone = findNewMilestone(goal.milestones, percent, row.last_milestone_reached);

  await row.update({
    current_value,
    percent,
    ...(milestone ? { last_milestone_reached: milestone.originalIndex } : {}),
  });

  return { row, milestone };
}

// Recalcula las metas activas afectadas por un evento, solo para el
// target_id correspondiente (no se recorren todas las metas del tenant).
// Devuelve { goals_updated: [...] } para que el controller que disparó el
// evento lo anexe a su respuesta HTTP (ver §4).
async function applyGoalProgressEvent({ tenant_id, event_type, user_id = null, branch_id = null }) {
  const metricKeys = EVENT_METRIC_MAP[event_type];
  if (!metricKeys || !metricKeys.length) return { goals_updated: [] };

  try {
    const { CrmGoal } = require('../models');
    const { Op } = require('sequelize');

    const goals = await CrmGoal.findAll({
      where: { tenant_id, active: true, metric: { [Op.in]: metricKeys } },
    });
    if (!goals.length) return { goals_updated: [] };

    const goalsUpdated = [];

    for (const goal of goals) {
      const target_id = resolveTargetId(goal, { user_id, branch_id, tenant_id });
      if (!target_id) continue; // sin dato para atribuir, se omite esta meta

      const period = resolveCurrentPeriod(goal);
      if (!period) continue; // meta custom fuera de su ventana vigente

      const metricDef = getMetric(goal.metric);
      if (!metricDef) continue; // métrica ya no existe en el catálogo

      const current_value = await metricDef.calculate({
        tenant_id, scope: goal.scope, target_id,
        period_start: period.period_start, period_end: period.period_end,
      });
      const percent = computePercent(metricDef, current_value, parseFloat(goal.target_value));

      const { milestone } = await upsertProgress({
        goal, target_id, period_start: period.period_start, period_end: period.period_end,
        current_value, percent,
      });

      if (milestone) {
        goalsUpdated.push({
          goal_id: goal.id,
          name: goal.name,
          scope: goal.scope,
          icon_style: goal.icon_style,
          target_id,
          target_label: await resolveTargetLabel(goal, target_id),
          percent,
          milestone_reached: { percent: milestone.percent, message: milestone.message },
        });
      }
    }

    return { goals_updated: goalsUpdated };
  } catch (err) {
    // Mismo criterio que applyOpportunityCreatedRules: un fallo acá no debe
    // tumbar la operación de negocio que disparó el evento.
    const logger = require('../config/logger');
    logger.error(`[Gamification] Error aplicando progreso de metas (${event_type}):`, err);
    return { goals_updated: [] };
  }
}

// Usado por el endpoint de lectura (GET /api/crm/goals/progress): calcula
// en vivo y refresca la caché de CrmGoalProgress, pero sin la lógica de
// "milestone recién cruzado" (eso es cosa del evento en tiempo real, no de
// una simple consulta de estado). `period` ya resuelto, para no
// recalcularlo por cada target_id de la misma meta.
async function getOrRecalculateProgress(goal, target_id, period) {
  const metricDef = getMetric(goal.metric);
  if (!metricDef) return null;

  const current_value = await metricDef.calculate({
    tenant_id: goal.tenant_id, scope: goal.scope, target_id,
    period_start: period.period_start, period_end: period.period_end,
  });
  const percent = computePercent(metricDef, current_value, parseFloat(goal.target_value));

  const { row } = await upsertProgress({
    goal, target_id, period_start: period.period_start, period_end: period.period_end,
    current_value, percent,
  });

  return {
    target_id,
    current_value,
    percent,
    last_milestone_reached: row.last_milestone_reached,
  };
}

module.exports = {
  applyGoalProgressEvent, computePercent, findNewMilestone, getOrRecalculateProgress,
};
