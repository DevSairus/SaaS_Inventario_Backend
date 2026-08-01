// backend/src/services/crmAutomationEngine.js
//
// CRM Fase C.1 — motor de automatizaciones configurables (ver propuesta,
// §3 Fase C.1 y backend/src/models/crm/CrmAutomationRule.js para el
// detalle de cada trigger_type/action_type).
//
// Dos formas de evaluación:
//
//   1. Reglas de SONDEO ('unattended_lead', 'stage_stale') — no hay un
//      evento que las dispare, así que se revisan periódicamente contra
//      las oportunidades abiertas. runPollingRules() sigue el mismo
//      patrón multi-schema que crmLifecycleService.js (runWithTenantSchema
//      por tenant con schema propio, batch contra `public` para el resto).
//      Se registra cada disparo en CrmAutomationRuleLog para no repetir la
//      misma acción sobre la misma oportunidad mientras siga en la misma
//      etapa (dedupe por stage_changed_at).
//
//   2. Reglas de EVENTO ('opportunity_created') — se evalúan en línea, en
//      el momento en que se crea una oportunidad. applyOpportunityCreatedRules()
//      se llama desde opportunities.controller.js (creación manual) y
//      metaWebhook.controller.js (leads de Meta Ads), inmediatamente
//      después de crear la Opportunity. No necesitan log de dedupe: cada
//      oportunidad solo se crea una vez.
//
// Corre en el mismo scheduler (backend/src/jobs/scheduler.js) que el resto
// de jobs CRM, pero con una frecuencia mayor (cada 30 min) porque una
// regla como "sin contactar hace 2 horas" pierde sentido si solo se revisa
// una vez al día.
const { Op } = require('sequelize');

// ── acciones ──────────────────────────────────────────────────────────────

async function actionCreateTask({ tenant_id, opportunity, actionConfig }) {
  const { FollowUpTask } = require('../models');

  const dueInHours = Number.isFinite(actionConfig?.due_in_hours) ? actionConfig.due_in_hours : 2;
  const title = actionConfig?.title || 'Seguimiento automático';
  // 'creator' no aplica acá (no hay usuario humano creando la tarea); si la
  // oportunidad no tiene dueño (ej. lead de Meta recién llegado, sin
  // asignar todavía), la tarea queda huérfana de asignación explícita y se
  // le asigna al dueño de la oportunidad una vez la regla de asignación
  // (si existe) haya corrido antes en la misma pasada — ver runPollingRules.
  const assigneeId = opportunity.owner_user_id;
  if (!assigneeId) return null; // sin dueño todavía: no hay a quién asignarle la tarea

  return FollowUpTask.create({
    tenant_id,
    branch_id: opportunity.branch_id || null,
    customer_id: opportunity.customer_id,
    opportunity_id: opportunity.id,
    assigned_to_user_id: assigneeId,
    created_by_user_id: null, // creada por el sistema, no por un usuario
    title,
    due_at: new Date(Date.now() + dueInHours * 3_600_000),
    status: 'pendiente',
  });
}

async function actionAssignRoundRobin({ tenant_id, opportunity, rule }) {
  const { User, UserBranch, Opportunity } = require('../models');

  // Universo de candidatos: vendedores activos del tenant. Si la
  // oportunidad tiene sede y esa sede tiene vendedores propios asignados
  // (UserBranch), se prioriza ese subconjunto; si no, se reparte entre
  // todos los vendedores activos del tenant.
  let candidates = await User.findAll({
    where: { tenant_id, role: 'seller', is_active: true },
    attributes: ['id'],
    order: [['id', 'ASC']], // orden estable para que la rotación sea determinística
  });

  if (opportunity.branch_id) {
    const branchUsers = await UserBranch.findAll({ where: { branch_id: opportunity.branch_id } });
    const branchUserIds = new Set(branchUsers.map(b => b.user_id));
    const scoped = candidates.filter(c => branchUserIds.has(c.id));
    if (scoped.length) candidates = scoped;
  }

  if (!candidates.length) return null; // sin vendedores activos: no hay a quién asignar

  const ids = candidates.map(c => c.id);
  const lastIndex = rule.last_round_robin_user_id ? ids.indexOf(rule.last_round_robin_user_id) : -1;
  const nextUserId = ids[(lastIndex + 1) % ids.length];

  await Opportunity.update({ owner_user_id: nextUserId }, { where: { id: opportunity.id, tenant_id } });
  await rule.update({ last_round_robin_user_id: nextUserId });

  return nextUserId;
}

async function executeAction(rule, tenant_id, opportunity) {
  if (rule.action_type === 'create_task') {
    return actionCreateTask({ tenant_id, opportunity, actionConfig: rule.action_config });
  }
  if (rule.action_type === 'assign_round_robin') {
    const assignedId = await actionAssignRoundRobin({ tenant_id, opportunity, rule });
    // Si además hay reglas de sondeo mirando esta oportunidad recién
    // asignada en la misma corrida, no aplica acá — el sondeo corre en su
    // propia pasada y ya verá owner_user_id actualizado.
    return assignedId;
  }
  return null;
}

// ── evaluación de reglas de SONDEO ──────────────────────────────────────

async function alreadyTriggered(ruleId, opportunityId, stageChangedAt) {
  const { CrmAutomationRuleLog } = require('../models');
  const existing = await CrmAutomationRuleLog.findOne({
    where: { automation_rule_id: ruleId, opportunity_id: opportunityId, triggered_for_stage_changed_at: stageChangedAt },
  });
  return !!existing;
}

