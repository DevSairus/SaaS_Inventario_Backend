// backend/src/services/ai/mimoClient.js
//
// Cliente sobre la API de MiMo (Xiaomi), usado como segundo fallback de NEXA
// (después de Groq y Claude). El endpoint es compatible con el formato de
// OpenAI chat completions + tool calling, igual que groqClient.js — misma
// forma de entrada/salida, sin necesidad de conversión.
//
// Variables de entorno requeridas:
//   MIMO_API_KEY  → API key de https://mimo.mi.com (Console → API Keys, formato
//                   sk-xxxxx en pay-as-you-go, tp-xxxxx en Token Plan)
//   MIMO_BASE_URL → opcional, default pay-as-you-go ('https://api.xiaomimimo.com/v1').
//                   Si tienes un Token Plan, usa el Base URL exclusivo que te da
//                   la consola (ej. 'https://token-plan-cn.xiaomimimo.com/v1').
//   MIMO_MODEL    → opcional, default 'mimo-v2.5-pro'

const axios = require('axios');
const logger = require('../../config/logger');

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5-pro';

let warnedMissingKey = false;

// Igual que groqClient/claudeClient: reintentamos una vez ante errores
// transitorios del proveedor antes de rendirnos.
const RETRYABLE_STATUSES = [429, 503];
const RETRY_DELAY_MS = 700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Llama a la API de MiMo con soporte de tool calling, aceptando y
 * devolviendo mensajes en el mismo formato OpenAI que usa groqClient.
 *
 * @param {Array} messages - mensajes en formato OpenAI (system/user/assistant/tool)
 * @param {Array} tools - definiciones de tools en formato OpenAI function calling
 * @returns {Promise<Object>} choices[0].message de la respuesta de MiMo
 */
async function chatCompletion(messages, tools = []) {
  if (!process.env.MIMO_API_KEY) {
    if (!warnedMissingKey) {
      logger.error('[mimoClient] MIMO_API_KEY no está configurada.');
      warnedMissingKey = true;
    }
    const err = new Error('NEXA (fallback MiMo) no está configurado (falta MIMO_API_KEY).');
    err.statusCode = 503;
    throw err;
  }

  const payload = {
    model: DEFAULT_MODEL,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    temperature: 0.2, // mismo criterio que groqClient: consistencia sobre creatividad para datos contables
    max_completion_tokens: 1500,
  };
  const requestConfig = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MIMO_API_KEY}`,
    },
    timeout: 30000,
  };

  const baseUrl = process.env.MIMO_BASE_URL || DEFAULT_BASE_URL;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let lastError;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const response = await axios.post(url, payload, requestConfig);
      const choice = response.data.choices[0];

      if (choice.finish_reason === 'length') {
        logger.warn('[mimoClient] Respuesta cortada por max_completion_tokens (finish_reason=length)');
      }

      return choice.message;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (attempt === 0 && RETRYABLE_STATUSES.includes(status)) {
        logger.warn(`[mimoClient] Status ${status} de MiMo, reintentando en ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  const detail = lastError.response?.data?.error?.message || lastError.message;
  logger.error(`[mimoClient] Error llamando a MiMo: ${detail}`);
  const err = new Error(`Error del asistente de IA (MiMo): ${detail}`);
  err.statusCode = lastError.response?.status || 502;
  throw err;
}

module.exports = { chatCompletion, DEFAULT_MODEL };
