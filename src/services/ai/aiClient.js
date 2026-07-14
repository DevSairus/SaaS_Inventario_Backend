// backend/src/services/ai/aiClient.js
//
// Punto único de entrada para el resto de NEXA (agent.service.js): intenta
// Groq primero (proveedor principal, más rápido/económico) y, si falla, cae
// en cascada a Claude (Anthropic) y luego a MiMo (Xiaomi) de forma
// transparente — mismo contrato de entrada/salida en formato OpenAI
// function-calling que los tres clientes ya respetan (ver groqClient.js /
// claudeClient.js / mimoClient.js).
//
// Cada nivel de fallback solo se intenta si su API key está configurada; si
// no lo está, se salta directo al siguiente. Si ninguno queda disponible, se
// propaga el error original de Groq.

const groqClient = require('./groqClient');
const claudeClient = require('./claudeClient');
const mimoClient = require('./mimoClient');
const logger = require('../../config/logger');

// Orden de la cascada: Groq siempre primero (principal). Claude y MiMo se
// agregan a la lista solo si tienen API key configurada — el que no esté
// configurado simplemente no participa del fallback.
function buildProviders() {
  const providers = [{ name: 'Groq', client: groqClient }];
  if (process.env.ANTHROPIC_API_KEY) providers.push({ name: 'Claude', client: claudeClient });
  if (process.env.MIMO_API_KEY) providers.push({ name: 'MiMo', client: mimoClient });
  return providers;
}

/**
 * @param {Array} messages - mensajes en formato OpenAI (system/user/assistant/tool)
 * @param {Array} tools - definiciones de tools en formato OpenAI function calling
 * @returns {Promise<Object>} mensaje del asistente en formato OpenAI {content, tool_calls?}
 */
async function chatCompletion(messages, tools = []) {
  const providers = buildProviders();
  const errors = [];

  for (let i = 0; i < providers.length; i++) {
    const { name, client } = providers[i];
    try {
      return await client.chatCompletion(messages, tools);
    } catch (error) {
      errors.push({ name, error });
      const isLast = i === providers.length - 1;
      if (isLast) {
        logger.error(`[aiClient] Todos los proveedores fallaron: ${errors.map((e) => `${e.name} (${e.error.message})`).join(', ')}`);
        const err = new Error(
          `NEXA no pudo responder: ${errors.map((e) => `${e.name} falló (${e.error.message})`).join(', ')}.`,
        );
        err.statusCode = error.statusCode || 502;
        throw err;
      }
      const next = providers[i + 1].name;
      logger.warn(`[aiClient] ${name} falló ("${error.message}"), usando fallback a ${next}`);
    }
  }
}

module.exports = { chatCompletion };
