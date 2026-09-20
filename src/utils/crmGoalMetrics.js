// backend/src/utils/crmGoalMetrics.js
//
// CRM — Gamificación, Fase 1. Ver gamificacion-crm-diseno.md §3.4.
// Catálogo cerrado en código (no tabla): agregar una métrica nueva es
// agregar una entrada acá con su función de cálculo, sin tocar el modelo
// CrmGoal. Cada calculadora reutiliza la misma lógica de negocio que ya usa
// controllers/crm/dashboard.controller.js — no se duplican reglas de qué es
// "ganado"/"perdido"/etc., solo se reconsulta con el filtro de target_id
// que pide el scope de la meta.
//
// Contrato de cada `calculate(ctx)`:
//   ctx = { tenant_id, scope, target_id, period_start, period_end }
//   scope 'individual' → target_id es un user_id (columna owner/assigned_to)
//   scope 'branch'      → target_id es un branch_id
//   scope 'tenant'      → target_id es el propio tenant_id (sin filtro extra)
// Devuelve un número (current_value).
const { Op } = require('sequelize');

function periodRange(period_start, period_end) {
  return {
    [Op.gte]: new Date(`${period_start}T00:00:00.000Z`),
    [Op.lte]: new Date(`${period_end}T23:59:59.999Z`),
  };
}

// Resuelve el `where` de alcance para modelos con owner_user_id/assigned_to
// propio y branch_id propio (Opportunity, FollowUpTask).
async function scopeWhereOwnField(scope, target_id, ownerField, tenant_id) {
  if (scope === 'individual') return { [ownerField]: target_id };
  if (scope === 'branch') return { branch_id: target_id };
  return {}; // scope === 'tenant': sin filtro adicional, ya viene tenant_id
}

// Customer no tiene branch_id propio (ver models/sales/Customer.js) — para
// scope 'branch' se resuelve vía owner_user_id + UserBranch, mismo patrón
// que utils/crmScope.js usa para el equipo de un manager.
async function branchOwnerIds(branch_id) {
  const { UserBranch } = require('../models');
  const rows = await UserBranch.findAll({ where: { branch_id }, attributes: ['user_id'] });
  return rows.map(r => r.user_id);
}

async function calcOpportunitiesWon({ tenant_id, scope, target_id, period_start, period_end }) {
  const { Opportunity } = require('../models');
  const { loadStageMap, keysByType } = require('./crmPipelineStages');
  const stageMap = await loadStageMap(tenant_id);
  const wonKeys = keysByType(stageMap, 'won');

  const where = {
    tenant_id,
    stage: { [Op.in]: wonKeys },
    stage_changed_at: periodRange(period_start, period_end),
    ...(await scopeWhereOwnField(scope, target_id, 'owner_user_id', tenant_id)),
  };
  return Opportunity.count({ where });
}

async function calcRevenueWon({ tenant_id, scope, target_id, period_start, period_end }) {
  const { Opportunity } = require('../models');
  const { loadStageMap, keysByType } = require('./crmPipelineStages');
  const stageMap = await loadStageMap(tenant_id);
  const wonKeys = keysByType(stageMap, 'won');

  const where = {
    tenant_id,
    stage: { [Op.in]: wonKeys },
    stage_changed_at: periodRange(period_start, period_end),
    ...(await scopeWhereOwnField(scope, target_id, 'owner_user_id', tenant_id)),
  };
  const rows = await Opportunity.findAll({ where, attributes: ['expected_value'] });
  return rows.reduce((sum, o) => sum + parseFloat(o.expected_value || 0), 0);
}

async function calcConversionRate({ tenant_id, scope, target_id, period_start, period_end }) {
  const { Opportunity } = require('../models');
  const { loadStageMap, keysByType } = require('./crmPipelineStages');
  const stageMap = await loadStageMap(tenant_id);
  const wonKeys = keysByType(stageMap, 'won');
  const lostKeys = keysByType(stageMap, 'lost');

  const baseWhere = {
    tenant_id,
    stage_changed_at: periodRange(period_start, period_end),
    ...(await scopeWhereOwnField(scope, target_id, 'owner_user_id', tenant_id)),
  };
  const [won, lost] = await Promise.all([
    Opportunity.count({ where: { ...baseWhere, stage: { [Op.in]: wonKeys } } }),
    Opportunity.count({ where: { ...baseWhere, stage: { [Op.in]: lostKeys } } }),
  ]);
  const closed = won + lost;
  // Meta expresada en % (0-100), igual que se muestra en el dashboard.
  return closed ? (won / closed) * 100 : 0;
}

