// backend/src/controllers/crm/goals.controller.js
//
// CRM — Gamificación, Fases 1/3/4. Ver gamificacion-crm-diseno.md §6-8.
// CRUD de CrmGoal (config, admin/manager) + endpoint de progreso vigente y
// endpoint de cumplimiento histórico (Fase 4), ambos respetando
// CrmGamificationSettings.board_visibility (admin/super_admin siempre ven
// todo, vía SCOPE_BYPASS_ROLES de utils/crmScope.js).
const logger = require('../../config/logger');
const { Op } = require('sequelize');
const { CrmGoal, CrmGoalProgress, CrmGamificationSettings, User, Branch, UserBranch } = require('../../models');
const { sellersInManagerBranches, SCOPE_BYPASS_ROLES } = require('../../utils/crmScope');
const { listMetrics, getMetric } = require('../../utils/crmGoalMetrics');
const { resolveCurrentPeriod, listRecentPeriods } = require('../../utils/crmGoalPeriods');
const { getOrRecalculateProgress } = require('../../services/crmGamificationService');
const { buildGoalAlert } = require('../../utils/crmGoalAlerts');

const CAN_MANAGE = ['admin', 'manager', 'super_admin'];

// Fase 4 (§6) — cuántos períodos hacia atrás puede pedir el dashboard de
// cumplimiento. El tope existe porque cada período extra multiplica las
// filas leídas de CrmGoalProgress por cada target visible.
const DEFAULT_COMPLIANCE_PERIODS = 6;
const MAX_COMPLIANCE_PERIODS = 24;

async function getOrDefaultSettings(tenant_id) {
  const settings = await CrmGamificationSettings.findOne({ where: { tenant_id } });
  if (settings) return settings;
  // Sin registro todavía: default conservador (cada quien ve lo suyo,
  // gamificación activa) — ver CrmGamificationSettings.js.
  return { tenant_id, board_visibility: 'own_only', enabled: true };
}

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const goals = await CrmGoal.findAll({
      where: { tenant_id, active: true },
      order: [['goal_type', 'ASC'], ['created_at', 'DESC']],
    });
    res.json({ success: true, data: goals, metrics_catalog: listMetrics() });
  } catch (error) {
    logger.error('Error listando metas CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las metas' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const {
      name, goal_type, metric, scope, target_value, period_type,
      starts_at, ends_at, milestones, icon_style,
    } = req.body;

    if (!name || !metric || !target_value || !period_type) {
      return res.status(400).json({ success: false, message: 'name, metric, target_value y period_type son requeridos' });
    }
    if (!getMetric(metric)) {
      return res.status(400).json({ success: false, message: `Métrica desconocida: ${metric}` });
    }
    if (period_type === 'custom' && (!starts_at || !ends_at)) {
      return res.status(400).json({ success: false, message: 'starts_at y ends_at son requeridos cuando period_type es "custom"' });
    }

    const goal = await CrmGoal.create({
      tenant_id,
      name,
      goal_type: goal_type || 'secundaria',
      metric,
      scope: scope || 'individual',
      target_value,
      period_type,
      starts_at: period_type === 'custom' ? starts_at : null,
      ends_at: period_type === 'custom' ? ends_at : null,
      milestones: Array.isArray(milestones) ? milestones : [],
      icon_style: icon_style || null,
      created_by_user_id: req.user.id,
    });

    res.status(201).json({ success: true, message: 'Meta creada', data: goal });
  } catch (error) {
    logger.error('Error creando meta CRM:', error);
    res.status(500).json({ success: false, message: 'Error al crear la meta' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const goal = await CrmGoal.findOne({ where: { id: req.params.id, tenant_id } });
    if (!goal) return res.status(404).json({ success: false, message: 'Meta no encontrada' });

    const {
      name, goal_type, target_value, period_type, starts_at, ends_at,
      milestones, icon_style, active,
    } = req.body;

    if (req.body.metric !== undefined && !getMetric(req.body.metric)) {
      return res.status(400).json({ success: false, message: `Métrica desconocida: ${req.body.metric}` });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (goal_type !== undefined) updateData.goal_type = goal_type;
    if (req.body.metric !== undefined) updateData.metric = req.body.metric;
    if (req.body.scope !== undefined) updateData.scope = req.body.scope;
    if (target_value !== undefined) updateData.target_value = target_value;
    if (period_type !== undefined) updateData.period_type = period_type;
    if (starts_at !== undefined) updateData.starts_at = starts_at;
    if (ends_at !== undefined) updateData.ends_at = ends_at;
    if (milestones !== undefined) updateData.milestones = milestones;
    if (icon_style !== undefined) updateData.icon_style = icon_style;
    if (active !== undefined) updateData.active = active;

    await goal.update(updateData);
    res.json({ success: true, message: 'Meta actualizada', data: goal });
  } catch (error) {
    logger.error('Error actualizando meta CRM:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la meta' });
  }
};

// "Eliminar" una meta es desactivarla, no borrarla — conserva el histórico
// de CrmGoalProgress para el dashboard de cumplimiento (§6, Fase 4).
const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const goal = await CrmGoal.findOne({ where: { id: req.params.id, tenant_id } });
    if (!goal) return res.status(404).json({ success: false, message: 'Meta no encontrada' });

    await goal.update({ active: false });
    res.json({ success: true, message: 'Meta desactivada' });
  } catch (error) {
    logger.error('Error desactivando meta CRM:', error);
    res.status(500).json({ success: false, message: 'Error al desactivar la meta' });
  }
};

