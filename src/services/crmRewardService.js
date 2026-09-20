// backend/src/services/crmRewardService.js
//
// CRM — Gamificación, Fase 5. Ver gamificacion-crm-diseno.md §10.
// Motor de recompensas: al cerrarse el período de una meta, evalúa las
// reglas activas contra el histórico de CrmGoalProgress, determina el tier
// aplicable, reparte el monto si la meta es de sede/tenant y deja cada
// CrmReward en el estado que corresponda (§10.4).
//
// Dos diferencias de fondo con crmGamificationService.js (Fase 1):
//   - Aquel corre EN LÍNEA desde los controllers (tiempo real, celebración).
//     Este corre en el job nocturno: una recompensa solo tiene sentido
//     cuando el período ya cerró y el número no puede cambiar más.
//   - Aquel escribe una caché; este crea plata. Por eso la idempotencia es
//     dura (índice único regla+usuario+período) y no "best effort".
const { Op } = require('sequelize');
const crypto = require('crypto');

const { getMetric } = require('../utils/crmGoalMetrics');
const { listRecentPeriods } = require('../utils/crmGoalPeriods');
const { getOrRecalculateProgress } = require('./crmGamificationService');
const { mapUsersToEmployees } = require('../utils/crmRewardMatching');

// Cuántos períodos hacia atrás se miran para calcular la racha. 12 cubre un
// año de metas mensuales sin volver costosa la consulta.
const STREAK_LOOKBACK_PERIODS = 12;

const todayStr = () => new Date().toISOString().slice(0, 10);

// ── Tiers ────────────────────────────────────────────────────────────────
// Condiciones soportadas en `tiers[].condition` (§10.2):
//   cumplida_1_periodo            → racha >= 1
//   racha_N_periodos / racha_N_o_mas → racha >= N
//   superacion_N                  → percent >= N
// Se elige el tier MÁS ALTO que se cumpla, no el primero que coincida.
function parseTierCondition(condition) {
  const raw = String(condition || '').trim().toLowerCase();
  if (raw === 'cumplida_1_periodo') return { kind: 'streak', value: 1 };

  const rachaOMas = raw.match(/^racha_(\d+)_o_mas$/);
  if (rachaOMas) return { kind: 'streak', value: parseInt(rachaOMas[1], 10) };

  const racha = raw.match(/^racha_(\d+)(_periodos)?$/);
  if (racha) return { kind: 'streak', value: parseInt(racha[1], 10) };

  const superacion = raw.match(/^superacion_(\d+)$/);
  if (superacion) return { kind: 'percent', value: parseInt(superacion[1], 10) };

  return null; // condición desconocida: el tier se ignora, no se adivina
}

function resolveTier(rule, { streak, percent }) {
  const candidates = (Array.isArray(rule.tiers) ? rule.tiers : [])
    .map((tier) => ({ tier, parsed: parseTierCondition(tier.condition) }))
    .filter(({ parsed }) => {
      if (!parsed) return false;
      return parsed.kind === 'streak' ? streak >= parsed.value : percent >= parsed.value;
    });

  if (!candidates.length) return null;

  // "Más alto" = el que exige más (racha más larga o superación mayor).
  candidates.sort((a, b) => {
    if (a.parsed.kind !== b.parsed.kind) return a.parsed.kind === 'streak' ? 1 : -1;
    return b.parsed.value - a.parsed.value;
  });
  return candidates[0].tier;
}

// ── Condición de entrada (§10.2) ────────────────────────────────────────
function conditionMet(rule, { percent, streak }) {
  const cfg = rule.condition_config || {};
  if (rule.condition_type === 'meta_cumplida') return percent >= 100;
  if (rule.condition_type === 'racha') return streak >= (Number(cfg.min_periods) || 2);
  if (rule.condition_type === 'superacion') return percent >= (Number(cfg.min_percent) || 120);
  return false;
}

