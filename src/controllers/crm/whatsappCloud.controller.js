// Controllers WhatsApp Cloud API (Embedded Signup + inbox + envío).
const { Op } = require('sequelize');
const logger = require('../../config/logger') || console;
const waCloud = require('../../services/whatsappCloud.service');
const { WaConversation, WaMessage, Customer, User } = require('../../models');
const {
  applyWaConversationScope,
  canManageAllAssignments,
} = require('../../utils/waConversationScope');
const { mergePrefs, MARK_OPTIONS, windowStatus } = require('../../utils/waWorkspacePrefs');

const getWhatsAppStatus = async (req, res) => {
  try {
    const data = await waCloud.getWhatsAppStatus(req.tenant_id);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[WA Cloud] status:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estado de WhatsApp' });
  }
};

const completeEmbeddedSignup = async (req, res) => {
  try {
    const {
      code,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      display_phone: displayPhone,
      coexistence,
    } = req.body || {};

    const data = await waCloud.completeEmbeddedSignup({
      tenantId: req.tenant_id,
      code,
      wabaId,
      phoneNumberId,
      displayPhone,
      coexistence: coexistence !== false,
    });

    res.json({
      success: true,
      message: 'WhatsApp conectado (coexistencia). El número sigue usable en WhatsApp Business App.',
      data,
    });
  } catch (error) {
    logger.error('[WA Cloud] embedded-signup:', error.response?.data || error.message);
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.response?.data?.error?.message || error.message || 'No se pudo completar Embedded Signup',
    });
  }
};

const disconnect = async (req, res) => {
  try {
    const data = await waCloud.disconnectWhatsApp(req.tenant_id);
    res.json({ success: true, message: 'WhatsApp desconectado', data });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error al desconectar',
    });
  }
};

const sendTemplate = async (req, res) => {
  try {
    const { to, template_name: templateName, language, components } = req.body || {};
    if (!to || !templateName) {
      return res.status(400).json({ success: false, message: 'to y template_name son requeridos' });
    }
    const data = await waCloud.sendTemplateFromTenant({
      tenantId: req.tenant_id,
      to,
      templateName,
      language: language || 'es',
      components: components || [],
      userId: req.user?.id || null,
      source: 'api',
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[WA Cloud] send-template:', error.response?.data || error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.response?.data?.error?.message || error.message || 'Error al enviar plantilla',
    });
  }
};

const sendText = async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) {
      return res.status(400).json({ success: false, message: 'to y body son requeridos' });
    }
    const data = await waCloud.sendTextFromTenant({
      tenantId: req.tenant_id,
      to,
      body,
      userId: req.user?.id || null,
      source: 'api',
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[WA Cloud] send-text:', error.response?.data || error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.response?.data?.error?.message || error.message || 'Error al enviar mensaje',
    });
  }
};

async function loadAccessibleConversation(req, conversationId) {
  let where = { id: conversationId, tenant_id: req.tenant_id };
  where = await applyWaConversationScope(req, where);
  return WaConversation.findOne({
    where,
    include: [
      { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone', 'mobile'] },
      { model: User, as: 'assignee', attributes: ['id', 'first_name', 'last_name'] },
    ],
  });
}

const listConversations = async (req, res) => {
  try {
    const { q, status, scope } = req.query;
    let where = { tenant_id: req.tenant_id };
    if (status) where.status = status;

    // scope=all solo aplica a admin/manager; sellers siempre filtrados
    if (scope !== 'mine') {
      where = await applyWaConversationScope(req, where);
    } else {
      where.assigned_user_id = req.user.id;
    }

    if (q) {
      const term = `%${String(q).trim()}%`;
      where = {
        ...where,
        [Op.and]: [
          {
            [Op.or]: [
              { wa_contact_phone: { [Op.iLike]: term } },
              { wa_contact_name: { [Op.iLike]: term } },
            ],
          },
        ],
      };
    }

    const conversations = await WaConversation.findAll({
      where,
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone', 'mobile'] },
        { model: User, as: 'assignee', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['is_pinned', 'DESC'], ['follow_up_at', 'ASC'], ['last_message_at', 'DESC'], ['updated_at', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 50, 100),
    });

    const data = conversations.map((c) => {
      const plain = c.toJSON();
      plain.window = windowStatus(c.last_inbound_at);
      return plain;
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[WA Cloud] list conversations:', error);
    res.status(500).json({ success: false, message: 'Error al listar conversaciones' });
  }
};

const getConversation = async (req, res) => {
  try {
    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });
    const plain = conv.toJSON ? conv.toJSON() : conv;
    plain.window = windowStatus(conv.last_inbound_at);
    res.json({ success: true, data: plain });
  } catch (error) {
    logger.error('[WA Cloud] get conversation:', error);
    res.status(500).json({ success: false, message: 'Error al obtener conversación' });
  }
};

const listMessages = async (req, res) => {
  try {
    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });

    const before = req.query.before ? new Date(req.query.before) : null;
    const where = { conversation_id: conv.id, tenant_id: req.tenant_id };
    if (before && !Number.isNaN(before.getTime())) {
      where.created_at = { [Op.lt]: before };
    }

    const messages = await WaMessage.findAll({
      where,
      include: [{ model: User, as: 'sent_by', attributes: ['id', 'first_name', 'last_name'] }],
      order: [['created_at', 'DESC']],
      limit: Math.min(Number(req.query.limit) || 50, 100),
    });

    res.json({ success: true, data: messages.reverse() });
  } catch (error) {
    logger.error('[WA Cloud] list messages:', error);
    res.status(500).json({ success: false, message: 'Error al listar mensajes' });
  }
};

