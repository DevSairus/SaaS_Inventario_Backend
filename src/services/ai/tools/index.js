// backend/src/services/ai/tools/index.js
//
// Punto único de entrada para el agente: junta las tools de solo lectura
// (Fase 1, registry.js), las de escritura/propuestas (Fase 2, writeTools.js),
// las de control/integridad contable (Fase 3, controlTools.js), las de
// memoria de patrones (Fase 3, memoryTools.js) y las de cartera por
// pagar/contexto contable (Fase 3 §2, payablesTools.js) para que
// agent.service.js no tenga que conocer la diferencia.

const readTools = require('./registry');
const writeTools = require('./writeTools');
const controlTools = require('./controlTools');
const memoryTools = require('./memoryTools');
const payablesTools = require('./payablesTools');

const TOOL_DEFINITIONS = [
  ...readTools.TOOL_DEFINITIONS,
  ...writeTools.TOOL_DEFINITIONS,
  ...controlTools.TOOL_DEFINITIONS,
  ...memoryTools.TOOL_DEFINITIONS,
  ...payablesTools.TOOL_DEFINITIONS,
];
const TOOL_EXECUTORS = {
  ...readTools.TOOL_EXECUTORS,
  ...writeTools.TOOL_EXECUTORS,
  ...controlTools.TOOL_EXECUTORS,
  ...memoryTools.TOOL_EXECUTORS,
  ...payablesTools.TOOL_EXECUTORS,
};

module.exports = { TOOL_DEFINITIONS, TOOL_EXECUTORS };