// Resuelve qué target_id son visibles para el usuario actual, según el
// scope de la meta y CrmGamificationSettings.board_visibility (§5.3).
async function resolveVisibleTargets(goal, req, settings) {
  const { tenant_id, id: userId, role } = req.user;
  const bypass = SCOPE_BYPASS_ROLES.includes(role);

  if (goal.scope === 'tenant') return [tenant_id];

  if (goal.scope === 'branch') {
    if (bypass) {
      const branches = await Branch.findAll({ where: { tenant_id }, attributes: ['id'] });
      return branches.map(b => b.id);
    }
    const ownBranches = await UserBranch.findAll({ where: { user_id: userId }, attributes: ['branch_id'] });
    return ownBranches.map(b => b.branch_id);
  }

  // scope === 'individual'
  if (bypass || settings.board_visibility === 'all') {
    // Excluye técnicos sin acceso al sistema (nunca aparecen en metas).
    const sellers = await User.findAll({ where: { tenant_id, is_active: true, has_system_access: true }, attributes: ['id'] });
    return sellers.map(u => u.id);
  }
  if (settings.board_visibility === 'team' && role === 'manager') {
    return sellersInManagerBranches(tenant_id, userId);
  }
  return [userId];
}

// Fase 3 (§5.1/§5.3) — GoalPathWidget necesita nombre de vendedor/sede para
// dibujar el avatar sobre el camino y las filas del tablero general. El
// endpoint (Fase 1) solo devolvía target_id. Se resuelve acá en lote (una
// sola consulta por meta, no una por entrada) para no volver esto costoso.
async function attachTargetLabels(goal, entries) {
  if (!entries.length || goal.scope === 'tenant') {
    return entries.map(e => ({ ...e, target_label: null }));
  }

  const ids = entries.map(e => e.target_id);
  if (goal.scope === 'individual') {
    const users = await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'first_name', 'last_name'] });
    const map = Object.fromEntries(users.map(u => [u.id, `${u.first_name || ''} ${u.last_name || ''}`.trim() || null]));
    return entries.map(e => ({ ...e, target_label: map[e.target_id] || null }));
  }

  // scope === 'branch'
  const branches = await Branch.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'name'] });
  const map = Object.fromEntries(branches.map(b => [b.id, b.name]));
  return entries.map(e => ({ ...e, target_label: map[e.target_id] || null }));
}

