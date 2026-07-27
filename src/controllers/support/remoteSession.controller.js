const { RemoteSupportSession, SupportTicket, User, Tenant } = require('../../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

// POST /api/superadmin/support/tickets/:id/remote-session — solicitar sesión
const createSession = async (req, res) => {
  try {
    const { id: ticket_id } = req.params;
    const { target_user_id, mode } = req.body;
    const agent_id = req.user.id;

    // Limpiar sesiones pendientes antiguas (>2 min sin respuesta) y sesiones
    // activas abandonadas (ej. el navegador se cerró sin disparar 'disconnect')
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await RemoteSupportSession.update(
      { status: 'expired', ended_at: new Date() },
      { where: { status: 'pending', created_at: { [Op.lt]: twoMinutesAgo } } },
    );
    await RemoteSupportSession.update(
      { status: 'ended', ended_at: new Date() },
      { where: { status: 'active', started_at: { [Op.lt]: oneHourAgo } } },
    );

    const ticket = await SupportTicket.findByPk(ticket_id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
        { model: Tenant, as: 'tenant', attributes: ['id', 'company_name'] },
      ],
    });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }

    // Cerrar cualquier sesión activa o pendiente anterior para este ticket
    await RemoteSupportSession.update(
      { status: 'ended', ended_at: new Date() },
      { where: { ticket_id, status: ['pending', 'active'] } },
    );

    // Si se proporciona target_user_id, validar que pertenezca al tenant
    let targetUserId = ticket.created_by;
    if (target_user_id) {
      const targetUser = await User.findOne({
        where: { id: target_user_id, tenant_id: ticket.tenant_id, is_active: true },
      });
      if (!targetUser) {
        return res.status(400).json({ success: false, message: 'Usuario destino no válido o no pertenece al tenant' });
      }
      targetUserId = target_user_id;
    }

    const session = await RemoteSupportSession.create({
      ticket_id,
      agent_id,
      tenant_id: ticket.tenant_id,
      user_id: targetUserId,
      mode: mode === 'remote_control' ? 'remote_control' : 'view_only',
      status: 'pending',
    });

    logger.info(`[REMOTE] Sesión ${session.id} creada por agente ${agent_id} para ticket ${ticket_id}, usuario destino: ${targetUserId}`);

    res.status(201).json({
      success: true,
      message: 'Sesión de acceso remoto creada. Esperando consentimiento del cliente.',
      data: session,
    });
  } catch (error) {
    logger.error('Error creando sesión remota:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear la sesión' });
  }
};

// DELETE /api/superadmin/support/remote-sessions/:id — cancelar sesión pendiente
const cancelSession = async (req, res) => {
  try {
    const { id } = req.params;
    const session = await RemoteSupportSession.findByPk(id);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Sesión no encontrada' });
    }
    if (session.agent_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Solo el agente que creó la sesión puede cancelarla' });
    }
    if (!['pending', 'active'].includes(session.status)) {
      return res.status(400).json({ success: false, message: 'La sesión ya fue finalizada' });
    }

    await session.update({ status: 'ended', ended_at: new Date() });
    logger.info(`[REMOTE] Sesión ${id} cancelada por agente ${req.user.id}`);

    res.json({ success: true, message: 'Sesión cancelada' });
  } catch (error) {
    logger.error('Error cancelando sesión:', error.message);
    res.status(500).json({ success: false, message: 'Error al cancelar sesión' });
  }
};

// GET /api/superadmin/support/tenants/:tenant_id/users — listar usuarios activos del tenant
const getTenantUsers = async (req, res) => {
  try {
    const { tenant_id } = req.params;
    const users = await User.findAll({
      where: { tenant_id, is_active: true },
      attributes: ['id', 'first_name', 'last_name', 'email', 'role'],
      order: [['first_name', 'ASC']],
    });
    res.json({ success: true, data: users });
  } catch (error) {
    logger.error('Error listando usuarios del tenant:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener usuarios' });
  }
};

// GET /api/support/remote-sessions/pending — cliente ve sesiones pendientes
const getPendingSessions = async (req, res) => {
  try {
    const sessions = await RemoteSupportSession.findAll({
      where: { user_id: req.user.id, status: 'pending' },
      include: [
        { model: User, as: 'agent', attributes: ['id', 'first_name', 'last_name'] },
        { model: SupportTicket, as: 'ticket', attributes: ['id', 'subject'] },
      ],
      order: [['created_at', 'DESC']],
    });

    res.json({ success: true, data: sessions });
  } catch (error) {
    logger.error('Error obteniendo sesiones pendientes:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener sesiones' });
  }
};

// PUT /api/support/remote-sessions/:id/respond — cliente acepta/rechaza
const respondToSession = async (req, res) => {
  try {
    const { id } = req.params;
    const { consent } = req.body; // true = aceptar, false = rechazar

    const session = await RemoteSupportSession.findByPk(id);
    if (!session || session.user_id !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Sesión no encontrada' });
    }
    if (session.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'La sesión ya fue procesada' });
    }

    if (consent) {
      await session.update({
        consent_given_at: new Date(),
        consent_scope: session.mode,
        status: 'active',
        started_at: new Date(),
      });
    } else {
      await session.update({ status: 'rejected' });
    }

    res.json({ success: true, data: session });
  } catch (error) {
    logger.error('Error respondiendo a sesión remota:', error.message);
    res.status(500).json({ success: false, message: 'Error al procesar respuesta' });
  }
};

// PUT /api/support/remote-sessions/:id/end — terminar sesión
const endSession = async (req, res) => {
  try {
    const { id } = req.params;
    const session = await RemoteSupportSession.findByPk(id);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Sesión no encontrada' });
    }

    // Solo el agente o el cliente pueden terminar
    if (session.agent_id !== req.user.id && session.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'No autorizado' });
    }

    await session.update({ status: 'ended', ended_at: new Date() });

    res.json({ success: true, message: 'Sesión terminada', data: session });
  } catch (error) {
    logger.error('Error terminando sesión remota:', error.message);
    res.status(500).json({ success: false, message: 'Error al terminar sesión' });
  }
};

// GET /api/superadmin/support/remote-sessions — historial de sesiones
const listSessions = async (req, res) => {
  try {
    const { ticket_id, status, agent_id, tenant_id, start_date, end_date, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const where = {};

    if (ticket_id) where.ticket_id = ticket_id;
    if (status) where.status = status;
    if (agent_id) where.agent_id = agent_id;
    if (tenant_id) where.tenant_id = tenant_id;
    if (start_date && end_date) {
      where.created_at = { [Op.between]: [new Date(start_date), new Date(end_date)] };
    }

    const { count, rows } = await RemoteSupportSession.findAndCountAll({
      where,
      include: [
        { model: User, as: 'agent', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'user', attributes: ['id', 'first_name', 'last_name', 'email'] },
        { model: SupportTicket, as: 'ticket', attributes: ['id', 'subject'] },
        { model: Tenant, as: 'tenant', attributes: ['id', 'company_name'] },
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      success: true,
      data: rows,
      total: count,
      page: parseInt(page),
      pages: Math.ceil(count / limit),
    });
  } catch (error) {
    logger.error('Error listando sesiones remotas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener sesiones' });
  }
};

module.exports = {
  createSession,
  cancelSession,
  getTenantUsers,
  getPendingSessions,
  respondToSession,
  endSession,
  listSessions,
};
