// backend/src/services/ai/groqClient.js
//
// Cliente delgado sobre la API de Groq (compatible con el formato de OpenAI
// chat completions + tool calling). Se usa axios porque ya es dependencia
// del proyecto — no se agrega ningún paquete nuevo.
//
// Variables de entorno requeridas:
//   GROQ_API_KEY   → API key de https://console.groq.com
//   GROQ_MODEL      → opcional, default 'llama-3.3-70b-versatile'

const axios = require('axios');
const logger = require('../../config/logger');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

let warnedMissingKey = false;

/**
 * Llama a la API de Groq con soporte de tool calling.
 *
 * @param {Array} messages - mensajes en formato OpenAI (system/user/assistant/tool)
 * @param {Array} tools - definiciones de tools en formato OpenAI function calling
 * @returns {Promise<Object>} choices[0].message de la respuesta de Groq
 */
// Status transitorios de Groq (rate limit / servicio momentáneamente no
// disponible) que vale la pena reintentar una vez antes de rendirse.
const RETRYABLE_STATUSES = [429, 503];
const RETRY_DELAY_MS = 700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chatCompletion(messages, tools = []) {
  if (!process.env.GROQ_API_KEY) {
    if (!warnedMissingKey) {
      logger.error('[groqClient] GROQ_API_KEY no está configurada.');
      warnedMissingKey = true;
    }
    const err = new Error('NEXA no está configurado todavía (falta GROQ_API_KEY).');
    err.statusCode = 503;
    throw err;
  }

  const payload = {
    model: DEFAULT_MODEL,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    temperature: 0.2, // preferimos respuestas consistentes, no creativas, para datos contables
    max_tokens: 1500,
  };
  const requestConfig = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    timeout: 30000,
  };

  let lastError;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const response = await axios.post(GROQ_URL, payload, requestConfig);
      const choice = response.data.choices[0];

      if (choice.finish_reason === 'length') {
        logger.warn('[groqClient] Respuesta cortada por max_tokens (finish_reason=length)');
      }

      const usage = response.data.usage;
      if (usage) {
        logger.info(
          `[groqClient] tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`,
        );
      }

      return choice.message;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (attempt === 0 && RETRYABLE_STATUSES.includes(status)) {
        logger.warn(`[groqClient] Status ${status} de Groq, reintentando en ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  const detail = lastError.response?.data?.error?.message || lastError.message;
  logger.error(`[groqClient] Error llamando a Groq: ${detail}`);
  const err = new Error(`Error del asistente de IA: ${detail}`);
  err.statusCode = lastError.response?.status || 502;
  throw err;
}

module.exports = { chatCompletion, DEFAULT_MODEL };
