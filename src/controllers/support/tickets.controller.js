const { SupportTicket, SupportTicketMessage, SupportTicketAttachment, User, Tenant } = require('../../models');
const { processSupportFiles } = require('../../utils/uploadToCloudinary');
const { notifyTicketCreated, notifyNewMessage } = require('../../services/supportNotification.service');
const { calculateSlaDue, getSlaStatus, getSlaRemainingHours } = require('../../config/sla');
const { emitTicketEvent, emitToTicket } = require('../../services/ticketNotifications.socket');
const logger = require('../../config/logger');

const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// POST /api/support/tickets — crear ticket (solo admin/manager, validado en la ruta)
const createTicket = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const created_by = req.user.id;
    const { subject, category, description, priority } = req.body;

    if (!subject || !subject.trim()) {
      return res.status(400).json({ success: false, message: 'El asunto es requerido' });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, message: 'La descripción es requerida' });
    }
    if (priority && !TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, message: `Prioridad inválida. Valores permitidos: ${TICKET_PRIORITIES.join(', ')}` });
    }

    const ticketPriority = priority || 'medium';
    const { resolution_due } = calculateSlaDue(ticketPriority);

    const ticket = await SupportTicket.create({
      tenant_id,
      created_by,
      subject: subject.trim(),
      category: category || null,
      priority: ticketPriority,
      status: 'open',
      sla_due_at: resolution_due,
    });

    const message = await SupportTicketMessage.create({
      ticket_id: ticket.id,
      author_id: created_by,
      is_internal_note: false,
      message: description.trim(),
    });

    // Adjuntos
    const attachments = await processSupportFiles(req.files, ticket.id, message.id, tenant_id);
    if (attachments.length > 0) {
      await SupportTicketAttachment.bulkCreate(attachments);
    }

    // Notificar al equipo de soporte (async, no bloquea la respuesta)
    const fullTicket = await SupportTicket.findByPk(ticket.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] },
        { model: Tenant, as: 'tenant', attributes: ['id', 'company_name'] },
      ],
    });
    notifyTicketCreated(fullTicket).catch(() => {});

    res.status(201).json({ success: true, message: 'Ticket creado correctamente', data: ticket });
  } catch (error) {
    logger.error('Error creando ticket de soporte:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear el ticket',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/support/tickets — tickets del tenant
const listMyTickets = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const where = { tenant_id };
    if (status) where.status = status;

    const { count, rows } = await SupportTicket.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      include: [{ model: User, as: 'assigned_agent', attributes: ['id', 'first_name', 'last_name'] }],
    });

    res.json({
      success: true,
      data: rows,
      total: count,
      page: parseInt(page),
      pages: Math.ceil(count / limit),
    });
  } catch (error) {
    logger.error('Error listando mis tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener los tickets',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/support/tickets/:id — detalle + mensajes (excluye notas internas)
const getTicketDetail = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;

    const ticket = await SupportTicket.findOne({
      where: { id, tenant_id },
      include: [
        { model: User, as: 'assigned_agent', attributes: ['id', 'first_name', 'last_name'] },
        {
          model: SupportTicketMessage,
          as: 'messages',
          where: { is_internal_note: false },
          required: false,
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

    const ticketData = ticket.toJSON();
    ticketData.sla = {
      status: getSlaStatus(ticket.sla_due_at, ticket.resolved_at),
      remaining_hours: getSlaRemainingHours(ticket.sla_due_at),
      due_at: ticket.sla_due_at,
    };

    res.json({ success: true, data: ticketData });
  } catch (error) {
    logger.error('Error obteniendo detalle de ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener el ticket',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// POST /api/support/tickets/:id/messages — responder en el hilo
const addMessage = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;
    const { message } = req.body;

    if ((!message || !message.trim()) && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ success: false, message: 'El mensaje o un adjunto es requerido' });
    }

    const ticket = await SupportTicket.findOne({ where: { id, tenant_id } });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }
    if (['resolved', 'closed'].includes(ticket.status)) {
      return res.status(400).json({ success: false, message: 'No se puede responder un ticket resuelto o cerrado' });
    }

    const newMessage = await SupportTicketMessage.create({
      ticket_id: ticket.id,
      author_id: req.user.id,
      is_internal_note: false,
      message: message.trim(),
    });

    // Adjuntos
    const attachments = await processSupportFiles(req.files, ticket.id, newMessage.id, tenant_id);
    if (attachments.length > 0) {
      await SupportTicketAttachment.bulkCreate(attachments);
    }

    if (ticket.status === 'waiting_customer') {
      await ticket.update({ status: 'in_progress' });
    }

    // Notificar a los agentes (async, no bloquea la respuesta)
    notifyNewMessage(ticket, req.user, false).catch(() => {});

    // Notificación en vivo por Socket.io
    console.log(`[TICKET-WS] Emitting new-message for ticket ${ticket.id}, tenant ${tenant_id}`);
    emitTicketEvent(tenant_id, 'ticket:new-message', {
      ticketId: ticket.id,
      message: message?.trim() || '',
      author: { id: req.user.id },
    });
    emitToTicket(ticket.id, 'ticket:new-message', {
      ticketId: ticket.id,
      message: newMessage,
    });

    res.status(201).json({ success: true, message: 'Mensaje enviado', data: newMessage });
  } catch (error) {
    logger.error('Error agregando mensaje a ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Error al enviar el mensaje',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// PUT /api/support/tickets/:id/rate — calificar ticket resuelto/cerrado
const rateTicket = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;
    const { rating } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'La calificación debe ser entre 1 y 5' });
    }

    const ticket = await SupportTicket.findOne({ where: { id, tenant_id } });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }
    if (!['resolved', 'closed'].includes(ticket.status)) {
      return res.status(400).json({ success: false, message: 'Solo se pueden calificar tickets resueltos o cerrados' });
    }
    if (ticket.rating) {
      return res.status(400).json({ success: false, message: 'Este ticket ya fue calificado' });
    }

    await ticket.update({ rating: parseInt(rating) });
    res.json({ success: true, message: 'Calificación registrada', data: ticket });
  } catch (error) {
    logger.error('Error calificando ticket:', error);
    res.status(500).json({ success: false, message: 'Error al calificar' });
  }
};

module.exports = {
  createTicket,
  listMyTickets,
  getTicketDetail,
  addMessage,
  rateTicket,
};