const sendConversationText = async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body?.trim()) {
      return res.status(400).json({ success: false, message: 'body es requerido' });
    }

    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });

    // Seller solo escribe en propias o sin asignar (al enviar, auto-asigna)
    if (!canManageAllAssignments(req.user.role)) {
      if (conv.assigned_user_id && conv.assigned_user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'No puedes responder esta conversación' });
      }
      if (!conv.assigned_user_id) {
        await conv.update({ assigned_user_id: req.user.id });
      }
    }

    const data = await waCloud.sendTextFromTenant({
      tenantId: req.tenant_id,
      to: conv.wa_contact_phone,
      body: body.trim(),
      userId: req.user.id,
      source: 'api',
    });

    res.json({ success: true, data });
  } catch (error) {
    logger.error('[WA Cloud] send conversation text:', error.response?.data || error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.response?.data?.error?.message || error.message || 'Error al enviar mensaje',
    });
  }
};

const markRead = async (req, res) => {
  try {
    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });
    await conv.update({ unread_count: 0 });
    res.json({ success: true, data: { id: conv.id, unread_count: 0 } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al marcar como leída' });
  }
};

const assignConversation = async (req, res) => {
  try {
    const { assigned_user_id: assignedUserId } = req.body || {};
    const conv = await WaConversation.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
    });
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });

    const role = req.user.role;
    if (canManageAllAssignments(role)) {
      if (assignedUserId) {
        const user = await User.findOne({ where: { id: assignedUserId, tenant_id: req.tenant_id } });
        if (!user) return res.status(400).json({ success: false, message: 'Usuario no válido' });
      }
      await conv.update({ assigned_user_id: assignedUserId || null });
    } else {
      if (assignedUserId === null || assignedUserId === '') {
        if (conv.assigned_user_id !== req.user.id) {
          return res.status(403).json({ success: false, message: 'Solo puedes desasignar tus conversaciones' });
        }
        await conv.update({ assigned_user_id: null });
      } else if (assignedUserId === req.user.id) {
        if (conv.assigned_user_id && conv.assigned_user_id !== req.user.id) {
          return res.status(403).json({ success: false, message: 'Conversación ya asignada a otro asesor' });
        }
        await conv.update({ assigned_user_id: req.user.id });
      } else {
        return res.status(403).json({ success: false, message: 'No puedes asignar a otros usuarios' });
      }
    }

    const fresh = await loadAccessibleConversation(req, conv.id);
    try {
      const { emitWaTenant } = require('../../services/whatsappNotifications.socket');
      emitWaTenant(req.tenant_id, 'wa:assigned', {
        conversation_id: conv.id,
        assigned_user_id: fresh?.assigned_user_id || null,
      });
    } catch (_) { /* optional */ }

    res.json({ success: true, data: fresh || conv });
  } catch (error) {
    logger.error('[WA Cloud] assign:', error);
    res.status(500).json({ success: false, message: 'Error al asignar conversación' });
  }
};

const waOps = require('../../services/waCampaigns.service');

const syncTemplates = async (req, res) => {
  try {
    const data = await waOps.syncTemplatesForTenant(req.tenant_id);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error al sincronizar plantillas',
    });
  }
};

const listTemplates = async (req, res) => {
  try {
    const data = await waOps.listLocalTemplates(req.tenant_id, { status: req.query.status });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar plantillas' });
  }
};