// GET /api/crm/goals/progress — progreso vigente de las metas visibles.
const getProgress = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const settings = await getOrDefaultSettings(tenant_id);
    if (!settings.enabled) {
      return res.json({ success: true, data: [], gamification_enabled: false });
    }

    const goals = await CrmGoal.findAll({ where: { tenant_id, active: true } });
    const result = [];

    for (const goal of goals) {
      const period = resolveCurrentPeriod(goal);
      if (!period) continue; // meta custom fuera de su ventana vigente

      const targetIds = await resolveVisibleTargets(goal, req, settings);
      if (!targetIds.length) continue;

      const rawEntries = await Promise.all(
        targetIds.map(target_id => getOrRecalculateProgress(goal, target_id, period))
      );
      const entries = await attachTargetLabels(goal, rawEntries.filter(Boolean));

      result.push({
        goal_id: goal.id,
        name: goal.name,
        goal_type: goal.goal_type,
        metric: goal.metric,
        scope: goal.scope,
        target_value: parseFloat(goal.target_value),
        period_type: goal.period_type,
        period,
        icon_style: goal.icon_style,
        milestones: goal.milestones,
        entries,
      });
    }

    res.json({ success: true, data: result, gamification_enabled: true, board_visibility: settings.board_visibility });
  } catch (error) {
    logger.error('Error obteniendo progreso de metas CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el progreso de las metas' });
  }
};

// ── Fase 4 (§6) — Cumplimiento de metas ──────────────────────────────────
// Vista de decisiones: vendedor/sede → meta → objetivo → alcanzado → % →
// tendencia vs. período anterior, más el histórico de períodos cerrados
// (cumplidos / no cumplidos). No inventa una regla de visibilidad nueva:
// reutiliza resolveVisibleTargets(), la misma de GET /goals/progress, así
// que un vendedor ve su propio histórico, un manager el de su(s) sede(s) y
// admin/super_admin todo (SCOPE_BYPASS_ROLES).

const pctNum = v => (v == null ? null : Math.round(parseFloat(v) * 100) / 100);

function entryFromRow(row) {
  if (!row) return null;
  return {
    current_value: parseFloat(row.current_value),
    percent: pctNum(row.percent),
  };
}

// Racha de períodos CERRADOS cumplidos consecutivos, contando hacia atrás
// desde el más reciente ya cerrado. El período vigente no cuenta: todavía
// puede cambiar (esto es justo lo que la Fase 5 necesitará para evaluar
// condiciones de tipo `racha`, §10.2).
function closedStreak(history) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (h.is_current) continue;
    if (h.percent == null) break;   // sin dato: se corta, no se asume incumplida
    if (!h.achieved) break;
    streak += 1;
  }
  return streak;
}

