// backend/src/controllers/crm/opportunities.controller.js
const logger = require('../../config/logger');
const { Op } = require('sequelize');
const { Opportunity, Customer, User, Sale, WorkOrder, CrmLossReason } = require('../../models');
const { applyOwnershipScope } = require('../../utils/crmScope');
const { computeLeadPriority } = require('../../utils/crmLeadScore');
const { loadStageMap, resolveEntryStageKey } = require('../../utils/crmPipelineStages');
const { applyOpportunityCreatedRules } = require('../../services/crmAutomationEngine');

// Listado para el tablero Kanban — agrupado por stage en el frontend, acá
// se entrega plano y ya filtrado por visibilidad (§5-bis, capa A).
const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { stage, owner_user_id } = req.query;

    let where = { tenant_id };
    if (stage) where.stage = stage;
    // owner_user_id como filtro manual solo lo puede pedir alguien con
    // visión de equipo; para seller/technician el scope ya lo fija abajo.
    if (owner_user_id && ['admin', 'manager', 'super_admin'].includes(req.user.role)) {
      where.owner_user_id = owner_user_id;
    }

    where = await applyOwnershipScope(req, where, 'owner_user_id');

    const stageMap = await loadStageMap(tenant_id);

    const opportunities = await Opportunity.findAll({
      where,
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'mobile', 'phone'] },
        { model: User, as: 'owner', attributes: ['id', 'first_name', 'last_name'] },
        { model: Sale, as: 'quote_sale', attributes: ['id', 'sale_number', 'total_amount'] },
        { model: WorkOrder, as: 'work_order', attributes: ['id', 'order_number', 'status'] },
      ],
      order: [['stage_changed_at', 'DESC']],
    });

    // Fase B.2 — prioridad automática: cada oportunidad abierta se etiqueta
    // con un score 0-100 (tiempo sin movimiento + origen + valor estimado).
    // El frontend agrupa por stage en columnas, así que basta con reordenar
    // el arreglo plano por score: dentro de cada columna quedará de mayor a
    // menor prioridad. Las cerradas (score null) conservan el orden por
    // stage_changed_at que ya traía la consulta.
    const withScore = opportunities.map(o => {
      const plain = o.toJSON();
      plain.priority_score = computeLeadPriority(plain, stageMap[plain.stage]);
      return plain;
    });
    withScore.sort((a, b) => {
      if (a.priority_score == null && b.priority_score == null) return 0;
      if (a.priority_score == null) return 1;
      if (b.priority_score == null) return -1;
      return b.priority_score - a.priority_score;
    });

    res.json({ success: true, data: withScore });
  } catch (error) {
    logger.error('Error listando oportunidades:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el pipeline' });
  }
};

const getById = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const opportunity = await Opportunity.findOne({
      where: { id: req.params.id, tenant_id },
      include: [
        { model: Customer, as: 'customer' },
        { model: User, as: 'owner', attributes: ['id', 'first_name', 'last_name'] },
        { model: Sale, as: 'quote_sale' },
        { model: WorkOrder, as: 'work_order' },
      ],
    });
    if (!opportunity) return res.status(404).json({ success: false, message: 'Oportunidad no encontrada' });
    res.json({ success: true, data: opportunity });
  } catch (error) {
    logger.error('Error obteniendo oportunidad:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la oportunidad' });
  }
};