const createReminder = async (req, res) => {
  try {
    const {
      customer_id: customerId,
      phone,
      template_name: templateName,
      language,
      components,
      scheduled_at: scheduledAt,
    } = req.body || {};
    const data = await waOps.createReminderJob({
      tenantId: req.tenant_id,
      customerId,
      phone,
      templateName,
      language,
      components,
      scheduledAt,
      userId: req.user.id,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error al crear recordatorio',
    });
  }
};

const listReminders = async (req, res) => {
  try {
    const { WaReminderJob } = require('../../models');
    const where = { tenant_id: req.tenant_id };
    if (req.query.status) where.status = req.query.status;
    const data = await WaReminderJob.findAll({
      where,
      order: [['scheduled_at', 'ASC']],
      limit: 100,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar recordatorios' });
  }
};

const createCampaign = async (req, res) => {
  try {
    const {
      name,
      template_name: templateName,
      language,
      audience_filter: audienceFilter,
      start,
    } = req.body || {};
    const data = await waOps.createCampaign({
      tenantId: req.tenant_id,
      name,
      templateName,
      language,
      audienceFilter: audienceFilter || {},
      userId: req.user.id,
      start: !!start,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error al crear campaña',
    });
  }
};

const listCampaigns = async (req, res) => {
  try {
    const { WaCampaign } = require('../../models');
    const data = await WaCampaign.findAll({
      where: { tenant_id: req.tenant_id },
      order: [['created_at', 'DESC']],
      limit: 50,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al listar campañas' });
  }
};

const startCampaign = async (req, res) => {
  try {
    const data = await waOps.startCampaign(req.tenant_id, req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Error al iniciar campaña',
    });
  }
};

const suggestReply = async (req, res) => {
  try {
    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });

    const recent = await WaMessage.findAll({
      where: { conversation_id: conv.id, tenant_id: req.tenant_id },
      order: [['created_at', 'DESC']],
      limit: 12,
    });
    const transcript = recent.reverse().map((m) => {
      const who = m.direction === 'in' ? 'Cliente' : 'Asesor';
      return `${who}: ${m.body || `[${m.type}]`}`;
    }).join('\n');

    const aiClient = require('../../services/ai/aiClient');
    const companyHint = req.tenant?.company_name || 'el negocio';
    const result = await aiClient.chatCompletion([
      {
        role: 'system',
        content: `Eres un asesor comercial de ${companyHint} en Colombia. Sugiere UNA respuesta corta y profesional para WhatsApp (máx 500 caracteres). Solo el texto del mensaje, sin comillas ni explicación.`,
      },
      {
        role: 'user',
        content: `Conversación reciente:\n${transcript || '(sin mensajes)'}\n\nSugiere la siguiente respuesta del asesor.`,
      },
    ]);

    const suggestion = (result?.content || '').trim();
    res.json({ success: true, data: { suggestion } });
  } catch (error) {
    logger.error('[WA Cloud] suggest:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'No se pudo generar sugerencia',
    });
  }
};

const summarizeConversation = async (req, res) => {
  try {
    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });

    const recent = await WaMessage.findAll({
      where: { conversation_id: conv.id, tenant_id: req.tenant_id },
      order: [['created_at', 'DESC']],
      limit: 40,
    });
    const transcript = recent.reverse().map((m) => {
      const who = m.direction === 'in' ? 'Cliente' : 'Asesor';
      return `${who}: ${m.body || `[${m.type}]`}`;
    }).join('\n');

    const aiClient = require('../../services/ai/aiClient');
    const result = await aiClient.chatCompletion([
      {
        role: 'system',
        content: 'Resume en 3-5 viñetas cortas una conversación de WhatsApp comercial (español Colombia). Incluye intención del cliente y próximo paso sugerido.',
      },
      { role: 'user', content: transcript || '(vacía)' },
    ]);

    res.json({ success: true, data: { summary: (result?.content || '').trim() } });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'No se pudo resumir',
    });
  }
};


