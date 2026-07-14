// backend/src/services/ai/aiClient.js
//
// Punto único de entrada para el resto de NEXA (agent.service.js): intenta
// Groq primero (proveedor principal, más rápido/económico) y, si falla,
// cae automáticamente a Claude (Anthropic) de forma transparente — mismo
// contrato de entrada/salida en formato OpenAI function-calling que ambos
// clientes ya respetan (ver groqClient.js / claudeClient.js).
//
// El fallback solo aplica si Claude está configurado (ANTHROPIC_API_KEY);
// si no lo está, se propaga el error original de Groq sin intentar nada más.

const groqClient = require('./groqClient');
const claudeClient = require('./claudeClient');
const logger = require('../../config/logger');

/**
 * @param {Array} messages - mensajes en formato OpenAI (system/user/assistant/tool)
 * @param {Array} tools - definiciones de tools en formato OpenAI function calling
 * @returns {Promise<Object>} mensaje del asistente en formato OpenAI {content, tool_calls?}
 */
async function chatCompletion(messages, tools = []) {
  try {
    return await groqClient.chatCompletion(messages, tools);
  } catch (groqError) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw groqError;
    }

    logger.warn(`[aiClient] Groq falló ("${groqError.message}"), usando fallback a Claude`);

    try {
      return await claudeClient.chatCompletion(messages, tools);
    } catch (claudeError) {
      logger.error(`[aiClient] Fallback a Claude también falló: ${claudeError.message}`);
      const err = new Error(
        `NEXA no pudo responder: Groq falló (${groqError.message}) y el fallback a Claude también falló (${claudeError.message}).`,
      );
      err.statusCode = claudeError.statusCode || groqError.statusCode || 502;
      throw err;
    }
  }
}

module.exports = { chatCompletion };