// ── Progreso de un período ya cerrado ───────────────────────────────────
// Usa la caché de CrmGoalProgress; si falta y la métrica lo permite, la
// reconstruye (misma decisión que el dashboard de cumplimiento, Fase 4 §13.2).
async function progressFor(goal, target_id, period, metricDef) {
  const { CrmGoalProgress } = require('../models');

  const cached = await CrmGoalProgress.findOne({
    where: { goal_id: goal.id, target_id, period_start: period.period_start },
  });
  if (cached) return { current_value: parseFloat(cached.current_value), percent: parseFloat(cached.percent) };

  if (metricDef.point_in_time) return null; // recalcular hacia atrás daría el valor de hoy
  const fresh = await getOrRecalculateProgress(goal, target_id, period);
  return fresh ? { current_value: fresh.current_value, percent: fresh.percent } : null;
}

// Racha de períodos cerrados cumplidos consecutivos, terminando en
// `period` (inclusive). Mismo criterio que `streak` del endpoint de
// cumplimiento: un período sin dato corta la racha pero no cuenta como
// incumplido.
async function streakUpTo(goal, target_id, periods, endIndex, metricDef) {
  let streak = 0;
  for (let i = endIndex; i >= 0; i -= 1) {
    const entry = await progressFor(goal, target_id, periods[i], metricDef);
    if (!entry) break;
    if (entry.percent < 100) break;
    streak += 1;
  }
  return streak;
}

// ── Reparto de metas de equipo (§10.8) ──────────────────────────────────
async function resolveTargetUsers(goal, target_id) {
  const { User, UserBranch } = require('../models');

  if (goal.scope === 'individual') {
    const user = await User.findOne({
      where: { id: target_id, tenant_id: goal.tenant_id },
      attributes: ['id', 'email', 'cedula', 'is_active'],
    });
    return user ? [user] : [];
  }

  if (goal.scope === 'branch') {
    const links = await UserBranch.findAll({ where: { branch_id: target_id }, attributes: ['user_id'] });
    const ids = [...new Set(links.map(l => l.user_id))];
    if (!ids.length) return [];
    // Excluye técnicos sin acceso al sistema: nunca inician sesión, no
    // tienen sentido como destinatarios de metas/recompensas del CRM.
    return User.findAll({
      where: { id: { [Op.in]: ids }, tenant_id: goal.tenant_id, is_active: true, has_system_access: true },
      attributes: ['id', 'email', 'cedula', 'is_active'],
    });
  }

  // scope 'tenant': todo el equipo activo del negocio (con acceso al sistema)
  return User.findAll({
    where: { tenant_id: goal.tenant_id, is_active: true, has_system_access: true },
    attributes: ['id', 'email', 'cedula', 'is_active'],
  });
}

// Monto individual de cada persona a partir del monto total del tier.
async function splitAmount(goal, rule, users, totalAmount, period) {
  const mode = goal.scope === 'individual' ? 'individual' : rule.distribution_mode;

  if (mode === 'individual' || mode === 'monto_fijo_por_persona') {
    return new Map(users.map(u => [u.id, totalAmount]));
  }

  if (mode === 'equitativo') {
    const each = users.length ? Math.round((totalAmount / users.length) * 100) / 100 : 0;
    return new Map(users.map(u => [u.id, each]));
  }

  // 'proporcional': se pesa por el aporte individual a la MISMA métrica de
  // la meta durante el período. Si nadie aportó (suma 0), se cae a
  // equitativo en vez de repartir cero — el equipo cumplió igual.
  const metricDef = getMetric(goal.metric);
  const contributions = new Map();
  let total = 0;
  for (const u of users) {
    let value = 0;
    try {
      value = await metricDef.calculate({
        tenant_id: goal.tenant_id,
        scope: 'individual',
        target_id: u.id,
        period_start: period.period_start,
        period_end: period.period_end,
      });
    } catch {
      value = 0;
    }
    contributions.set(u.id, value);
    total += value;
  }

  if (!total) {
    const each = users.length ? Math.round((totalAmount / users.length) * 100) / 100 : 0;
    return new Map(users.map(u => [u.id, each]));
  }

  return new Map(users.map(u => [
    u.id,
    Math.round((totalAmount * (contributions.get(u.id) / total)) * 100) / 100,
  ]));
}