async function logTrigger(tenant_id, ruleId, opportunityId, stageChangedAt) {
  const { CrmAutomationRuleLog } = require('../models');
  try {
    await CrmAutomationRuleLog.create({
      tenant_id, automation_rule_id: ruleId, opportunity_id: opportunityId,
      triggered_for_stage_changed_at: stageChangedAt,
    });
  } catch (err) {
    // Choque de la unique constraint de dedupe (carrera entre corridas) —
    // no es un error real, simplemente alguien más ya lo marcó primero.
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
  }
}

async function evaluateUnattendedLead(rule, tenant_id, stageMap, results) {
  const { Opportunity } = require('../models');
  const { keysByType, resolveEntryStageKey } = require('../utils/crmPipelineStages');

  const hours = Number(rule.trigger_config?.hours) || 2;
  const sourceFilter = rule.trigger_config?.source || null;
  const entryStageKey = resolveEntryStageKey(stageMap);
  const cutoff = new Date(Date.now() - hours * 3_600_000);

  const where = {
    tenant_id,
    stage: entryStageKey, // "sin contactar" = sigue en la etapa de entrada
    stage_changed_at: { [Op.lte]: cutoff },
  };
  if (sourceFilter) where.source = sourceFilter;

  const opportunities = await Opportunity.findAll({ where });

  for (const opportunity of opportunities) {
    if (await alreadyTriggered(rule.id, opportunity.id, opportunity.stage_changed_at)) continue;
    try {
      await executeAction(rule, tenant_id, opportunity);
      await logTrigger(tenant_id, rule.id, opportunity.id, opportunity.stage_changed_at);
      results.rulesTriggered++;
    } catch (err) {
      results.errors++;
      console.error(`❌ [CRM automation] Error aplicando regla "${rule.name}" (unattended_lead) a oportunidad ${opportunity.id}:`, err.message);
    }
  }
}

async function evaluateStageStale(rule, tenant_id, stageMap, results) {
  const { Opportunity } = require('../models');

  const stageKey = rule.trigger_config?.stage_key;
  const hours = Number(rule.trigger_config?.hours) || 72;
  if (!stageKey || !stageMap[stageKey]) return; // etapa configurada ya no existe en este tenant

  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const opportunities = await Opportunity.findAll({
    where: { tenant_id, stage: stageKey, stage_changed_at: { [Op.lte]: cutoff } },
  });

  for (const opportunity of opportunities) {
    if (await alreadyTriggered(rule.id, opportunity.id, opportunity.stage_changed_at)) continue;
    try {
      await executeAction(rule, tenant_id, opportunity);
      await logTrigger(tenant_id, rule.id, opportunity.id, opportunity.stage_changed_at);
      results.rulesTriggered++;
    } catch (err) {
      results.errors++;
      console.error(`❌ [CRM automation] Error aplicando regla "${rule.name}" (stage_stale) a oportunidad ${opportunity.id}:`, err.message);
    }
  }
}

async function processTenantRules(tenantId, results) {
  const { CrmAutomationRule } = require('../models');
  const { loadStageMap } = require('../utils/crmPipelineStages');

  const rules = await CrmAutomationRule.findAll({
    where: { tenant_id: tenantId, is_active: true, trigger_type: { [Op.in]: ['unattended_lead', 'stage_stale'] } },
  });
  if (!rules.length) return;

  const stageMap = await loadStageMap(tenantId);

  for (const rule of rules) {
    if (rule.trigger_type === 'unattended_lead') {
      await evaluateUnattendedLead(rule, tenantId, stageMap, results);
    } else if (rule.trigger_type === 'stage_stale') {
      await evaluateStageStale(rule, tenantId, stageMap, results);
    }
  }
}

async function runPollingRules() {
  const Tenant = require('../models/auth/Tenant');
  const { runWithTenantSchema } = require('../config/tenantContext');
  const { getEffectiveModulesForTenantId } = require('./moduleAccess');

  const results = { rulesTriggered: 0, errors: 0, tenantsSkipped: 0 };
  const allTenants = await Tenant.findAll({ attributes: ['id', 'schema_name'] });

  for (const tenant of allTenants) {
    const modules = await getEffectiveModulesForTenantId(tenant.id);
    if (!modules.includes('crm')) {
      results.tenantsSkipped++;
      continue;
    }
    try {
      if (tenant.schema_name) {
        await runWithTenantSchema(tenant.schema_name, () => processTenantRules(tenant.id, results));
      } else {
        await processTenantRules(tenant.id, results);
      }
    } catch (err) {
      results.errors++;
      console.error(`❌ [CRM automation] Error procesando tenant "${tenant.schema_name || tenant.id}":`, err.message);
    }
  }

  console.log(`✅ [CRM automation] Reglas disparadas: ${results.rulesTriggered} | Tenants sin CRM: ${results.tenantsSkipped} | Errores: ${results.errors}`);
  return results;
}

// ── evaluación de reglas de EVENTO ──────────────────────────────────────

// Se llama justo después de crear una Opportunity (creación manual desde
// el pipeline, o automática desde un lead de Meta Ads). No lanza — un
// fallo en una automatización no debe tumbar la creación de la
// oportunidad, que es la operación que le importa al usuario.
async function applyOpportunityCreatedRules(tenant_id, opportunity) {
  try {
    const { CrmAutomationRule } = require('../models');
    const rules = await CrmAutomationRule.findAll({
      where: { tenant_id, is_active: true, trigger_type: 'opportunity_created' },
    });

    for (const rule of rules) {
      const sourceFilter = rule.trigger_config?.source || null;
      if (sourceFilter && opportunity.source !== sourceFilter) continue;
      await executeAction(rule, tenant_id, opportunity);
    }
  } catch (err) {
    console.error(`❌ [CRM automation] Error aplicando reglas de creación a oportunidad ${opportunity.id}:`, err.message);
  }
}

module.exports = { runPollingRules, applyOpportunityCreatedRules };
