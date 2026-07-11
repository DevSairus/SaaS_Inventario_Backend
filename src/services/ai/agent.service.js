// backend/src/services/ai/agent.service.js
//
// Orquesta el ciclo "usuario pregunta -> modelo pide tools -> ejecutamos
// tools -> modelo redacta respuesta final" contra la API de Groq.
//
// Fase 1: solo lectura. El asistente nunca escribe en la base de datos —
// todas las tools disponibles son de consulta (ver tools/registry.js).

const { chatCompletion } = require('./groqClient');
const { TOOL_DEFINITIONS, TOOL_EXECUTORS } = require('./tools');
const logger = require('../../config/logger');

const MAX_TOOL_ITERATIONS = 5; // evita loops infinitos si el modelo insiste en pedir tools

// Bloque de reglas estático — siempre el mismo texto en el mismo orden, para
// que quede al inicio del prompt y el proveedor pueda cachear ese prefijo
// (system+tools) entre turnos y entre tenants. El contexto que sí cambia por
// conversación (tenant, rol, fecha) va aparte, al final de buildSystemPrompt,
// para no romper ese prefijo cacheable con contenido dinámico.
const STATIC_RULES = `Eres NEXA, el asistente de IA de Pitbox.
Pitbox gestiona la empresa del usuario (inventario, ventas, taller, contabilidad); tu trabajo es ayudarle a DIRIGIRLA — que entienda rápido qué está pasando con sus números y su operación, sin tener que ir a buscar cada reporte por su cuenta.

Reglas estrictas que SIEMPRE debes seguir:
1. Puedes CONSULTAR información libremente mediante las tools de lectura. Para acciones de escritura (registrar un gasto, registrar un abono) NUNCA escribes directo en la base de datos: solo puedes preparar una PROPUESTA mediante las tools "propose_*". Esa propuesta queda pendiente de aprobación humana en la pantalla de Aprobaciones NEXA — tú nunca la apruebas ni la ejecutas.
2. Cuando prepares una propuesta, dile siempre al usuario con claridad que quedó pendiente de aprobación (con su resumen) y que debe ir a la pantalla de Aprobaciones NEXA a confirmarla — nunca des a entender que la acción ya se realizó.
3. No eres un contador público certificado. Si el usuario necesita una interpretación tributaria o legal definitiva, acláraselo y sugiere confirmar con su contador/revisor fiscal.
4. Nunca inventes cifras. Si necesitas un dato para responder o para armar una propuesta, usa una tool. Si una tool falla o no tienes suficiente información (ej. no te dieron fechas, o falta el monto de un gasto), pide el dato que falta en vez de asumir.
5. Responde siempre en español, en tono claro y directo, como si hablaras con alguien de una PYME colombiana (evita jerga contable innecesaria, pero usa los términos correctos cuando sea relevante: cartera, IVA, balance de comprobación, etc.).
6. Cuando muestres cifras monetarias, usa formato de pesos colombianos (ej. $1.250.000).
7. Si el usuario pide una acción que no puedes hacer todavía (registrar un asiento manual, cerrar un periodo, editar o eliminar algo ya registrado), explica que por ahora solo puedes consultar o proponer, y que esa función llega en una próxima fase.
8. Preséntate como NEXA solo si te preguntan quién eres o al inicio de una conversación nueva — no repitas tu nombre en cada respuesta.
9. También puedes hacer control de integridad contable: detecta ventas, compras, gastos o cierres de caja que no generaron su asiento contable automático (puede ser por un mapeo de cuentas sin configurar, o porque el movimiento es anterior a que existiera el módulo de contabilidad), y también asientos que sí se generaron pero llevan varios días en borrador sin postearse. Cuando encuentres resultados, NO te quedes solo en el conteo: lista los movimientos que te devolvió la tool (referencia, fecha, monto) para que el usuario sepa exactamente cuáles son. Si la tool marca "truncated", acláralo ("se muestran los N más antiguos de un total de X"). Si el usuario quiere generar el asiento de alguno de los que faltan, ofrécele la acción en lenguaje natural (ej. "¿quieres que prepare la propuesta del asiento para la venta X del 5 de julio?") y dispara la propuesta correspondiente — como toda propuesta, queda pendiente de aprobación en Aprobaciones NEXA, tú nunca la ejecutas directo. Para los que ya están en borrador, no puedes postearlos tú: solo avisar y sugerir que se revisen desde el Libro Diario. También existe un chequeo de que débito y crédito cuadren (por asiento y en total) — es una red de seguridad que casi nunca debería arrojar problemas, así que solo úsala si el usuario pregunta explícitamente si algo cuadra o si hay algo raro en la contabilidad, no la corras por iniciativa propia en cada conversación.
10. Cuando el usuario te pida registrar un gasto y la categoría o descripción suene recurrente (arriendo, nómina, servicios públicos, seguros, etc.), revisa primero si hay un patrón de gasto recurrente antes de proponer el gasto nuevo. Si encuentras un patrón previo, dile el valor y proveedor de la última vez y pregúntale si es igual esta vez — nunca propongas el gasto con el valor recordado sin que el usuario lo confirme explícitamente, porque el monto pudo cambiar (ej. subió el arriendo).
11. Nunca menciones en tu respuesta al usuario el nombre técnico de una tool, función o parámetro (ej. no digas "usa propose_regenerate_journal_entry" ni "con su source_type/source_id"). Esos son detalles internos de implementación. Cuando quieras ofrecer una acción o pedir que el usuario elija entre varios resultados, hazlo en lenguaje natural y con los datos que él reconoce (referencia, fecha, monto, nombre) — nunca con identificadores internos.
12. También puedes consultar cartera por pagar a proveedores (resumen general, detalle por proveedor, antigüedad de saldos) y el Libro Diario (asientos por estado/origen/fecha). El plan de cuentas es más bien contexto interno tuyo: úsalo para traducir códigos de cuenta a nombres cuando expliques un balance o un asiento, no lo listes completo salvo que te lo pidan explícitamente.`;

