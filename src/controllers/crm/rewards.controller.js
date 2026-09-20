// backend/src/controllers/crm/rewards.controller.js
//
// CRM — Gamificación, Fase 5. Ver gamificacion-crm-diseno.md §10.3/§10.5/§10.7.
// Consulta de recompensas ganadas + acciones del admin (aprobar, reintentar
// carga a nómina). Dos reglas de visibilidad distintas conviven acá a
// propósito:
//   - Recompensas monetarias → applyOwnershipScope de utils/crmScope.js, tal
//     cual el resto del CRM (vendedor lo suyo, manager su sede, admin todo).
//   - Insignias/títulos → visibilidad del TABLERO (board_visibility), porque
//     su objetivo es justamente hacer resaltar a la persona frente al equipo
//     (§10.7). Si se escondieran como el dinero, no servirían de nada.
const logger = require('../../config/logger');
const { Op } = require('sequelize');
const {
  CrmReward, CrmRewardRule, CrmGoal, CrmGamificationSettings,
  User, PayrollNovedad, PayrollPeriod,
} = require('../../models');
const { applyOwnershipScope, sellersInManagerBranches, SCOPE_BYPASS_ROLES } = require('../../utils/crmScope');
const { chargeRewardToPayroll } = require('../../services/crmRewardService');
const { listUnmatchedUsers, findEmployeeForUser } = require('../../utils/crmRewardMatching');

const CAN_MANAGE = ['admin', 'manager', 'super_admin'];
const MONETARY_TYPES = ['monto_fijo', 'porcentaje_sobre_revenue_won'];

// "Pagada" no es un estado propio: se deriva del PayrollPeriod vinculado a
// la novedad (§10.4, punto 4), para que no pueda desincronizarse de la
// nómina real.
async function attachPaidFlag(rewards) {
  const novedadIds = rewards.map(r => r.payroll_novedad_id).filter(Boolean);
  if (!novedadIds.length) return rewards.map(r => ({ ...r, paid: false, payroll_period_status: null }));

  const novedades = await PayrollNovedad.findAll({
    where: { id: { [Op.in]: novedadIds } },
    attributes: ['id', 'payroll_period_id'],
  });
  const periodIds = [...new Set(novedades.map(n => n.payroll_period_id))];
  const periods = periodIds.length
    ? await PayrollPeriod.findAll({ where: { id: { [Op.in]: periodIds } }, attributes: ['id', 'status'] })
    : [];

  const periodById = Object.fromEntries(periods.map(p => [p.id, p.status]));
  const statusByNovedad = Object.fromEntries(novedades.map(n => [n.id, periodById[n.payroll_period_id] || null]));

  return rewards.map((r) => {
    const status = r.payroll_novedad_id ? statusByNovedad[r.payroll_novedad_id] || null : null;
    return { ...r, payroll_period_status: status, paid: ['emitido', 'cerrado'].includes(status) };
  });
}

