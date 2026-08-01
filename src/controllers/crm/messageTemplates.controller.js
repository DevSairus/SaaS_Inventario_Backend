// backend/src/controllers/crm/messageTemplates.controller.js
//
// CRM Fase B.3 — plantillas de mensaje (WhatsApp/llamada/email) con
// variables {{cliente}}/{{asesor}}/{{monto}} resueltas en el backend.
const logger = require('../../config/logger');
const { CrmMessageTemplate, Customer, Opportunity, User } = require('../../models');
const { renderTemplate } = require('../../utils/crmMessageTemplate');

const list = async (req, res) => {
  try {
    const { channel } = req.query;
    const where = { tenant_id: req.user.tenant_id };
    if (channel) where.channel = channel;

    const templates = await CrmMessageTemplate.findAll({ where, order: [['name', 'ASC']] });
    res.json({ success: true, data: templates });
  } catch (error) {
    logger.error('Error listando plantillas de mensaje:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las plantillas' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { name, channel, body } = req.body;
    if (!name || !body) {
      return res.status(400).json({ success: false, message: 'name y body son requeridos' });
    }

    const template = await CrmMessageTemplate.create({ tenant_id, name, channel: channel || 'whatsapp', body });
    res.status(201).json({ success: true, message: 'Plantilla creada', data: template });
  } catch (error) {
    logger.error('Error creando plantilla de mensaje:', error);
    res.status(500).json({ success: false, message: 'Error al crear la plantilla' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { name, channel, body } = req.body;

    const template = await CrmMessageTemplate.findOne({ where: { id: req.params.id, tenant_id } });
    if (!template) return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (channel !== undefined) updateData.channel = channel;
    if (body !== undefined) updateData.body = body;

    await template.update(updateData);
    res.json({ success: true, message: 'Plantilla actualizada', data: template });
  } catch (error) {
    logger.error('Error actualizando plantilla de mensaje:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la plantilla' });
  }
};

const remove = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const deleted = await CrmMessageTemplate.destroy({ where: { id: req.params.id, tenant_id } });
    if (!deleted) return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });
    res.json({ success: true, message: 'Plantilla eliminada' });
  } catch (error) {
    logger.error('Error eliminando plantilla de mensaje:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar la plantilla' });
  }
};

function customerDisplayName(c) {
  if (!c) return '';
  return c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || '';
}

// Resuelve {{cliente}}/{{asesor}}/{{monto}} contra datos reales del cliente,
// la oportunidad (si viene) y el usuario actual (asesor).
const render = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { customer_id, opportunity_id } = req.body;

    const template = await CrmMessageTemplate.findOne({ where: { id: req.params.id, tenant_id } });
    if (!template) return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });

    let customer = null;
    if (customer_id) {
      customer = await Customer.findOne({ where: { id: customer_id, tenant_id } });
    }

    let monto = null;
    if (opportunity_id) {
      const opportunity = await Opportunity.findOne({ where: { id: opportunity_id, tenant_id }, attributes: ['expected_value'] });
      monto = opportunity?.expected_value ?? null;
    }

    const advisor = await User.findOne({ where: { id: req.user.id }, attributes: ['first_name', 'last_name'] });

    const text = renderTemplate(template.body, {
      cliente: customerDisplayName(customer),
      asesor: advisor ? `${advisor.first_name || ''} ${advisor.last_name || ''}`.trim() : '',
      monto,
    });

    res.json({ success: true, data: { text } });
  } catch (error) {
    logger.error('Error renderizando plantilla de mensaje:', error);
    res.status(500).json({ success: false, message: 'Error al renderizar la plantilla' });
  }
};

module.exports = { list, create, update, remove, render };
