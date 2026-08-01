// backend/src/controllers/crm/followups.controller.js
const logger = require('../../config/logger');
const { Op } = require('sequelize');
const { FollowUpTask, Customer, Opportunity, User } = require('../../models');
const { applyOwnershipScope } = require('../../utils/crmScope');

// Bandeja de seguimiento — por defecto trae lo del usuario actual (o de su
// equipo, si es manager/admin), ordenado por vencimiento más próximo primero.
const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status, from, to } = req.query;

    let where = { tenant_id };
    if (status) where.status = status;

    // Rango de fechas opcional (usado por la vista de calendario / "Mi día"
    // en el frontend, que trae un mes completo de una vez en vez de pedir
    // día por día). Se combina con `status` si ambos vienen — la vista de
    // lista sigue mandando solo `status`, sin tocar su comportamiento.
    if (from || to) {
      where.due_at = {};
      if (from) where.due_at[Op.gte] = new Date(`${from}T00:00:00.000Z`);
      if (to) where.due_at[Op.lte] = new Date(`${to}T23:59:59.999Z`);
    }

    where = await applyOwnershipScope(req, where, 'assigned_to_user_id');

    const tasks = await FollowUpTask.findAll({
      where,
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'mobile', 'phone'] },
        { model: Opportunity, as: 'opportunity', attributes: ['id', 'stage', 'expected_value'] },
        { model: User, as: 'assigned_to', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['due_at', 'ASC']],
    });

    res.json({ success: true, data: tasks });
  } catch (error) {
    logger.error('Error listando tareas de seguimiento:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la bandeja de seguimiento' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { customer_id, opportunity_id, assigned_to_user_id, title, due_at } = req.body;

    if (!customer_id || !title || !due_at) {
      return res.status(400).json({ success: false, message: 'customer_id, title y due_at son requeridos' });
    }

    const customer = await Customer.findOne({ where: { id: customer_id, tenant_id } });
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    // Solo manager/admin/super_admin puede asignarle una tarea a otro
    // usuario; el resto solo se la crea a sí mismo.
    const finalAssignee = (assigned_to_user_id && ['admin', 'manager', 'super_admin'].includes(req.user.role))
      ? assigned_to_user_id
      : req.user.id;

    const task = await FollowUpTask.create({
      tenant_id,
      branch_id: req.branch_id || null,
      customer_id,
      opportunity_id: opportunity_id || null,
      assigned_to_user_id: finalAssignee,
      created_by_user_id: req.user.id,
      title,
      due_at,
      status: 'pendiente',
    });

    res.status(201).json({ success: true, message: 'Tarea de seguimiento creada', data: task });
  } catch (error) {
    logger.error('Error creando tarea de seguimiento:', error);
    res.status(500).json({ success: false, message: 'Error al crear la tarea' });
  }
};

const complete = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const task = await FollowUpTask.findOne({ where: { id: req.params.id, tenant_id } });
    if (!task) return res.status(404).json({ success: false, message: 'Tarea no encontrada' });

    await task.update({ status: 'hecha', completed_at: new Date() });
    res.json({ success: true, message: 'Tarea marcada como hecha', data: task });
  } catch (error) {
    logger.error('Error completando tarea de seguimiento:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la tarea' });
  }
};

const cancel = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const task = await FollowUpTask.findOne({ where: { id: req.params.id, tenant_id } });
    if (!task) return res.status(404).json({ success: false, message: 'Tarea no encontrada' });

    await task.update({ status: 'cancelada' });
    res.json({ success: true, message: 'Tarea cancelada', data: task });
  } catch (error) {
    logger.error('Error cancelando tarea de seguimiento:', error);
    res.status(500).json({ success: false, message: 'Error al cancelar la tarea' });
  }
};

module.exports = { list, create, complete, cancel };