// Monto total del tier ganado, antes de repartir.
async function tierAmount(goal, rule, tier, target_id, period) {
  const value = parseFloat(tier.reward_value || 0);
  if (rule.reward_type === 'monto_fijo') return value;

  if (rule.reward_type === 'porcentaje_sobre_revenue_won') {
    const revenueMetric = getMetric('revenue_won');
    const revenue = await revenueMetric.calculate({
      tenant_id: goal.tenant_id,
      scope: goal.scope,
      target_id,
      period_start: period.period_start,
      period_end: period.period_end,
    });
    return Math.round((revenue * (value / 100)) * 100) / 100;
  }

  return null; // insignia/titulo
}

// ── Carga a nómina (§10.4) ──────────────────────────────────────────────
async function tenantHasPayroll(tenant_id) {
  const { getEffectiveModulesForTenantId } = require('./moduleAccess');
  const modules = await getEffectiveModulesForTenantId(tenant_id);
  return modules.includes('payroll');
}

// Período de nómina que cubre la fecha de cierre de la meta y todavía
// admite novedades. 'emitido'/'cerrado' ya no: la novedad no entraría en
// ninguna liquidación.
async function findOpenPayrollPeriod(tenant_id, dateStr) {
  const { PayrollPeriod } = require('../models');
  return PayrollPeriod.findOne({
    where: {
      tenant_id,
      status: { [Op.in]: ['abierto', 'liquidado'] },
      start_date: { [Op.lte]: dateStr },
      end_date: { [Op.gte]: dateStr },
    },
    order: [['start_date', 'DESC']],
  });
}

// Lleva una recompensa APROBADA hasta nómina. Idempotente: si ya tiene
// novedad, no hace nada. Devuelve el estado final.
async function chargeRewardToPayroll(reward, { rule = null, employee = null } = {}) {
  const { CrmReward, CrmRewardRule, PayrollNovedad, User, CrmGoal } = require('../models');

  if (reward.payroll_novedad_id) return reward.status;
  if (!['aprobada', 'aprobada_pendiente_nomina', 'sin_empleado_vinculado'].includes(reward.status)) {
    return reward.status;
  }

  const theRule = rule || await CrmRewardRule.findByPk(reward.reward_rule_id);
  if (!theRule) return reward.status;

  if (!(await tenantHasPayroll(reward.tenant_id))) {
    // Sin módulo de nómina la recompensa se queda aprobada y el admin la
    // paga por fuera — no hay más automatismo que inventar (§10.4).
    await reward.update({ status: 'aprobada', last_error: null });
    return reward.status;
  }

  let emp = employee;
  if (!emp) {
    if (reward.employee_id) {
      const { Employee } = require('../models');
      emp = await Employee.findByPk(reward.employee_id);
    } else {
      const user = await User.findByPk(reward.user_id, { attributes: ['id', 'email', 'cedula'] });
      const map = user ? await mapUsersToEmployees(reward.tenant_id, [user]) : new Map();
      emp = map.get(reward.user_id) || null;
    }
  }

  if (!emp) {
    await reward.update({
      status: 'sin_empleado_vinculado',
      last_error: 'No se encontró un empleado de nómina con el mismo email o documento que el vendedor',
    });
    return reward.status;
  }

  const period = await findOpenPayrollPeriod(reward.tenant_id, reward.period_end);
  if (!period) {
    await reward.update({
      employee_id: emp.id,
      status: 'aprobada_pendiente_nomina',
      last_error: 'No hay un período de nómina abierto que cubra la fecha de cierre de la meta',
    });
    return reward.status;
  }

  const goal = await CrmGoal.findByPk(reward.goal_id, { attributes: ['name'] });
  const amount = parseFloat(reward.amount || 0);
  const payloadKey = theRule.bonus_salary_type === 'salarial' ? 'bonificacionS' : 'bonificacionNS';

  const novedad = await PayrollNovedad.create({
    tenant_id: reward.tenant_id,
    employee_id: emp.id,
    payroll_period_id: period.id,
    payroll_concept_id: theRule.payroll_concept_id || null,
    // 'Bonificaciones' es kind 'array' en DIAN_CATEGORY_MAP
    // (services/payroll/payrollService.js): el payload se empuja tal cual
    // dentro del arreglo de bonificaciones del XML.
    dian_category: 'Bonificaciones',
    payload: { [payloadKey]: amount },
    notes: `Recompensa automática — Meta: ${goal ? goal.name : reward.goal_id}${reward.tier_applied ? ` — ${reward.tier_applied}` : ''}`,
    created_by: reward.approved_by_user_id || null,
  });

  await reward.update({
    employee_id: emp.id,
    payroll_novedad_id: novedad.id,
    status: 'cargada_nomina',
    last_error: null,
  });

  return reward.status;
}

