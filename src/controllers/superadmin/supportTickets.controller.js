const { Op } = require('sequelize');
const {
  SupportTicket,
  SupportTicketMessage,
  SupportTicketAttachment,
  User,
  Tenant,
} = require('../../models');
const { processSupportFiles } = require('../../utils/uploadToCloudinary');
const { notifyNewMessage, notifyStatusChanged } = require('../../services/supportNotification.service');
const { emitTicketEvent, emitToTicket } = require('../../services/ticketNotifications.socket');
const logger = require('../../config/logger');

const TICKET_STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// GET /api/superadmin/support/tickets — bandeja con filtros
const listTickets = async (req, res) => {
  try {
    const {
      status, priority, category, tenant_id, assigned_agent_id,
      start_date, end_date, search, page = 1, limit = 20,
    } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (category) where.category = category;
    if (tenant_id) where.tenant_id = tenant_id;
    if (assigned_agent_id) where.assigned_agent_id = assigned_agent_id;
    if (start_date && end_date) {
      where.created_at = { [Op.between]: [new Date(start_date), new Date(end_date)] };
    }
    if (search) {
      where[Op.or] = [
        { subject: { [Op.iLike]: `%${search}%` } },
        { '$tenant.company_name$': { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await SupportTicket.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      subQuery: false,
      include: [
        { model: Tenant, as: 'tenant', attributes: ['id', 'company_name'] },
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
        { model: User, as: 'assigned_agent', attributes: ['id', 'first_name', 'last_name'] },
      ],
    });

    res.json({
      success: true,
      data: rows,
      total: count,
      page: parseInt(page),
      pages: Math.ceil(count / limit),
    });
  } catch (error) {
    logger.error('Error listando bandeja de tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener los tickets',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/superadmin/support/tickets/:id — detalle + mensajes (incluye notas internas)
const getTicketDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await SupportTicket.findByPk(id, {
      include: [
        { model: Tenant, as: 'tenant', attributes: ['id', 'company_name'] },
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
        { model: User, as: 'assigned_agent', attributes: ['id', 'first_name', 'last_name'] },
        {
          model: SupportTicketMessage,
          as: 'messages',
          separate: true,
          order: [['created_at', 'ASC']],
          include: [
            { model: User, as: 'author', attributes: ['id', 'first_name', 'last_name', 'role'] },
            { model: SupportTicketAttachment, as: 'attachments' },
          ],
        },
      ],
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }

    res.json({ success: true, data: ticket });
  } catch (error) {
    logger.error('Error obteniendo detalle de ticket (superadmin):', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener el ticket',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// PUT /api/superadmin/support/tickets/:id — cambiar estado/prioridad/asignación
const updateTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority, assigned_agent_id } = req.body;

    const ticket = await SupportTicket.findByPk(id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }

    if (status && !TICKET_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `Estado inválido. Valores permitidos: ${TICKET_STATUSES.join(', ')}` });
    }
    if (priority && !TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, message: `Prioridad inválida. Valores permitidos: ${TICKET_PRIORITIES.join(', ')}` });
    }

    const updates = {};
    const oldStatus = ticket.status;
    if (status) {
      updates.status = status;
      if (status === 'resolved' && !ticket.resolved_at) updates.resolved_at = new Date();
      if (status === 'closed' && !ticket.closed_at) updates.closed_at = new Date();
    }
    if (priority) updates.priority = priority;
    if (assigned_agent_id !== undefined) updates.assigned_agent_id = assigned_agent_id || null;

    await ticket.update(updates);

    // Notificar cambio de estado al cliente (async)
    if (status && status !== oldStatus) {
      const fullTicket = await SupportTicket.findByPk(id, {
        include: [{ model: User, as: 'creator', attributes: ['id', 'first_name', 'email'] }],
      });
      notifyStatusChanged(fullTicket, oldStatus, status).catch(() => {});

      // Notificación en vivo por Socket.io
      emitTicketEvent(ticket.tenant_id, 'ticket:status-changed', {
        ticketId: id,
        oldStatus,
        newStatus: status,
      });
    }

    res.json({ success: true, message: 'Ticket actualizado', data: ticket });
  } catch (error) {
    logger.error('Error actualizando ticket (superadmin):', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el ticket',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// POST /api/superadmin/support/tickets/:id/messages — responder o dejar nota interna
const addMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { message, is_internal_note } = req.body;

    if ((!message || !message.trim()) && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ success: false, message: 'El mensaje o un adjunto es requerido' });
    }

    const ticket = await SupportTicket.findByPk(id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }

    const newMessage = await SupportTicketMessage.create({
      ticket_id: ticket.id,
      author_id: req.user.id,
      is_internal_note: Boolean(is_internal_note),
      message: message.trim(),
    });

    // Adjuntos
    const attachments = await processSupportFiles(req.files, ticket.id, newMessage.id, ticket.tenant_id);
    if (attachments.length > 0) {
      await SupportTicketAttachment.bulkCreate(attachments);
    }

    const ticketUpdates = {};
    if (!ticket.first_response_at && !is_internal_note) {
      ticketUpdates.first_response_at = new Date();
    }
    if (!is_internal_note && ticket.status === 'open') {
      ticketUpdates.status = 'waiting_customer';
    }
    if (Object.keys(ticketUpdates).length > 0) {
      await ticket.update(ticketUpdates);
    }

    // Notificar al cliente (async, no bloquea la respuesta)
    notifyNewMessage(ticket, req.user, Boolean(is_internal_note)).catch(() => {});

    // Notificación en vivo por Socket.io
    console.log(`[TICKET-WS] Emitting new-message (superadmin) for ticket ${ticket.id}, tenant ${ticket.tenant_id}`);
    emitTicketEvent(ticket.tenant_id, 'ticket:new-message', {
      ticketId: ticket.id,
      message: message?.trim() || '',
      author: { id: req.user.id },
      is_internal_note: Boolean(is_internal_note),
    });
    emitToTicket(ticket.id, 'ticket:new-message', {
      ticketId: ticket.id,
      message: newMessage,
    });

    res.status(201).json({ success: true, message: 'Mensaje enviado', data: newMessage });
  } catch (error) {
    logger.error('Error agregando mensaje a ticket (superadmin):', error);
    res.status(500).json({
      success: false,
      message: 'Error al enviar el mensaje',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = {
  listTickets,
  getTicketDetail,
  updateTicket,
  addMessage,
};
