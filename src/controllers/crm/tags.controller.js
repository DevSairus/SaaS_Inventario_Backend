// backend/src/controllers/crm/tags.controller.js
const logger = require('../../config/logger');
const { CustomerTag, CustomerTagAssignment, Customer } = require('../../models');

const list = async (req, res) => {
  try {
    const tags = await CustomerTag.findAll({ where: { tenant_id: req.user.tenant_id }, order: [['name', 'ASC']] });
    res.json({ success: true, data: tags });
  } catch (error) {
    logger.error('Error listando etiquetas:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las etiquetas' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name es requerido' });

    const tag = await CustomerTag.create({ tenant_id, name, color: color || null });
    res.status(201).json({ success: true, message: 'Etiqueta creada', data: tag });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una etiqueta con ese nombre' });
    }
    logger.error('Error creando etiqueta:', error);
    res.status(500).json({ success: false, message: 'Error al crear la etiqueta' });
  }
};

const assignToCustomer = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { customer_id, customer_tag_id } = req.body;

    const [customer, tag] = await Promise.all([
      Customer.findOne({ where: { id: customer_id, tenant_id } }),
      CustomerTag.findOne({ where: { id: customer_tag_id, tenant_id } }),
    ]);
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    if (!tag) return res.status(404).json({ success: false, message: 'Etiqueta no encontrada' });

    const [assignment] = await CustomerTagAssignment.findOrCreate({
      where: { customer_id, customer_tag_id },
      defaults: { tenant_id, customer_id, customer_tag_id },
    });

    res.status(201).json({ success: true, message: 'Etiqueta asignada', data: assignment });
  } catch (error) {
    logger.error('Error asignando etiqueta:', error);
    res.status(500).json({ success: false, message: 'Error al asignar la etiqueta' });
  }
};

const removeFromCustomer = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { customer_id, customer_tag_id } = req.params;

    const deleted = await CustomerTagAssignment.destroy({ where: { tenant_id, customer_id, customer_tag_id } });
    if (!deleted) return res.status(404).json({ success: false, message: 'Esa etiqueta no estaba asignada a este cliente' });

    res.json({ success: true, message: 'Etiqueta removida' });
  } catch (error) {
    logger.error('Error removiendo etiqueta:', error);
    res.status(500).json({ success: false, message: 'Error al remover la etiqueta' });
  }
};

module.exports = { list, create, assignToCustomer, removeFromCustomer };