// Estado inicial de una recompensa recién creada + intento de carga.
async function finalizeReward(reward, rule, employee) {
  if (!rule.isMonetary || !rule.isMonetary()) {
    // insignia/titulo: no hay nada que aprobar ni que cargar (§10.7)
    await reward.update({ status: 'otorgada' });
    return reward;
  }

  if (!rule.auto_approve) {
    await reward.update({ status: 'pendiente_aprobacion' });
    return reward;
  }

  await reward.update({ status: 'aprobada', approved_at: new Date() });
  await chargeRewardToPayroll(reward, { rule, employee });
  return reward;
}

// ── Evaluación por tenant ───────────────────────────────────────────────
async function evaluateTenantRewards(tenant_id, results, { now = new Date() } = {}) {
  const { CrmRewardRule, CrmGoal, CrmReward, Branch } = require('../models');

  const rules = await CrmRewardRule.findAll({ where: { tenant_id, active: true } });
  if (!rules.length) return;

  const today = todayStr();

  for (const rule of rules) {
    try {
      const goal = await CrmGoal.findOne({ where: { id: rule.goal_id, tenant_id } });
      if (!goal) continue;

      const periods = listRecentPeriods(goal, STREAK_LOOKBACK_PERIODS, now);
      // Solo períodos YA CERRADOS: una recompensa sobre un período en curso
      // se pagaría sobre un número que todavía puede bajar.
      const closedIdx = periods.reduce(
        (acc, p, i) => (!p.is_current && p.period_end < today ? i : acc), -1
      );
      if (closedIdx < 0) continue;
      const period = periods[closedIdx];

      const metricDef = getMetric(goal.metric);
      if (!metricDef) continue;

      // Targets de la meta: vendedores, sedes o el tenant entero.
      let targetIds = [];
      if (goal.scope === 'tenant') {
        targetIds = [tenant_id];
      } else if (goal.scope === 'branch') {
        const branches = await Branch.findAll({ where: { tenant_id }, attributes: ['id'] });
        targetIds = branches.map(b => b.id);
      } else {
        const { User } = require('../models');
        const users = await User.findAll({ where: { tenant_id, is_active: true, has_system_access: true }, attributes: ['id'] });
        targetIds = users.map(u => u.id);
      }

      for (const target_id of targetIds) {
        const entry = await progressFor(goal, target_id, period, metricDef);
        if (!entry) continue;

        const streak = await streakUpTo(goal, target_id, periods, closedIdx, metricDef);
        if (!conditionMet(rule, { percent: entry.percent, streak })) continue;

        const tier = resolveTier(rule, { streak, percent: entry.percent });
        if (!tier) continue; // cumplió la condición pero ningún tier aplica

        const users = await resolveTargetUsers(goal, target_id);
        if (!users.length) continue;

        const total = await tierAmount(goal, rule, tier, target_id, period);
        const amounts = rule.isMonetary()
          ? await splitAmount(goal, rule, users, total, period)
          : new Map();

        const groupId = goal.scope === 'individual' ? null : crypto.randomUUID();
        const employeeMap = rule.isMonetary()
          ? await mapUsersToEmployees(tenant_id, users)
          : new Map();

        for (const user of users) {
          // El índice único (regla, usuario, período) es la garantía real de
          // idempotencia; findOrCreate lo aprovecha en vez de confiar en un
          // chequeo previo que podría correr dos veces en paralelo.
          const [reward, created] = await CrmReward.findOrCreate({
            where: { reward_rule_id: rule.id, user_id: user.id, period_start: period.period_start },
            defaults: {
              tenant_id,
              goal_id: goal.id,
              reward_rule_id: rule.id,
              user_id: user.id,
              period_start: period.period_start,
              period_end: period.period_end,
              tier_applied: tier.condition,
              amount: rule.isMonetary() ? (amounts.get(user.id) || 0) : null,
              badge_config: rule.isMonetary() ? null : (rule.badge_config || null),
              distribution_group_id: groupId,
              employee_id: employeeMap.get(user.id)?.id || null,
              status: 'pendiente_aprobacion',
            },
          });

          if (!created) continue; // ya se había otorgado en una corrida anterior

          await finalizeReward(reward, rule, employeeMap.get(user.id) || null);
          results.rewardsCreated += 1;
        }
      }
    } catch (err) {
      results.errors += 1;
      console.error(`❌ [CRM rewards] Error evaluando regla ${rule.id}:`, err.message);
    }
  }
}

