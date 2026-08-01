// backend/src/controllers/crm/lossReasons.controller.js
//
// CRM Fase B.4 — administración de motivos de pérdida por tenant.
const logger = require('../../config/logger');
const { CrmLossReason, Opportunity } = require('../../models');

const list = async (req, res) => {
  try {
    const reasons = await CrmLossReason.findAll({
      where: { tenant_id: req.user.tenant_id },
      order: [['sort_order', 'ASC']],
    });
    res.json({ success: true, data: reasons });
  } catch (error) {
    logger.error('Error listando motivos de pérdida:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los motivos de pérdida' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { key, label } = req.body;
    if (!key || !label) {
      return res.status(400).json({ success: false, message: 'key y label son requeridos' });
    }

    const maxOrder = await CrmLossReason.max('sort_order', { where: { tenant_id } });
    const reason = await CrmLossReason.create({
      tenant_id,
      key,
      label,
      sort_order: (maxOrder ?? -1) + 1,
    });

    res.status(201).json({ success: true, message: 'Motivo creado', data: reason });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe un motivo con esa key' });
    }
    logger.error('Error creando motivo de pérdida:', error);
    res.status(500).json({ success: false, message: 'Error al crear el motivo' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { label } = req.body;

    const reason = await CrmLossReason.findOne({ where: { id: req.params.id, tenant_id } });
    if (!reason) return res.status(404).json({ success: false, message: 'Motivo no encontrado' });

    if (label !== undefined) await reason.update({ label });
    res.json({ success: true, message: 'Motivo actualizado', data: reason });
  } catch (error) {
    logger.error('Error actualizando motivo de pérdida:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el motivo' });
  }
};

const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const reason = await CrmLossReason.findOne({ where: { id: req.params.id, tenant_id } });
    if (!reason) return res.status(404).json({ success: false, message: 'Motivo no encontrado' });

    const inUse = await Opportunity.count({ where: { tenant_id, lost_reason: reason.key } });
    if (inUse > 0) {
      return res.status(409).json({ success: false, message: `No se puede eliminar: ${inUse} oportunidad(es) usan este motivo` });
    }

    await reason.destroy();
    res.json({ success: true, message: 'Motivo eliminado' });
  } catch (error) {
    logger.error('Error eliminando motivo de pérdida:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el motivo' });
  }
};

module.exports = { list, create, update, remove };
