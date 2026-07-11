// backend/src/controllers/ai/aiAssistant.controller.js
const { AiConversation, AiMessage } = require('../../models');
const { runAgentTurn } = require('../../services/ai/agent.service');
const logger = require('../../config/logger');

// Roles que pueden usar el asistente (y, desde Fase 2, también aprobar o
// rechazar sus propuestas). Ajustable sin tocar el resto del sistema de permisos.
const ALLOWED_ROLES = ['admin', 'manager', 'accountant'];
exports.ALLOWED_ROLES = ALLOWED_ROLES;

// POST /api/ai-assistant/chat
// body: { conversation_id?: uuid, message: string }
exports.chat = async (req, res) => {
  try {
    const { conversation_id, message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'El mensaje no puede estar vacío' });
    }

    if (!ALLOWED_ROLES.includes(req.user.role) && req.user.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'Tu rol no tiene acceso a NEXA',
      });
    }

    let conversation;
    if (conversation_id) {
      conversation = await AiConversation.findOne({
        where: { id: conversation_id, tenant_id: req.tenant_id, user_id: req.user.id },
      });
      if (!conversation) {
        return res.status(404).json({ success: false, message: 'Conversación no encontrada' });
      }
    } else {
      conversation = await AiConversation.create({
        tenant_id: req.tenant_id,
        user_id: req.user.id,
        branch_id: req.branch_id || null,
        title: message.slice(0, 80),
      });
    }

    // Historial reciente para darle contexto al modelo (últimos 20 mensajes,
    // suficiente para una conversación de consulta sin disparar el costo de tokens).
    const previousMessages = await AiMessage.findAll({
      where: { conversation_id: conversation.id },
      order: [['created_at', 'ASC']],
      limit: 20,
    });

    const history = previousMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    await AiMessage.create({
      conversation_id: conversation.id,
      tenant_id: req.tenant_id,
      role: 'user',
      content: message,
    });

    // Se cuelga del request (no del historial) para que las tools de
    // escritura (Fase 2) puedan asociar cada AiProposal a esta conversación
    // sin cambiar la firma de runAgentTurn.
    req.ai_conversation_id = conversation.id;

    let reply, toolCalls;
    try {
      ({ reply, toolCalls } = await runAgentTurn(req, history, message));
    } catch (agentError) {
      // El mensaje del usuario ya quedó guardado en esta conversación; si no
      // devolvemos el conversation_id, el frontend crea una conversación
      // nueva en el siguiente intento y este mensaje queda huérfano.
      agentError.conversation_id = conversation.id;
      throw agentError;
    }

    // Guardamos cada tool invocada como su propio mensaje (auditoría: qué
    // preguntó, qué tools se usaron, qué datos devolvieron).
    for (const call of toolCalls) {
      await AiMessage.create({
        conversation_id: conversation.id,
        tenant_id: req.tenant_id,
        role: 'tool',
        tool_name: call.tool_name,
        tool_args: call.args,
        tool_result: call.result,
      });
    }

    await AiMessage.create({
      conversation_id: conversation.id,
      tenant_id: req.tenant_id,
      role: 'assistant',
      content: reply,
    });

    // AiMessage se crea con updatedAt: false, así que nada más toca este
    // campo — sin esto, listConversations (que ordena por updated_at)
    // termina ordenando por fecha de creación, no de último uso.
    await conversation.update({ updated_at: new Date() });

    res.json({
      success: true,
      data: {
        conversation_id: conversation.id,
        reply,
        tool_calls: toolCalls.map((c) => ({ tool_name: c.tool_name, args: c.args })), // sin el resultado crudo, para no saturar la respuesta
      },
    });
  } catch (error) {
    logger.error(`[aiAssistant.chat] ${error.message}`);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error procesando tu mensaje con NEXA',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      conversation_id: error.conversation_id,
    });
  }
};

// GET /api/ai-assistant/conversations
exports.listConversations = async (req, res) => {
  try {
    const conversations = await AiConversation.findAll({
      where: { tenant_id: req.tenant_id, user_id: req.user.id, status: 'active' },
      order: [['updated_at', 'DESC']],
      limit: 50,
      attributes: ['id', 'title', 'created_at', 'updated_at'],
    });
    res.json({ success: true, data: conversations });
  } catch (error) {
    logger.error(`[aiAssistant.listConversations] ${error.message}`);
    res.status(500).json({ success: false, message: 'Error al listar conversaciones' });
  }
};

// GET /api/ai-assistant/conversations/:id
exports.getConversation = async (req, res) => {
  try {
    const conversation = await AiConversation.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id, user_id: req.user.id },
    });
    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversación no encontrada' });
    }

    const messages = await AiMessage.findAll({
      where: { conversation_id: conversation.id, role: ['user', 'assistant'] },
      order: [['created_at', 'ASC']],
      attributes: ['id', 'role', 'content', 'created_at'],
    });

    res.json({ success: true, data: { conversation, messages } });
  } catch (error) {
    logger.error(`[aiAssistant.getConversation] ${error.message}`);
    res.status(500).json({ success: false, message: 'Error al obtener la conversación' });
  }
};