const setDemoMode = async (req, res) => {
  try {
    if (!['admin', 'manager', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Solo admin puede activar el modo demo' });
    }
    const enabled = req.body?.enabled !== false;
    const data = await waCloud.setDemoMode(req.tenant_id, enabled);
    res.json({
      success: true,
      message: enabled
        ? 'Modo demo activo: el inbox funciona sin Meta (ideal para demos comerciales)'
        : 'Modo demo desactivado',
      data,
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

const simulateInbound = async (req, res) => {
  try {
    const { phone, name, body, type, media_url: mediaUrl, conversation_id: conversationId } = req.body || {};
    let targetPhone = phone;
    let targetName = name;
    if (conversationId) {
      const conv = await loadAccessibleConversation(req, conversationId);
      if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });
      targetPhone = conv.wa_contact_phone;
      targetName = conv.wa_contact_name || name;
    }
    if (!targetPhone || !body) {
      return res.status(400).json({ success: false, message: 'phone/conversation_id y body son requeridos' });
    }
    const data = await waCloud.simulateInboundDemo({
      tenantId: req.tenant_id,
      phone: targetPhone,
      name: targetName,
      body,
      type: type || 'text',
      mediaUrl: mediaUrl || null,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

const updateConversationMeta = async (req, res) => {
  try {
    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });

    const {
      is_pinned,
      priority,
      follow_up_at,
      marks,
      internal_note,
      status,
    } = req.body || {};

    const patch = {};
    if (is_pinned !== undefined) patch.is_pinned = !!is_pinned;
    if (priority !== undefined) patch.priority = priority;
    if (follow_up_at !== undefined) patch.follow_up_at = follow_up_at || null;
    if (marks !== undefined) patch.marks = Array.isArray(marks) ? marks : [];
    if (internal_note !== undefined) patch.internal_note = internal_note;
    if (status !== undefined) patch.status = status;

    await conv.update(patch);
    const fresh = await loadAccessibleConversation(req, conv.id);
    try {
      const { emitWaTenant } = require('../../services/whatsappNotifications.socket');
      emitWaTenant(req.tenant_id, 'wa:conversation-updated', { conversation: fresh });
    } catch (_) {}
    res.json({ success: true, data: fresh });
  } catch (error) {
    logger.error('[WA Cloud] update meta:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar conversación' });
  }
};

const getWorkspacePrefs = async (req, res) => {
  try {
    const dbUser = await User.findByPk(req.user.id, { attributes: ['id', 'wa_workspace_prefs'] });
    const prefs = mergePrefs(dbUser?.wa_workspace_prefs);
    res.json({ success: true, data: { prefs, mark_options: MARK_OPTIONS } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al leer preferencias' });
  }
};

const updateWorkspacePrefs = async (req, res) => {
  try {
    const dbUser = await User.findByPk(req.user.id, { attributes: ['id', 'wa_workspace_prefs'] });
    const next = mergePrefs({ ...(dbUser?.wa_workspace_prefs || {}), ...(req.body?.prefs || req.body || {}) });
    await User.update({ wa_workspace_prefs: next }, { where: { id: req.user.id } });
    res.json({ success: true, data: { prefs: next, mark_options: MARK_OPTIONS } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al guardar preferencias' });
  }
};


const sendConversationMedia = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: 'Archivo requerido (campo file)' });
    }

    const conv = await loadAccessibleConversation(req, req.params.id);
    if (!conv) return res.status(404).json({ success: false, message: 'Conversación no encontrada' });

    if (!canManageAllAssignments(req.user.role)) {
      if (conv.assigned_user_id && conv.assigned_user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'No puedes responder esta conversación' });
      }
      if (!conv.assigned_user_id) {
        await conv.update({ assigned_user_id: req.user.id });
      }
    }

    const { guessWaType } = require('../../middleware/uploadWhatsAppMedia');
    const type = req.body?.type || guessWaType(file.mimetype, file.originalname);
    const caption = (req.body?.caption || req.body?.body || '').trim() || null;

    const data = await waCloud.sendMediaFromTenant({
      tenantId: req.tenant_id,
      to: conv.wa_contact_phone,
      type,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      filename: file.originalname,
      caption,
      userId: req.user.id,
      source: 'api',
    });

    res.json({ success: true, data });
  } catch (error) {
    logger.error('[WA Cloud] send media:', error.response?.data || error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.response?.data?.error?.message || error.message || 'Error al enviar archivo',
    });
  }
};

module.exports = {
  getWhatsAppStatus,
  completeEmbeddedSignup,
  disconnect,
  sendTemplate,
  sendText,
  listConversations,
  getConversation,
  listMessages,
  sendConversationText,
  sendConversationMedia,
  markRead,
  assignConversation,
  syncTemplates,
  listTemplates,
  createReminder,
  listReminders,
  createCampaign,
  listCampaigns,
  startCampaign,
  suggestReply,
  summarizeConversation,
  setDemoMode,
  simulateInbound,
  updateConversationMeta,
  getWorkspacePrefs,
  updateWorkspacePrefs,
};
