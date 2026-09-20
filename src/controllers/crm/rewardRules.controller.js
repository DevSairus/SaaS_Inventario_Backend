// backend/src/controllers/crm/rewardRules.controller.js
//
// CRM — Gamificación, Fase 5. Ver gamificacion-crm-diseno.md §10.2/§10.6.
// CRUD de las reglas de recompensa. Mismo nivel de acceso que las
// automatizaciones y las metas: es una decisión de negocio (plata), no una
// consulta.
const logger = require('../../config/logger');
const { Op } = require('sequelize');
const { CrmRewardRule, CrmGoal, CrmReward, PayrollConcept } = require('../../models');
const { parseTierCondition } = require('../../services/crmRewardService');

const MONETARY_TYPES = ['monto_fijo', 'porcentaje_sobre_revenue_won'];
const CONDITION_TYPES = ['meta_cumplida', 'racha', 'superacion'];
const REWARD_TYPES = [...MONETARY_TYPES, 'insignia', 'titulo'];
const DISTRIBUTION_MODES = ['individual', 'equitativo', 'proporcional', 'monto_fijo_por_persona'];

// Valida los tiers antes de guardar. Un tier con una condición que el motor
// no sabe leer se ignoraría en silencio al evaluar y el admin nunca sabría
// por qué nadie ganó nada — mejor rechazarlo acá.
function validateTiers(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) {
    return 'Debe definir al menos un nivel (tier) de recompensa';
  }
  for (const tier of tiers) {
    if (!tier || !tier.condition) return 'Cada nivel necesita una condición';
    if (!parseTierCondition(tier.condition)) {
      return `Condición de nivel no reconocida: "${tier.condition}". Use cumplida_1_periodo, racha_N_periodos, racha_N_o_mas o superacion_N`;
    }
    if (tier.reward_value == null || isNaN(parseFloat(tier.reward_value))) {
      return `El nivel "${tier.condition}" necesita un valor numérico`;
    }
  }
  return null;
}

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const rules = await CrmRewardRule.findAll({
      where: { tenant_id },
      order: [['active', 'DESC'], ['created_at', 'DESC']],
    });

    const goalIds = [...new Set(rules.map(r => r.goal_id))];
    const goals = goalIds.length
      ? await CrmGoal.findAll({ where: { id: { [Op.in]: goalIds } }, attributes: ['id', 'name', 'scope', 'metric', 'period_type', 'active'] })
      : [];
    const goalById = Object.fromEntries(goals.map(g => [g.id, g]));

    // El admin necesita elegir un concepto de nómina al crear una regla
    // monetaria; se manda el catálogo junto con las reglas para no obligar
    // al frontend a una segunda llamada al módulo de nómina.
    let concepts = [];
    try {
      concepts = await PayrollConcept.findAll({
        where: { tenant_id, is_active: true, concept_type: 'devengado' },
        attributes: ['id', 'code', 'name', 'dian_category'],
        order: [['name', 'ASC']],
      });
    } catch {
      concepts = []; // tenant sin módulo de nómina: la regla igual se puede crear
    }

    res.json({
      success: true,
      data: rules.map(r => ({
        ...r.toJSON(),
        goal: goalById[r.goal_id] || null,
      })),
      payroll_concepts: concepts,
      catalogs: {
        condition_types: CONDITION_TYPES,
        reward_types: REWARD_TYPES,
        distribution_modes: DISTRIBUTION_MODES,
      },
    });
  } catch (error) {
    logger.error('Error listando reglas de recompensa CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las reglas de recompensa' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const {
      goal_id, name, condition_type, condition_config, tiers, reward_type,
      badge_config, auto_approve, bonus_salary_type, distribution_mode,
      payroll_concept_id,
    } = req.body;

    if (!goal_id || !name || !reward_type) {
      return res.status(400).json({ success: false, message: 'goal_id, name y reward_type son requeridos' });
    }
    if (!REWARD_TYPES.includes(reward_type)) {
      return res.status(400).json({ success: false, message: `reward_type inválido: ${reward_type}` });
    }
    if (condition_type && !CONDITION_TYPES.includes(condition_type)) {
      return res.status(400).json({ success: false, message: `condition_type inválido: ${condition_type}` });
    }

    const goal = await CrmGoal.findOne({ where: { id: goal_id, tenant_id } });
    if (!goal) return res.status(404).json({ success: false, message: 'La meta indicada no existe' });

    const isMonetary = MONETARY_TYPES.includes(reward_type);
    const tierError = validateTiers(tiers);
    if (tierError) return res.status(400).json({ success: false, message: tierError });

    if (!isMonetary && !(badge_config && badge_config.label)) {
      return res.status(400).json({ success: false, message: 'Una insignia o título necesita al menos un badge_config.label' });
    }

    const rule = await CrmRewardRule.create({
      tenant_id,
      goal_id,
      name,
      condition_type: condition_type || 'meta_cumplida',
      condition_config: condition_config || {},
      tiers,
      reward_type,
      badge_config: isMonetary ? null : badge_config,
      // auto_approve no aplica a insignias/títulos: no hay nada que aprobar
      // (§10.2), así que se fuerza para que la pantalla no muestre un botón
      // de aprobación que nunca va a hacer nada.
      auto_approve: isMonetary ? !!auto_approve : true,
      bonus_salary_type: isMonetary ? (bonus_salary_type || 'no_salarial') : 'no_salarial',
      distribution_mode: goal.scope === 'individual' ? 'individual' : (distribution_mode || 'equitativo'),
      payroll_concept_id: isMonetary ? (payroll_concept_id || null) : null,
      created_by_user_id: req.user.id,
    });

    res.status(201).json({ success: true, message: 'Regla de recompensa creada', data: rule });
  } catch (error) {
    logger.error('Error creando regla de recompensa CRM:', error);
    res.status(500).json({ success: false, message: 'Error al crear la regla de recompensa' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const rule = await CrmRewardRule.findOne({ where: { id: req.params.id, tenant_id } });
    if (!rule) return res.status(404).json({ success: false, message: 'Regla no encontrada' });

    const body = req.body;
    if (body.reward_type !== undefined && !REWARD_TYPES.includes(body.reward_type)) {
      return res.status(400).json({ success: false, message: `reward_type inválido: ${body.reward_type}` });
    }
    if (body.condition_type !== undefined && !CONDITION_TYPES.includes(body.condition_type)) {
      return res.status(400).json({ success: false, message: `condition_type inválido: ${body.condition_type}` });
    }
    if (body.tiers !== undefined) {
      const tierError = validateTiers(body.tiers);
      if (tierError) return res.status(400).json({ success: false, message: tierError });
    }

    const updateData = {};
    for (const field of [
      'name', 'condition_type', 'condition_config', 'tiers', 'reward_type',
      'badge_config', 'auto_approve', 'bonus_salary_type', 'distribution_mode',
      'payroll_concept_id', 'active',
    ]) {
      if (body[field] !== undefined) updateData[field] = body[field];
    }

    await rule.update(updateData);
    res.json({ success: true, message: 'Regla actualizada', data: rule });
  } catch (error) {
    logger.error('Error actualizando regla de recompensa CRM:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la regla' });
  }
};

// Desactivar, no borrar: las recompensas ya otorgadas apuntan a esta regla
// y el histórico de la pantalla de consulta tiene que seguir leyéndose.
const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const rule = await CrmRewardRule.findOne({ where: { id: req.params.id, tenant_id } });
    if (!rule) return res.status(404).json({ success: false, message: 'Regla no encontrada' });

    await rule.update({ active: false });
    const granted = await CrmReward.count({ where: { reward_rule_id: rule.id } });

    res.json({
      success: true,
      message: granted
        ? `Regla desactivada. Se conservan ${granted} recompensas ya otorgadas bajo esta regla.`
        : 'Regla desactivada',
    });
  } catch (error) {
    logger.error('Error desactivando regla de recompensa CRM:', error);
    res.status(500).json({ success: false, message: 'Error al desactivar la regla' });
  }
};

module.exports = { list, create, update, remove };