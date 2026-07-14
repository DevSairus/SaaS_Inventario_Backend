// backend/src/services/ai/claudeClient.js
//
// Cliente sobre la API de Claude (Anthropic), usado como fallback de Groq.
// Expone la misma forma que groqClient.js — chatCompletion(messages, tools)
// recibiendo/devolviendo mensajes en formato OpenAI function-calling — para
// que agent.service.js (y aiClient.js) no tengan que saber qué proveedor
// respondió.
//
// Variables de entorno requeridas:
//   ANTHROPIC_API_KEY → API key de https://console.anthropic.com
//   CLAUDE_MODEL       → opcional, default 'claude-sonnet-5'
//
// Claude es solo un fallback (Groq es el proveedor principal) — se usa
// Sonnet en vez de Opus a propósito: mismo tool-calling y calidad de
// respuesta suficiente para este asistente a una fracción del costo.

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../config/logger');

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 1500; // mismo tope que groqClient, para respuestas de tamaño consistente

// Igual que groqClient: reintentamos una vez ante errores transitorios del
// proveedor antes de rendirnos.
const RETRYABLE_STATUSES = [429, 500, 529];
const RETRY_DELAY_MS = 700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let client = null;
let warnedMissingKey = false;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    if (!warnedMissingKey) {
      logger.error('[claudeClient] ANTHROPIC_API_KEY no está configurada.');
      warnedMissingKey = true;
    }
    const err = new Error('NEXA (fallback Claude) no está configurado (falta ANTHROPIC_API_KEY).');
    err.statusCode = 503;
    throw err;
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// ── Conversión OpenAI -> Anthropic ─────────────────────────────────────────

function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// Anthropic exige que todos los tool_result de un turno vayan en UN solo
// mensaje 'user'. En el historial OpenAI cada resultado de tool llega como
// un mensaje 'tool' separado (uno por tool_call) — hay que agruparlos.
function toAnthropicMessages(openAiMessages) {
  const systemParts = [];
  const messages = [];
  let pendingToolResults = null;

  const flushToolResults = () => {
    if (pendingToolResults && pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults });
    }
    pendingToolResults = null;
  };

  for (const msg of openAiMessages) {
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content ?? '',
      });
      continue;
    }

    flushToolResults();

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const toolCall of msg.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    // user / assistant final, contenido de texto plano
    messages.push({ role: msg.role, content: msg.content ?? '' });
  }

  flushToolResults();

  return { system: systemParts.join('\n\n'), messages };
}

// ── Conversión Anthropic -> OpenAI (lo que espera agent.service.js) ────────

function toOpenAiMessage(response) {
  const textParts = [];
  const toolCalls = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }

  if (response.stop_reason === 'max_tokens') {
    logger.warn('[claudeClient] Respuesta cortada por max_tokens (stop_reason=max_tokens)');
  }

  return {
    content: textParts.length > 0 ? textParts.join('\n') : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Llama a la API de Claude con soporte de tool calling, aceptando y
 * devolviendo mensajes en el mismo formato OpenAI que usa groqClient.
 *
 * @param {Array} messages - mensajes en formato OpenAI (system/user/assistant/tool)
 * @param {Array} tools - definiciones de tools en formato OpenAI function calling
 * @returns {Promise<Object>} mensaje del asistente en formato OpenAI {content, tool_calls?}
 */
async function chatCompletion(messages, tools = []) {
  const anthropic = getClient();
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

  const payload = {
    model: DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: anthropicMessages,
    ...(tools.length > 0 ? { tools: toAnthropicTools(tools), tool_choice: { type: 'auto' } } : {}),
  };

  let lastError;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const response = await anthropic.messages.create(payload);
      return toOpenAiMessage(response);
    } catch (error) {
      lastError = error;
      const status = error.status;
      if (attempt === 0 && RETRYABLE_STATUSES.includes(status)) {
        logger.warn(`[claudeClient] Status ${status} de Claude, reintentando en ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  const detail = lastError.error?.error?.message || lastError.message;
  logger.error(`[claudeClient] Error llamando a Claude: ${detail}`);
  const err = new Error(`Error del asistente de IA (Claude): ${detail}`);
  err.statusCode = lastError.status || 502;
  throw err;
}

module.exports = { chatCompletion, DEFAULT_MODEL };