async function calcFollowupsCompleted({ tenant_id, scope, target_id, period_start, period_end }) {
  const { FollowUpTask } = require('../models');
  const where = {
    tenant_id,
    status: 'hecha',
    completed_at: periodRange(period_start, period_end),
    ...(await scopeWhereOwnField(scope, target_id, 'assigned_to_user_id', tenant_id)),
  };
  return FollowUpTask.count({ where });
}

async function calcNewCustomers({ tenant_id, scope, target_id, period_start, period_end }) {
  const { Customer } = require('../models');
  const where = {
    tenant_id,
    created_at: periodRange(period_start, period_end),
  };
  if (scope === 'individual') {
    where.owner_user_id = target_id;
  } else if (scope === 'branch') {
    const ownerIds = await branchOwnerIds(target_id);
    if (!ownerIds.length) return 0;
    where.owner_user_id = { [Op.in]: ownerIds };
  }
  return Customer.count({ where });
}

// Métrica "de calidad": mientras menos leads sin atender a tiempo, mejor
// (invertida). No tiene sentido acumular por período como las demás — se
// mide "ahora mismo", igual que getNotificationsSummary en
// controllers/crm/dashboard.controller.js.
async function calcNoLeadsUnattended({ tenant_id, scope, target_id }) {
  const { Opportunity } = require('../models');
  const { loadStageMap, resolveEntryStageKey } = require('./crmPipelineStages');
  const stageMap = await loadStageMap(tenant_id);
  const entryStage = resolveEntryStageKey(stageMap);
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);

  const where = {
    tenant_id,
    stage: entryStage,
    stage_changed_at: { [Op.lte]: twoHoursAgo },
    ...(await scopeWhereOwnField(scope, target_id, 'owner_user_id', tenant_id)),
  };
  return Opportunity.count({ where });
}

// Clave → { label, description, source, inverted, point_in_time, calculate }
// `inverted: true` significa que menor valor = mejor cumplimiento (el % de
// avance se calcula distinto: ver crmGamificationService.computePercent()).
// `point_in_time: true` (Fase 4) significa que la métrica se mide "ahora
// mismo" y no acumula dentro del período — recalcularla para un período ya
// cerrado devolvería el valor de hoy, así que el dashboard de cumplimiento
// (§6) nunca la recalcula hacia atrás: para períodos pasados usa solo lo
// que quedó cacheado en CrmGoalProgress.
const CATALOG = {
  opportunities_won: {
    label: 'Oportunidades ganadas',
    source: 'Opportunity',
    inverted: false,
    calculate: calcOpportunitiesWon,
  },
  revenue_won: {
    label: 'Ingresos ganados',
    source: 'Opportunity',
    inverted: false,
    calculate: calcRevenueWon,
  },
  conversion_rate: {
    label: 'Tasa de conversión (%)',
    source: 'Opportunity',
    inverted: false,
    calculate: calcConversionRate,
  },
  followups_completed: {
    label: 'Seguimientos completados',
    source: 'FollowUpTask',
    inverted: false,
    calculate: calcFollowupsCompleted,
  },
  new_customers: {
    label: 'Clientes nuevos',
    source: 'Customer',
    inverted: false,
    calculate: calcNewCustomers,
  },
  no_leads_unattended: {
    label: 'Leads sin atender (menos es mejor)',
    source: 'Opportunity',
    inverted: true,
    point_in_time: true,
    calculate: calcNoLeadsUnattended,
  },
};

function listMetrics() {
  return Object.entries(CATALOG).map(([key, m]) => ({
    key, label: m.label, source: m.source, inverted: m.inverted,
    point_in_time: !!m.point_in_time,
  }));
}

function getMetric(key) {
  return CATALOG[key] || null;
}

module.exports = { CATALOG, listMetrics, getMetric };