// backend/src/controllers/crm/customers360.controller.js
//
// CRM Fase 1: bitácora de interacciones + vista 360° del cliente + asignación
// de cuenta (base del modelo mixto de aislamiento, §5-bis del diseño).
const logger = require('../../config/logger');
const {
  Customer, CustomerInteraction, User, Sale, SaleItem, WorkOrder, Vehicle,
} = require('../../models');
const { getEffectiveModulesForTenantId } = require('../../services/moduleAccess');
const { applyOwnershipScope } = require('../../utils/crmScope');

// ── Interacciones ────────────────────────────────────────────────────────────

const listInteractions = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id: customer_id } = req.params;

    const customer = await Customer.findOne({ where: { id: customer_id, tenant_id } });
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    const interactions = await CustomerInteraction.findAll({
      where: await applyOwnershipScope(req, { tenant_id, customer_id }, 'user_id'),
      include: [
        { model: User, as: 'user', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['created_at', 'DESC']],
    });

    res.json({ success: true, data: interactions });
  } catch (error) {
    logger.error('Error listando interacciones CRM:', error);
    res.status(500).json({ success: false, message: 'Error al obtener interacciones' });
  }
};

const createInteraction = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id: customer_id } = req.params;
    const {
      type, summary, outcome, follow_up_at,
      channel_ref, related_sale_id, related_work_order_id,
    } = req.body;

    if (!type || !summary) {
      return res.status(400).json({ success: false, message: 'Tipo y resumen son requeridos' });
    }

    const customer = await Customer.findOne({ where: { id: customer_id, tenant_id } });
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    const interaction = await CustomerInteraction.create({
      tenant_id,
      branch_id: req.branch_id || null,
      customer_id,
      user_id: req.user.id,
      type, summary, outcome, follow_up_at,
      channel_ref: channel_ref || null,
      related_sale_id: related_sale_id || null,
      related_work_order_id: related_work_order_id || null,
    });

    // Desnormalizado para poder ordenar/filtrar listados de clientes sin JOIN.
    await customer.update({ last_interaction_at: interaction.created_at });

    res.status(201).json({ success: true, message: 'Interacción registrada', data: interaction });
  } catch (error) {
    logger.error('Error creando interacción CRM:', error);
    res.status(500).json({ success: false, message: 'Error al registrar la interacción' });
  }
};

// ── Vista 360° ───────────────────────────────────────────────────────────────
//
// Timeline unificado: ventas/cotizaciones, interacciones y, si el tenant
// tiene el módulo Taller activo, sus órdenes de trabajo. No duplica datos —
// solo los consulta en paralelo y los intercala por fecha.
const getTimeline = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id: customer_id } = req.params;

    const customer = await Customer.findOne({
      where: { id: customer_id, tenant_id },
      include: [{ model: User, as: 'owner', attributes: ['id', 'first_name', 'last_name'] }],
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    const modules = await getEffectiveModulesForTenantId(tenant_id);
    const hasWorkshop = modules.includes('workshop');

    const [sales, interactions, workOrders] = await Promise.all([
      Sale.findAll({
        where: { tenant_id, customer_id },
        attributes: ['id', 'sale_number', 'document_type', 'status', 'total_amount', 'sale_date', 'converted_to_work_order_id'],
        order: [['sale_date', 'DESC']],
        limit: 50,
      }),
      CustomerInteraction.findAll({
        where: { tenant_id, customer_id },
        include: [{ model: User, as: 'user', attributes: ['id', 'first_name', 'last_name'] }],
        order: [['created_at', 'DESC']],
        limit: 50,
      }),
      hasWorkshop
        ? WorkOrder.findAll({
            where: { tenant_id, customer_id },
            attributes: ['id', 'order_number', 'status', 'total_amount', 'received_at', 'quote_sale_id'],
            include: [{ model: Vehicle, as: 'vehicle', attributes: ['id', 'plate', 'brand', 'model'] }],
            order: [['received_at', 'DESC']],
            limit: 50,
          })
        : Promise.resolve([]),
    ]);

    const ltv = sales
      .filter(s => ['completed'].includes(s.status) && s.document_type !== 'cotizacion')
      .reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0);

    // Intercala todo en un solo timeline ordenado por fecha desc.
    const timeline = [
      ...sales.map(s => ({ kind: 'sale', date: s.sale_date, data: s })),
      ...interactions.map(i => ({ kind: 'interaction', date: i.created_at, data: i })),
      ...workOrders.map(w => ({ kind: 'work_order', date: w.received_at, data: w })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      data: {
        customer,
        lifetime_value: ltv,
        timeline,
      },
    });
  } catch (error) {
    logger.error('Error obteniendo vista 360° del cliente:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la información del cliente' });
  }
};

// ── Asignación de cuenta (§5-bis) ────────────────────────────────────────────
//
// Solo manager/admin/super_admin (checkRole en las rutas) puede marcar o
// liberar una cuenta asignada. Cada cambio queda registrado como una
// interacción automática para no perder contexto al reasignar.
const assignAccount = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id: customer_id } = req.params;
    const { owner_user_id, is_assigned_account } = req.body;

    const customer = await Customer.findOne({ where: { id: customer_id, tenant_id } });
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    if (is_assigned_account && !owner_user_id) {
      return res.status(400).json({
        success: false,
        message: 'owner_user_id es requerido para marcar la cuenta como asignada',
      });
    }

    const previousOwnerId = customer.owner_user_id;
    await customer.update({
      owner_user_id: owner_user_id || null,
      is_assigned_account: !!is_assigned_account,
    });

    const summary = is_assigned_account
      ? `Cuenta asignada a un nuevo asesor${previousOwnerId ? ' (antes tenía otro asignado)' : ''}`
      : 'Cuenta liberada — vuelve a ser de atención libre';

    await CustomerInteraction.create({
      tenant_id,
      branch_id: req.branch_id || null,
      customer_id,
      user_id: req.user.id,
      type: 'nota',
      summary,
      outcome: 'neutral',
    });

    res.json({ success: true, message: 'Cuenta actualizada', data: customer });
  } catch (error) {
    logger.error('Error asignando cuenta CRM:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la asignación de cuenta' });
  }
};

module.exports = {
  listInteractions,
  createInteraction,
  getTimeline,
  assignAccount,
};
