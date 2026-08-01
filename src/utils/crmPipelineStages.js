// backend/src/utils/crmPipelineStages.js
//
// CRM Fase B.4 — helpers compartidos para resolver CrmPipelineStage por
// tenant. Antes 'ganado'/'perdido'/'nuevo' eran strings hardcodeados en
// varios controllers/servicios; ahora cada tenant define sus propias etapas
// y estos helpers traducen esa configuración a las tres cosas que el resto
// del CRM necesita: mapa por key, keys agrupadas por stage_type, y la etapa
// de entrada para oportunidades nuevas.
const { CrmPipelineStage } = require('../models');

async function loadStageMap(tenant_id) {
  const stages = await CrmPipelineStage.findAll({ where: { tenant_id } });
  return Object.fromEntries(stages.map(s => [s.key, s]));
}

function keysByType(stageMap, stage_type) {
  return Object.values(stageMap).filter(s => s.stage_type === stage_type).map(s => s.key);
}

// Etapa de entrada para oportunidades nuevas: la etapa abierta con menor
// sort_order (equivalente al antiguo 'nuevo' hardcodeado).
function resolveEntryStageKey(stageMap) {
  const openStages = Object.values(stageMap).filter(s => s.stage_type === 'open');
  if (!openStages.length) return 'nuevo';
  return openStages.reduce((a, b) => (a.sort_order <= b.sort_order ? a : b)).key;
}

module.exports = { loadStageMap, keysByType, resolveEntryStageKey };
