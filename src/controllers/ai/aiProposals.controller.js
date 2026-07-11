// backend/src/controllers/ai/aiProposals.controller.js
const { AiProposal, User } = require('../../models');
const { PROPOSAL_EXECUTORS } = require('../../services/ai/proposalExecutor');
const { ALLOWED_ROLES } = require('./aiAssistant.controller');
const logger = require('../../config/logger');

function hasAccess(req) {
  return ALLOWED_ROLES.includes(req.user.role) || req.user.role === 'super_admin';
}

// GET /api/ai-assistant/proposals?status=pending
exports.listProposals = async (req, res) => {
  try {
    if (!hasAccess(req)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Tu rol no tiene acceso a NEXA' });
    }

    const { status = 'pending' } = req.query;
    const where = { tenant_id: req.tenant_id };
    if (status !== 'all') where.status = status;

    const proposals = await AiProposal.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: 100,
      include: [
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'reviewer', attributes: ['id', 'first_name', 'last_name'] },
      ],
    });

    res.json({ success: true, data: proposals });
  } catch (error) {
    logger.error(`[aiProposals.listProposals] ${error.message}`);
    res.status(500).json({ success: false, message: 'Error al listar propuestas de NEXA' });
  }
};

// GET /api/ai-assistant/proposals/:id
exports.getProposal = async (req, res) => {
  try {
    if (!hasAccess(req)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Tu rol no tiene acceso a NEXA' });
    }

    const proposal = await AiProposal.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Propuesta no encontrada' });
    }

    res.json({ success: true, data: proposal });
  } catch (error) {
    logger.error(`[aiProposals.getProposal] ${error.message}`);
    res.status(500).json({ success: false, message: 'Error al obtener la propuesta' });
  }
};

// POST /api/ai-assistant/proposals/:id/approve
exports.approveProposal = async (req, res) => {
  try {
    if (!hasAccess(req)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Tu rol no tiene acceso a NEXA' });
    }

    const proposal = await AiProposal.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Propuesta no encontrada' });
    }

    // Compare-and-swap atómico a nivel de fila: solo UNA request puede ganar
    // la carrera de pending -> approved. Antes se leía `proposal.status` y
    // se validaba en memoria antes de actualizar — con un doble clic, o dos
    // personas con el mismo rol aprobando casi al mismo tiempo, ambas
    // requests podían pasar ese chequeo antes de que cualquiera alcanzara a
    // escribir, y el executor corría dos veces (ej. gasto duplicado, dos
    // asientos regenerados). El UPDATE con WHERE status='pending' es
    // atómico por sí mismo a nivel de fila en Postgres — no hace falta
    // transacción explícita ni SELECT FOR UPDATE para esto.
    const [affectedRows] = await AiProposal.update(
      { status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date() },
      { where: { id: proposal.id, tenant_id: req.tenant_id, status: 'pending' } }
    );

    if (affectedRows === 0) {
      // Otra request ya ganó la carrera (o ya estaba aprobada/rechazada de antes).
      await proposal.reload();
      return res.status(400).json({ success: false, message: `Esta propuesta ya fue ${proposal.status}` });
    }

    // Reflejar en la instancia en memoria lo que el UPDATE ya confirmó en BD,
    // para no tener que volver a leerla antes de ejecutar.
    proposal.status = 'approved';
    proposal.reviewed_by = req.user.id;
    proposal.reviewed_at = new Date();

    const executor = PROPOSAL_EXECUTORS[proposal.action_type];
    if (!executor) {
      // No debería pasar (action_type ya se valida al crear la propuesta),
      // pero si pasa, no la dejamos colgada en 'approved' sin ejecutar.
      await proposal.update({
        status: 'failed',
        error_message: `Tipo de propuesta desconocido: ${proposal.action_type}`,
      });
      return res.status(400).json({ success: false, message: `Tipo de propuesta desconocido: ${proposal.action_type}` });
    }

    // El humano que aprueba es quien queda como autor real de la escritura
    // (created_by en el controller real), respetando la sede propuesta.
    const executionReq = {
      user: req.user,
      tenant_id: req.tenant_id,
      tenant: req.tenant,
      branch_id: proposal.branch_id || req.branch_id,
      is_super_admin: req.is_super_admin,
    };

    try {
      const result = await executor(proposal, executionReq);
      await proposal.update({
        status: 'executed',
        executed_at: new Date(),
        result,
      });
      res.json({ success: true, message: 'Propuesta aprobada y ejecutada', data: proposal });
    } catch (execError) {
      await proposal.update({
        status: 'failed',
        error_message: execError.message || 'Error ejecutando la propuesta',
      });
      logger.warn(`[aiProposals.approveProposal] Ejecución falló para ${proposal.id}: ${execError.message}`);
      res.status(422).json({
        success: false,
        message: 'La propuesta se aprobó pero falló al ejecutarse',
        data: proposal,
      });
    }
  } catch (error) {
    logger.error(`[aiProposals.approveProposal] ${error.message}`);
    res.status(500).json({ success: false, message: 'Error al aprobar la propuesta' });
  }
};

// POST /api/ai-assistant/proposals/:id/reject
exports.rejectProposal = async (req, res) => {
  try {
    if (!hasAccess(req)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Tu rol no tiene acceso a NEXA' });
    }

    const proposal = await AiProposal.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Propuesta no encontrada' });
    }

    const { reason } = req.body;

    // Mismo compare-and-swap que approveProposal: evita rechazar una
    // propuesta que otra request ya aprobó (o ejecutó) entre la lectura y
    // la escritura.
    const [affectedRows] = await AiProposal.update(
      { status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date(), result: reason ? { reason } : null },
      { where: { id: proposal.id, tenant_id: req.tenant_id, status: 'pending' } }
    );

    if (affectedRows === 0) {
      await proposal.reload();
      return res.status(400).json({ success: false, message: `Esta propuesta ya fue ${proposal.status}` });
    }

    await proposal.reload();
    res.json({ success: true, message: 'Propuesta rechazada', data: proposal });
  } catch (error) {
    logger.error(`[aiProposals.rejectProposal] ${error.message}`);
    res.status(500).json({ success: false, message: 'Error al rechazar la propuesta' });
  }
};