const getCompliance = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const settings = await getOrDefaultSettings(tenant_id);
    if (!settings.enabled) {
      return res.json({ success: true, data: [], gamification_enabled: false });
    }

    const requested = parseInt(req.query.periods, 10);
    const periodsCount = Math.min(
      MAX_COMPLIANCE_PERIODS,
      Math.max(2, Number.isFinite(requested) ? requested : DEFAULT_COMPLIANCE_PERIODS)
    );
    // Las metas desactivadas conservan su histórico (remove() solo pone
    // active=false) — el admin puede querer revisar cómo fue una campaña
    // que ya cerró, así que se incluyen bajo demanda.
    const includeInactive = String(req.query.include_inactive) === 'true';

    const goalWhere = { tenant_id };
    if (!includeInactive) goalWhere.active = true;

    const goals = await CrmGoal.findAll({
      where: goalWhere,
      order: [['goal_type', 'ASC'], ['created_at', 'DESC']],
    });

    const today = new Date().toISOString().slice(0, 10);
    const data = [];

    for (const goal of goals) {
      const metricDef = getMetric(goal.metric);
      if (!metricDef) continue; // métrica retirada del catálogo

      const periods = listRecentPeriods(goal, periodsCount);
      if (!periods.length) continue; // custom sin fechas: nada que mostrar

      const targetIds = await resolveVisibleTargets(goal, req, settings);
      if (!targetIds.length) continue;

      // Una sola consulta por meta para todo el histórico visible, en vez
      // de una por (target, período).
      const cachedRows = await CrmGoalProgress.findAll({
        where: {
          goal_id: goal.id,
          target_id: { [Op.in]: targetIds },
          period_start: { [Op.in]: periods.map(p => p.period_start) },
        },
      });
      const cache = new Map(cachedRows.map(r => [`${r.target_id}|${r.period_start}`, r]));

      const currentIdx = periods.findIndex(p => p.is_current);
      const current = currentIdx >= 0 ? periods[currentIdx] : periods[periods.length - 1];
      const previous = currentIdx >= 0
        ? (periods[currentIdx - 1] || null)
        : (periods[periods.length - 2] || null);
      const isLive = !!current.is_current;

      const rawEntries = [];

      for (const target_id of targetIds) {
        const fresh = new Map();

        // Período vigente: se recalcula en vivo (misma función que usa
        // GET /goals/progress), para que la tabla de decisiones no muestre
        // una caché vieja. Un período ya cerrado nunca se recalcula acá si
        // la métrica es point_in_time (§ catálogo): daría el valor de hoy.
        if (isLive) {
          const live = await getOrRecalculateProgress(goal, target_id, current);
          if (live) fresh.set(current.period_start, { current_value: live.current_value, percent: pctNum(live.percent) });
        }

        // Período anterior: si nunca se cacheó (la meta se creó después, o
        // nadie consultó ni movió nada en ese lapso) se reconstruye una
        // sola vez — es el dato que sostiene la columna de tendencia (§6).
        if (previous && !cache.has(`${target_id}|${previous.period_start}`) && !metricDef.point_in_time
            && previous.period_start <= today) {
          const back = await getOrRecalculateProgress(goal, target_id, previous);
          if (back) fresh.set(previous.period_start, { current_value: back.current_value, percent: pctNum(back.percent) });
        }

        const history = periods.map((p) => {
          const entry = fresh.get(p.period_start) || entryFromRow(cache.get(`${target_id}|${p.period_start}`));
          return {
            period_start: p.period_start,
            period_end: p.period_end,
            is_current: !!p.is_current,
            current_value: entry ? entry.current_value : null,
            percent: entry ? entry.percent : null,
            achieved: entry ? entry.percent >= 100 : null,
          };
        });

        const currentEntry = history.find(h => h.period_start === current.period_start) || null;
        const previousEntry = previous ? history.find(h => h.period_start === previous.period_start) : null;

        const percent = currentEntry ? currentEntry.percent : null;
        const previousPercent = previousEntry ? previousEntry.percent : null;
        const deltaPercent = (percent != null && previousPercent != null)
          ? Math.round((percent - previousPercent) * 100) / 100
          : null;

        const closed = history.filter(h => !h.is_current && h.percent != null);

        rawEntries.push({
          target_id,
          current_value: currentEntry ? currentEntry.current_value : null,
          percent,
          achieved: currentEntry ? currentEntry.achieved : null,
          previous_percent: previousPercent,
          delta_percent: deltaPercent,
          // Punto de partida en puntos porcentuales, no en %, para no
          // sugerir un crecimiento relativo que no se midió así.
          trend: deltaPercent == null ? null : (deltaPercent > 0.5 ? 'up' : (deltaPercent < -0.5 ? 'down' : 'flat')),
          periods_evaluated: closed.length,
          periods_achieved: closed.filter(h => h.achieved).length,
          streak: closedStreak(history),
          history,
        });
      }

      const entries = (await attachTargetLabels(goal, rawEntries))
        .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));

      const withPercent = entries.filter(e => e.percent != null);
      const totalClosed = entries.reduce((s, e) => s + e.periods_evaluated, 0);
      const totalAchieved = entries.reduce((s, e) => s + e.periods_achieved, 0);

      data.push({
        goal_id: goal.id,
        name: goal.name,
        goal_type: goal.goal_type,
        active: goal.active,
        metric: goal.metric,
        metric_label: metricDef.label,
        metric_inverted: !!metricDef.inverted,
        metric_point_in_time: !!metricDef.point_in_time,
        scope: goal.scope,
        target_value: parseFloat(goal.target_value),
        period_type: goal.period_type,
        current_period: current,
        previous_period: previous,
        periods,
        entries,
        summary: {
          targets: entries.length,
          achieved_now: entries.filter(e => e.achieved).length,
          avg_percent: withPercent.length
            ? Math.round((withPercent.reduce((s, e) => s + e.percent, 0) / withPercent.length) * 100) / 100
            : null,
          total_current_value: withPercent.reduce((s, e) => s + (e.current_value || 0), 0),
          historic_periods_evaluated: totalClosed,
          historic_periods_achieved: totalAchieved,
          historic_achievement_rate: totalClosed
            ? Math.round((totalAchieved / totalClosed) * 10000) / 100
            : null,
        },
      });
    }

    res.json({
      success: true,
      data,
      gamification_enabled: true,
      board_visibility: settings.board_visibility,
      periods_requested: periodsCount,
    });
  } catch (error) {
    logger.error('Error obteniendo cumplimiento de metas CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el cumplimiento de las metas' });
  }
};