const create = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const {
      customer_id, source, expected_value, probability,
      expected_close_date, owner_user_id,
    } = req.body;

    if (!customer_id) {
      return res.status(400).json({ success: false, message: 'customer_id es requerido' });
    }

    const customer = await Customer.findOne({ where: { id: customer_id, tenant_id } });
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    // Por defecto la oportunidad queda a nombre de quien la crea; solo
    // manager/admin/super_admin puede asignarla a otro vendedor de entrada.
    const finalOwnerId = (owner_user_id && ['admin', 'manager', 'super_admin'].includes(req.user.role))
      ? owner_user_id
      : req.user.id;

    const entryStage = resolveEntryStageKey(await loadStageMap(tenant_id));

    const opportunity = await Opportunity.create({
      tenant_id,
      branch_id: req.branch_id || null,
      customer_id,
      owner_user_id: finalOwnerId,
      source: source || 'walk_in',
      stage: entryStage,
      stage_changed_at: new Date(),
      expected_value: expected_value || null,
      probability: probability ?? null,
      expected_close_date: expected_close_date || null,
    });

    // Fase C.1 — reglas tipo "entra una oportunidad de tal origen → tal
    // acción" (ej. round-robin). No bloquea la respuesta ni la revierte si
    // falla: la oportunidad ya quedó creada, que es lo que le importa al
    // usuario que hizo la llamada.
    await applyOpportunityCreatedRules(tenant_id, opportunity);

    res.status(201).json({ success: true, message: 'Oportunidad creada', data: opportunity });
  } catch (error) {
    logger.error('Error creando oportunidad:', error);
    res.status(500).json({ success: false, message: 'Error al crear la oportunidad' });
  }
};

// Transición de etapa — el movimiento en el tablero Kanban pega acá.
// stage='perdido' exige lost_reason (regla de negocio del diseño).
const changeStage = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { stage, lost_reason } = req.body;

    const stageMap = await loadStageMap(tenant_id);
    const targetStage = stageMap[stage];
    if (!targetStage) {
      return res.status(400).json({ success: false, message: 'Etapa inválida' });
    }
    if (targetStage.stage_type === 'lost') {
      const validReason = lost_reason && await CrmLossReason.findOne({ where: { tenant_id, key: lost_reason } });
      if (!validReason) {
        return res.status(400).json({ success: false, message: 'lost_reason es requerido y debe ser válido cuando la etapa es de tipo "perdido"' });
      }
    }

    const opportunity = await Opportunity.findOne({ where: { id: req.params.id, tenant_id } });
    if (!opportunity) return res.status(404).json({ success: false, message: 'Oportunidad no encontrada' });

    // No se reabre una oportunidad ganada/perdida arrastrándola en el
    // tablero — evita que se pisen las métricas de cierre por accidente.
    const currentStage = stageMap[opportunity.stage];
    if (currentStage && currentStage.stage_type !== 'open' && stage !== opportunity.stage) {
      return res.status(400).json({
        success: false,
        message: `Esta oportunidad ya está cerrada (${currentStage.label}) y no puede moverse de etapa`,
      });
    }

    await opportunity.update({
      stage,
      stage_changed_at: new Date(),
      lost_reason: targetStage.stage_type === 'lost' ? lost_reason : null,
    });

    res.json({ success: true, message: 'Etapa actualizada', data: opportunity });
  } catch (error) {
    logger.error('Error cambiando etapa de oportunidad:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la etapa' });
  }
};

const update = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { expected_value, probability, expected_close_date, owner_user_id } = req.body;

    const opportunity = await Opportunity.findOne({ where: { id: req.params.id, tenant_id } });
    if (!opportunity) return res.status(404).json({ success: false, message: 'Oportunidad no encontrada' });

    const updateData = {};
    if (expected_value !== undefined) updateData.expected_value = expected_value;
    if (probability !== undefined) updateData.probability = probability;
    if (expected_close_date !== undefined) updateData.expected_close_date = expected_close_date;
    // Reasignar dueño es un movimiento de equipo, no de datos sueltos.
    if (owner_user_id !== undefined && ['admin', 'manager', 'super_admin'].includes(req.user.role)) {
      updateData.owner_user_id = owner_user_id;
    }

    await opportunity.update(updateData);
    res.json({ success: true, message: 'Oportunidad actualizada', data: opportunity });
  } catch (error) {
    logger.error('Error actualizando oportunidad:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la oportunidad' });
  }
};

module.exports = { list, getById, create, changeStage, update };