// Reintenta las que quedaron esperando algo: un período de nómina que se
// abrió después, o un empleado que el admin acabó de corregir. Es la otra
// mitad de §10.4: "se reintenta cuando se abra un período".
async function retryPendingPayroll(tenant_id, results) {
  const { CrmReward, CrmRewardRule } = require('../models');

  const pending = await CrmReward.findAll({
    where: {
      tenant_id,
      status: { [Op.in]: ['aprobada', 'aprobada_pendiente_nomina', 'sin_empleado_vinculado'] },
      payroll_novedad_id: null,
    },
    limit: 200,
  });

  for (const reward of pending) {
    try {
      const rule = await CrmRewardRule.findByPk(reward.reward_rule_id);
      if (!rule || !rule.isMonetary()) continue;
      const before = reward.status;
      const after = await chargeRewardToPayroll(reward, { rule });
      if (after === 'cargada_nomina' && before !== after) results.chargedToPayroll += 1;
    } catch (err) {
      results.errors += 1;
      console.error(`❌ [CRM rewards] Error reintentando recompensa ${reward.id}:`, err.message);
    }
  }
}

// ── Job ─────────────────────────────────────────────────────────────────
// Mismo patrón multi-schema que crmLifecycleService.runCrmLifecycleJob().
async function runCrmRewardsJob({ now = new Date() } = {}) {
  const Tenant = require('../models/auth/Tenant');
  const { runWithTenantSchema } = require('../config/tenantContext');
  const { getEffectiveModulesForTenantId } = require('./moduleAccess');

  const results = { rewardsCreated: 0, chargedToPayroll: 0, errors: 0, tenantsSkipped: 0 };
  const allTenants = await Tenant.findAll({ attributes: ['id', 'schema_name', 'company_name'] });

  for (const tenant of allTenants) {
    const modules = await getEffectiveModulesForTenantId(tenant.id);
    if (!modules.includes('crm')) {
      results.tenantsSkipped += 1;
      continue;
    }

    const work = async () => {
      await evaluateTenantRewards(tenant.id, results, { now });
      await retryPendingPayroll(tenant.id, results);
    };

    try {
      if (tenant.schema_name) {
        await runWithTenantSchema(tenant.schema_name, work);
      } else {
        await work();
      }
    } catch (err) {
      results.errors += 1;
      console.error(`❌ [CRM rewards] Error procesando tenant "${tenant.schema_name || tenant.id}":`, err.message);
    }
  }

  console.log(`✅ [CRM rewards] Recompensas creadas: ${results.rewardsCreated} | Cargadas a nómina: ${results.chargedToPayroll} | Tenants sin CRM: ${results.tenantsSkipped} | Errores: ${results.errors}`);
  return results;
}

module.exports = {
  runCrmRewardsJob,
  evaluateTenantRewards,
  retryPendingPayroll,
  chargeRewardToPayroll,
  finalizeReward,
  resolveTier,
  parseTierCondition,
  conditionMet,
  findOpenPayrollPeriod,
};