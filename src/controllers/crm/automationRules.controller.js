// backend/src/controllers/crm/automationRules.controller.js
//
// CRM Fase C.1 — administración de reglas de automatización por tenant.
// Ver backend/src/models/crm/CrmAutomationRule.js para el contrato de
// trigger_type/trigger_config/action_type/action_config, y
// backend/src/services/crmAutomationEngine.js para cómo se evalúan.
const logger = require('../../config/logger');
const { CrmAutomationRule, User } = require('../../models');

const TRIGGER_TYPES = ['unattended_lead', 'stage_stale', 'opportunity_created'];
const ACTION_TYPES = ['create_task', 'assign_round_robin'];

const list = async (req, res) => {
  try {
    const rules = await CrmAutomationRule.findAll({
      where: { tenant_id: req.user.tenant_id },
      include: [{ model: User, as: 'last_round_robin_user', attributes: ['id', 'first_name', 'last_name'] }],
      order: [['created_at', 'ASC']],
    });
    res.json({ success: true, data: rules });
  } catch (error) {
    logger.error('Error listando reglas de automatización:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las reglas de automatización' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { name, trigger_type, trigger_config, action_type, action_config, is_active } = req.body;

    if (!name || !trigger_type || !action_type) {
      return res.status(400).json({ success: false, message: 'name, trigger_type y action_type son requeridos' });
    }
    if (!TRIGGER_TYPES.includes(trigger_type)) {
      return res.status(400).json({ success: false, message: 'trigger_type inválido' });
    }
    if (!ACTION_TYPES.includes(action_type)) {
      return res.status(400).json({ success: false, message: 'action_type inválido' });
    }

    const rule = await CrmAutomationRule.create({
      tenant_id,
      name,
      is_active: is_active ?? true,
      trigger_type,
      trigger_config: trigger_config || {},
      action_type,
      action_config: action_config || {},
      created_by_user_id: req.user.id,
    });

    res.status(201).json({ success: true, message: 'Regla de automatización creada', data: rule });
  } catch (error) {
    logger.error('Error creando regla de automatización:', error);
    res.status(500).json({ success: false, message: 'Error al crear la regla de automatización' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const rule = await CrmAutomationRule.findOne({ where: { id: req.params.id, tenant_id } });
    if (!rule) return res.status(404).json({ success: false, message: 'Regla no encontrada' });

    const { name, trigger_type, trigger_config, action_type, action_config, is_active } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (trigger_type !== undefined) {
      if (!TRIGGER_TYPES.includes(trigger_type)) {
        return res.status(400).json({ success: false, message: 'trigger_type inválido' });
      }
      updateData.trigger_type = trigger_type;
    }
    if (trigger_config !== undefined) updateData.trigger_config = trigger_config;
    if (action_type !== undefined) {
      if (!ACTION_TYPES.includes(action_type)) {
        return res.status(400).json({ success: false, message: 'action_type inválido' });
      }
      updateData.action_type = action_type;
    }
    if (action_config !== undefined) updateData.action_config = action_config;

    await rule.update(updateData);
    res.json({ success: true, message: 'Regla actualizada', data: rule });
  } catch (error) {
    logger.error('Error actualizando regla de automatización:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la regla' });
  }
};

const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const rule = await CrmAutomationRule.findOne({ where: { id: req.params.id, tenant_id } });
    if (!rule) return res.status(404).json({ success: false, message: 'Regla no encontrada' });

    await rule.destroy();
    res.json({ success: true, message: 'Regla eliminada' });
  } catch (error) {
    logger.error('Error eliminando regla de automatización:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar la regla' });
  }
};

module.exports = { list, create, update, remove };