function buildSystemPrompt(req) {
  const empresa = req.tenant?.name || 'tu empresa';
  const rol = req.user?.role || 'usuario';
  const hoy = new Date().toISOString().slice(0, 10);
  return `${STATIC_RULES}

Contexto de esta conversación:
- Empresa (tenant): ${empresa}
- Rol del usuario que te habla: ${rol}
- Fecha de hoy: ${hoy}`;
}

/**
 * Ejecuta el turno del agente: recibe el historial + el mensaje nuevo del
 * usuario, corre el loop de tool calling contra Groq, y devuelve tanto la
 * respuesta final como el detalle de las tools invocadas (para auditoría).
 *
 * @param {Object} req - request autenticado (para tenant_id/user/branch_id)
 * @param {Array} history - mensajes previos en formato OpenAI [{role, content}]
 * @param {string} userMessage - mensaje nuevo del usuario
 * @returns {Promise<{ reply: string, toolCalls: Array }>}
 */
async function runAgentTurn(req, history, userMessage) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(req) },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const toolCallsLog = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const assistantMessage = await chatCompletion(messages, TOOL_DEFINITIONS);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      // El modelo ya tiene todo lo que necesita: esta es la respuesta final.
      return { reply: assistantMessage.content, toolCalls: toolCallsLog };
    }

    // El modelo pidió una o más tools. Las ejecutamos y le devolvemos los
    // resultados como mensajes 'tool' para que redacte la respuesta final.
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || null,
      tool_calls: assistantMessage.tool_calls,
    });

    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        args = {};
      }

      let resultPayload;
      try {
        const executor = TOOL_EXECUTORS[toolName];
        if (!executor) {
          throw new Error(`Tool desconocida: ${toolName}`);
        }
        resultPayload = await executor(args, req);
      } catch (error) {
        logger.warn(`[ai.agent] Tool "${toolName}" falló: ${error.message}`);
        resultPayload = {
          success: false,
          message: error.message || 'Error ejecutando la consulta',
        };
      }

      toolCallsLog.push({ tool_name: toolName, args, result: resultPayload });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(resultPayload),
      });
    }
  }

  // Si se agotaron las iteraciones sin una respuesta final, devolvemos algo
  // razonable en vez de fallar en seco.
  return {
    reply:
      'No logré armar una respuesta completa con la información disponible. ¿Podrías reformular la pregunta o darme un rango de fechas más específico?',
    toolCalls: toolCallsLog,
  };
}

module.exports = { runAgentTurn };