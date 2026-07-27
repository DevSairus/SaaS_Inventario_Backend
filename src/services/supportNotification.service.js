const { sendEmail, emailTemplates } = require('./emailService');
const { User, Tenant, SupportTicket } = require('../models');
const logger = require('../config/logger');

const STATUS_LABELS = {
  open: 'Abierto',
  in_progress: 'En progreso',
  waiting_customer: 'Esperando cliente',
  resolved: 'Resuelto',
  closed: 'Cerrado',
};

/**
 * Notifica al equipo de soporte cuando se crea un nuevo ticket.
 */
const notifyTicketCreated = async (ticket) => {
  try {
    // Buscar usuarios con rol support y super_admin
    const agents = await User.findAll({
      where: { role: ['support', 'super_admin'], is_active: true },
      attributes: ['id', 'first_name', 'email'],
    });

    if (agents.length === 0) return;

    const ticketData = {
      ...ticket.toJSON(),
      creator: ticket.creator || await User.findByPk(ticket.created_by, { attributes: ['id', 'first_name', 'last_name'] }),
      tenant: ticket.tenant || await Tenant.findByPk(ticket.tenant_id, { attributes: ['id', 'company_name'] }),
    };

    for (const agent of agents) {
      if (!agent.email) continue;
      const t = emailTemplates.supportTicketCreated(agent, ticketData);
      await sendEmail({ to: agent.email, subject: t.subject, html: t.html, text: t.text });
    }

    logger.info(`[SUPPORT] Notificación de ticket creado enviada a ${agents.length} agente(s)`);
  } catch (error) {
    logger.error('[SUPPORT] Error notificando ticket creado:', error.message);
  }
};

/**
 * Notifica cuando hay un nuevo mensaje en un ticket.
 * @param {object} ticket - ticket con creator, tenant, messages
 * @param {object} messageAuthor - usuario que envió el mensaje
 * @param {boolean} isInternalNote - si es nota interna, no notificar al cliente
 */
const notifyNewMessage = async (ticket, messageAuthor, isInternalNote = false) => {
  try {
    if (isInternalNote) return; // Las notas internas no se notifican

    const isFromAgent = ['support', 'super_admin'].includes(messageAuthor.role);

    if (isFromAgent) {
      // Notificar al creador del ticket (cliente)
      const creator = ticket.creator || await User.findByPk(ticket.created_by, { attributes: ['id', 'first_name', 'email'] });
      if (creator?.email) {
        const t = emailTemplates.supportNewMessage(creator, ticket, true);
        await sendEmail({ to: creator.email, subject: t.subject, html: t.html, text: t.text });
      }
    } else {
      // Notificar a los agentes de soporte
      const agents = await User.findAll({
        where: { role: ['support', 'super_admin'], is_active: true },
        attributes: ['id', 'first_name', 'email'],
      });
      for (const agent of agents) {
        if (!agent.email) continue;
        const t = emailTemplates.supportNewMessage(agent, ticket, false);
        await sendEmail({ to: agent.email, subject: t.subject, html: t.html, text: t.text });
      }
    }
  } catch (error) {
    logger.error('[SUPPORT] Error notificando nuevo mensaje:', error.message);
  }
};

/**
 * Notifica al creador del ticket cuando cambia su estado.
 */
const notifyStatusChanged = async (ticket, oldStatus, newStatus) => {
  try {
    const creator = ticket.creator || await User.findByPk(ticket.created_by, { attributes: ['id', 'first_name', 'email'] });
    if (!creator?.email) return;

    const t = emailTemplates.supportStatusChanged(
      creator,
      ticket,
      STATUS_LABELS[oldStatus] || oldStatus,
      STATUS_LABELS[newStatus] || newStatus,
    );
    await sendEmail({ to: creator.email, subject: t.subject, html: t.html, text: t.text });
    logger.info(`[SUPPORT] Notificación de cambio de estado enviada a ${creator.email}`);
  } catch (error) {
    logger.error('[SUPPORT] Error notificando cambio de estado:', error.message);
  }
};

module.exports = {
  notifyTicketCreated,
  notifyNewMessage,
  notifyStatusChanged,
};
