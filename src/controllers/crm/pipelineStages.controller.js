// backend/src/controllers/crm/pipelineStages.controller.js
//
// CRM Fase B.4 — administración de etapas de pipeline por tenant.
const logger = require('../../config/logger');
const { CrmPipelineStage, Opportunity } = require('../../models');

const list = async (req, res) => {
  try {
    const stages = await CrmPipelineStage.findAll({
      where: { tenant_id: req.user.tenant_id },
      order: [['sort_order', 'ASC']],
    });
    res.json({ success: true, data: stages });
  } catch (error) {
    logger.error('Error listando etapas de pipeline:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las etapas' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { key, label, color, stage_type, default_probability } = req.body;
    if (!key || !label) {
      return res.status(400).json({ success: false, message: 'key y label son requeridos' });
    }

    const maxOrder = await CrmPipelineStage.max('sort_order', { where: { tenant_id } });
    const stage = await CrmPipelineStage.create({
      tenant_id,
      key,
      label,
      color: color || null,
      stage_type: stage_type || 'open',
      default_probability: default_probability ?? null,
      sort_order: (maxOrder ?? -1) + 1,
    });

    res.status(201).json({ success: true, message: 'Etapa creada', data: stage });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una etapa con esa key' });
    }
    logger.error('Error creando etapa de pipeline:', error);
    res.status(500).json({ success: false, message: 'Error al crear la etapa' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { label, color, stage_type, default_probability } = req.body;

    const stage = await CrmPipelineStage.findOne({ where: { id: req.params.id, tenant_id } });
    if (!stage) return res.status(404).json({ success: false, message: 'Etapa no encontrada' });

    const updateData = {};
    if (label !== undefined) updateData.label = label;
    if (color !== undefined) updateData.color = color;
    if (stage_type !== undefined) updateData.stage_type = stage_type;
    if (default_probability !== undefined) updateData.default_probability = default_probability;

    await stage.update(updateData);
    res.json({ success: true, message: 'Etapa actualizada', data: stage });
  } catch (error) {
    logger.error('Error actualizando etapa de pipeline:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la etapa' });
  }
};

const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const stage = await CrmPipelineStage.findOne({ where: { id: req.params.id, tenant_id } });
    if (!stage) return res.status(404).json({ success: false, message: 'Etapa no encontrada' });

    const inUse = await Opportunity.count({ where: { tenant_id, stage: stage.key } });
    if (inUse > 0) {
      return res.status(409).json({ success: false, message: `No se puede eliminar: ${inUse} oportunidad(es) están en esta etapa` });
    }

    await stage.destroy();
    res.json({ success: true, message: 'Etapa eliminada' });
  } catch (error) {
    logger.error('Error eliminando etapa de pipeline:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar la etapa' });
  }
};

// Reordenar — recibe la lista completa de ids en el nuevo orden.
const reorder = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ success: false, message: 'ids (array) es requerido' });
    }

    await Promise.all(ids.map((id, index) =>
      CrmPipelineStage.update({ sort_order: index }, { where: { id, tenant_id } })
    ));

    const stages = await CrmPipelineStage.findAll({ where: { tenant_id }, order: [['sort_order', 'ASC']] });
    res.json({ success: true, message: 'Orden actualizado', data: stages });
  } catch (error) {
    logger.error('Error reordenando etapas de pipeline:', error);
    res.status(500).json({ success: false, message: 'Error al reordenar las etapas' });
  }
};

module.exports = { list, create, update, remove, reorder };