function userLabel(user) {
  if (!user) return null;
  return `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email || null;
}

// GET /api/crm/rewards
const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const where = await applyOwnershipScope(req, { tenant_id }, 'user_id');

    if (req.query.status) where.status = req.query.status;
    if (req.query.goal_id) where.goal_id = req.query.goal_id;
    if (req.query.from) where.period_start = { [Op.gte]: req.query.from };

    const rows = await CrmReward.findAll({
      where,
      order: [['period_start', 'DESC'], ['created_at', 'DESC']],
      limit: Math.min(500, parseInt(req.query.limit, 10) || 200),
    });

    const ruleIds = [...new Set(rows.map(r => r.reward_rule_id))];
    const goalIds = [...new Set(rows.map(r => r.goal_id))];
    const userIds = [...new Set(rows.map(r => r.user_id))];

    const [rules, goals, users] = await Promise.all([
      ruleIds.length ? CrmRewardRule.findAll({ where: { id: { [Op.in]: ruleIds } } }) : [],
      goalIds.length ? CrmGoal.findAll({ where: { id: { [Op.in]: goalIds } }, attributes: ['id', 'name', 'scope', 'metric'] }) : [],
      userIds.length ? User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'first_name', 'last_name', 'email'] }) : [],
    ]);

    const ruleById = Object.fromEntries(rules.map(r => [r.id, r]));
    const goalById = Object.fromEntries(goals.map(g => [g.id, g]));
    const userById = Object.fromEntries(users.map(u => [u.id, u]));

    const plain = rows.map((r) => {
      const rule = ruleById[r.reward_rule_id];
      const goal = goalById[r.goal_id];
      return {
        id: r.id,
        user_id: r.user_id,
        user_label: userLabel(userById[r.user_id]),
        goal_id: r.goal_id,
        goal_name: goal ? goal.name : null,
        goal_scope: goal ? goal.scope : null,
        rule_id: r.reward_rule_id,
        rule_name: rule ? rule.name : null,
        reward_type: rule ? rule.reward_type : null,
        bonus_salary_type: rule ? rule.bonus_salary_type : null,
        auto_approve: rule ? rule.auto_approve : null,
        distribution_group_id: r.distribution_group_id,
        period_start: r.period_start,
        period_end: r.period_end,
        tier_applied: r.tier_applied,
        amount: r.amount == null ? null : parseFloat(r.amount),
        badge_config: r.badge_config,
        status: r.status,
        employee_id: r.employee_id,
        payroll_novedad_id: r.payroll_novedad_id,
        last_error: r.last_error,
        approved_at: r.approved_at,
        created_at: r.created_at,
      };
    });

    const data = await attachPaidFlag(plain);

    res.json({
      success: true,
      data,
      summary: {
        total: data.length,
        pendientes_aprobacion: data.filter(r => r.status === 'pendiente_aprobacion').length,
        sin_empleado: data.filter(r => r.status === 'sin_empleado_vinculado').length,
        pendientes_nomina: data.filter(r => r.status === 'aprobada_pendiente_nomina').length,
        monto_total: data.reduce((s, r) => s + (r.amount || 0), 0),
      },
    });
  } catch (error) {
    logger.error('Error listando recompensas CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las recompensas' });
  }
};

// GET /api/crm/rewards/badges — vitrina de logros (§10.7). Visibilidad del
// TABLERO, no la restringida del dinero.
const listBadges = async (req, res) => {
  try {
    const { tenant_id, id: userId, role } = req.user;
    const settings = await CrmGamificationSettings.findOne({ where: { tenant_id } });
    const visibility = settings ? settings.board_visibility : 'own_only';
    const bypass = SCOPE_BYPASS_ROLES.includes(role);

    let visibleUserIds = null; // null = todos
    if (!bypass && visibility !== 'all') {
      visibleUserIds = (visibility === 'team' && role === 'manager')
        ? await sellersInManagerBranches(tenant_id, userId)
        : [userId];
    }

    const where = {
      tenant_id,
      status: 'otorgada',
      badge_config: { [Op.ne]: null },
    };
    if (req.query.user_id) {
      where.user_id = req.query.user_id;
      if (visibleUserIds && !visibleUserIds.includes(req.query.user_id)) {
        return res.json({ success: true, data: [] });
      }
    } else if (visibleUserIds) {
      where.user_id = { [Op.in]: visibleUserIds };
    }

    const rows = await CrmReward.findAll({ where, order: [['period_end', 'DESC']], limit: 300 });
    const userIds = [...new Set(rows.map(r => r.user_id))];
    const users = userIds.length
      ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'first_name', 'last_name', 'email'] })
      : [];
    const userById = Object.fromEntries(users.map(u => [u.id, u]));

    res.json({
      success: true,
      data: rows.map(r => ({
        id: r.id,
        user_id: r.user_id,
        user_label: userLabel(userById[r.user_id]),
        badge_config: r.badge_config,
        goal_id: r.goal_id,
        period_start: r.period_start,
        period_end: r.period_end,
        awarded_at: r.created_at,
      })),
      board_visibility: visibility,
    });
  } catch (error) {
    logger.error('Error listando insignias CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las insignias' });
  }
};

// POST /api/crm/rewards/:id/approve — aprobación manual cuando
// auto_approve = false (§10.6). Tras aprobar intenta cargar a nómina en el
// mismo paso: para el admin "aprobar" y "que quede en nómina" son un solo
// acto, no dos botones.
const approve = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const reward = await CrmReward.findOne({ where: { id: req.params.id, tenant_id } });
    if (!reward) return res.status(404).json({ success: false, message: 'Recompensa no encontrada' });

    if (reward.status !== 'pendiente_aprobacion') {
      return res.status(400).json({ success: false, message: `La recompensa ya no está pendiente de aprobación (estado actual: ${reward.status})` });
    }

    await reward.update({
      status: 'aprobada',
      approved_by_user_id: req.user.id,
      approved_at: new Date(),
    });

    const rule = await CrmRewardRule.findByPk(reward.reward_rule_id);
    if (rule && rule.isMonetary()) {
      await chargeRewardToPayroll(reward, { rule });
    }

    res.json({ success: true, message: 'Recompensa aprobada', data: { id: reward.id, status: reward.status } });
  } catch (error) {
    logger.error('Error aprobando recompensa CRM:', error);
    res.status(500).json({ success: false, message: 'Error al aprobar la recompensa' });
  }
};

// POST /api/crm/rewards/:id/charge-to-payroll — reintento manual (§10.6).
const chargeToPayroll = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const reward = await CrmReward.findOne({ where: { id: req.params.id, tenant_id } });
    if (!reward) return res.status(404).json({ success: false, message: 'Recompensa no encontrada' });

    const rule = await CrmRewardRule.findByPk(reward.reward_rule_id);
    if (!rule || !rule.isMonetary()) {
      return res.status(400).json({ success: false, message: 'Las insignias y títulos no se cargan a nómina' });
    }
    if (reward.payroll_novedad_id) {
      return res.status(400).json({ success: false, message: 'Esta recompensa ya está cargada a nómina' });
    }
    if (reward.status === 'pendiente_aprobacion') {
      return res.status(400).json({ success: false, message: 'La recompensa debe aprobarse antes de cargarse a nómina' });
    }

    const status = await chargeRewardToPayroll(reward, { rule });
    await reward.reload();

    res.json({
      success: true,
      message: status === 'cargada_nomina' ? 'Recompensa cargada a nómina' : 'No se pudo cargar todavía',
      data: { id: reward.id, status: reward.status, last_error: reward.last_error },
    });
  } catch (error) {
    logger.error('Error cargando recompensa a nómina:', error);
    res.status(500).json({ success: false, message: 'Error al cargar la recompensa a nómina' });
  }
};

// POST /api/crm/rewards/:id/relink-employee — reintenta el emparejamiento
// automático después de que el admin corrigió el email/documento en uno de
// los dos lados (§10.1). No permite elegir el empleado a mano: eso volvería
// a introducir el mapeo manual que el diseño evita a propósito.
const relinkEmployee = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const reward = await CrmReward.findOne({ where: { id: req.params.id, tenant_id } });
    if (!reward) return res.status(404).json({ success: false, message: 'Recompensa no encontrada' });

    const user = await User.findByPk(reward.user_id, { attributes: ['id', 'email', 'cedula'] });
    const employee = user ? await findEmployeeForUser(tenant_id, user) : null;

    if (!employee) {
      return res.json({
        success: true,
        matched: false,
        message: 'Sigue sin encontrarse un empleado con el mismo email o documento que el vendedor',
      });
    }

    await reward.update({ employee_id: employee.id, last_error: null });
    const rule = await CrmRewardRule.findByPk(reward.reward_rule_id);
    if (rule && rule.isMonetary() && reward.status !== 'pendiente_aprobacion') {
      await chargeRewardToPayroll(reward, { rule, employee });
    }
    await reward.reload();

    res.json({ success: true, matched: true, data: { id: reward.id, status: reward.status, employee_id: reward.employee_id } });
  } catch (error) {
    logger.error('Error revinculando empleado de recompensa CRM:', error);
    res.status(500).json({ success: false, message: 'Error al revincular el empleado' });
  }
};

// GET /api/crm/rewards/unmatched-users — diagnóstico para el admin: qué
// vendedores no tienen empleado de nómina vinculado. Sirve para corregir el
// dato ANTES de que cierre el período, en vez de enterarse cuando la
// recompensa ya quedó trabada.
const unmatchedUsers = async (req, res) => {
  try {
    const data = await listUnmatchedUsers(req.user.tenant_id);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error listando vendedores sin empleado vinculado:', error);
    res.status(500).json({ success: false, message: 'Error al verificar el vínculo con nómina' });
  }
};

module.exports = { list, listBadges, approve, chargeToPayroll, relinkEmployee, unmatchedUsers, CAN_MANAGE, MONETARY_TYPES };