// ── Fase 6 (alertas de vencimiento) ──────────────────────────────────────
// A diferencia de getProgress/getCompliance (qué puedo VER), esto resuelve
// qué metas aplican a MÍ como persona — mi target individual, la(s) sede(s)
// a la(s) que pertenezco, y las metas de todo el tenant. board_visibility
// no entra acá: un vendedor con visibilidad 'own_only' igual necesita
// enterarse de que su propia meta está por vencer.
async function resolveMyTargetIds(goal, req) {
  const { tenant_id, id: userId } = req.user;

  if (goal.scope === 'individual') return [userId];
  if (goal.scope === 'tenant') return [tenant_id];

  // scope === 'branch': todas las sedes a las que pertenezco. Admin/super_admin
  // sin sede asignada no reciben alerta de sede — no son "el responsable" de
  // ninguna en particular; ya ven todo en el tablero de cumplimiento (§6).
  const links = await UserBranch.findAll({ where: { user_id: userId }, attributes: ['branch_id'] });
  return [...new Set(links.map(l => l.branch_id))];
}

// GET /api/crm/goals/alerts — metas propias con período por vencer y
// cuánto falta para la meta. Sin filtro de urgencia: el frontend decide qué
// tan visible lo hace (bandeja completa vs. solo lo crítico en la campana).
const getGoalAlerts = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const settings = await getOrDefaultSettings(tenant_id);
    if (!settings.enabled) {
      return res.json({ success: true, data: [], gamification_enabled: false });
    }

    const goals = await CrmGoal.findAll({ where: { tenant_id, active: true } });
    const alerts = [];

    for (const goal of goals) {
      const metricDef = getMetric(goal.metric);
      if (!metricDef) continue;

      const period = resolveCurrentPeriod(goal);
      if (!period) continue; // meta custom fuera de su ventana vigente

      const targetIds = await resolveMyTargetIds(goal, req);
      if (!targetIds.length) continue;

      for (const target_id of targetIds) {
        const entry = await getOrRecalculateProgress(goal, target_id, period);
        const alert = buildGoalAlert({ goal, metricDef, period, entry });
        if (alert) alerts.push(alert);
      }
    }

    // Más urgente primero, y a igual urgencia, menos días primero.
    alerts.sort((a, b) => {
      if (a.urgency !== b.urgency) return a.urgency === 'critica' ? -1 : 1;
      return a.days_remaining - b.days_remaining;
    });

    res.json({
      success: true,
      data: alerts,
      gamification_enabled: true,
      summary: {
        total: alerts.length,
        criticas: alerts.filter(a => a.urgency === 'critica').length,
      },
    });
  } catch (error) {
    logger.error('Error obteniendo alertas de metas CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las alertas de metas' });
  }
};

module.exports = { list, create, update, remove, getProgress, getCompliance, getGoalAlerts, CAN_MANAGE };