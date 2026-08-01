// backend/src/utils/crmLeadScore.js
//
// CRM Fase B.2 — "Prioridad automática de leads" (ver propuesta-mejora-crm-pitbox.md).
// Antes el Kanban solo se ordenaba por stage_changed_at: un lead de Meta Ads
// sin contactar en 2 horas pesaba visualmente igual que uno de mostrador
// recién atendido. Este score combina tiempo sin movimiento + origen + valor
// estimado en un solo número (0-100) para que el asesor sepa, de un vistazo,
// a quién atender primero — sin tocar ningún modelo ni migración nueva.
//
// Nada de esto reemplaza el criterio del asesor: es una señal, no una regla.

// Origen del lead — leads pagados (Meta Ads) o que llegaron "fríos" (web,
// redes) se enfrían más rápido si no se atienden rápido; un walk_in ya tiene
// al cliente en el mostrador, así que pesa menos en urgencia de "contacto".
const SOURCE_WEIGHT = {
  meta_ads: 30,
  web: 22,
  redes: 20,
  referido: 18,
  whatsapp: 15,
  llamada: 12,
  recompra_recurrente: 10,
  walk_in: 8,
};

// Valor estimado — bandas simples en COP en vez de escala continua, para que
// el número sea fácil de explicar ("por qué esta oportunidad pesa más").
function valueScore(expectedValue) {
  const v = parseFloat(expectedValue || 0);
  if (v >= 5_000_000) return 30;
  if (v >= 2_000_000) return 20;
  if (v >= 500_000) return 10;
  return 5;
}

// Tiempo sin movimiento en la etapa actual — capado a 96h (4 días) para que
// una oportunidad muy vieja no se coma todo el score y opaque a las demás.
function timeScore(stageChangedAt) {
  const hours = (Date.now() - new Date(stageChangedAt).getTime()) / 3_600_000;
  return Math.min(Math.max(hours, 0), 96) / 96 * 40;
}

/**
 * Calcula el score de prioridad de una oportunidad abierta.
 * @param {object} opportunity
 * @param {object} [stageMeta] - fila de CrmPipelineStage (Fase B.4) que
 *   corresponde a `opportunity.stage` en el tenant. Sin ella se asume que
 *   la etapa está abierta y no es la primera (comportamiento conservador).
 * @returns {number|null} 0-100, o null si la oportunidad ya está cerrada
 *   (ganado/perdido no compiten por atención).
 */
function computeLeadPriority(opportunity, stageMeta) {
  if (stageMeta && stageMeta.stage_type !== 'open') return null;

  let score = timeScore(opportunity.stage_changed_at)
    + (SOURCE_WEIGHT[opportunity.source] ?? 8)
    + valueScore(opportunity.expected_value);

  // Un lead recién llegado (primera etapa del embudo) sin contactar hace
  // rato es lo más urgente del tablero: todavía no hay ninguna relación con
  // el cliente, cada hora que pasa baja la probabilidad real de conversión
  // más que en cualquier otra etapa.
  const hoursSinceChange = (Date.now() - new Date(opportunity.stage_changed_at).getTime()) / 3_600_000;
  const isFirstStage = stageMeta ? stageMeta.sort_order === 0 : opportunity.stage === 'nuevo';
  if (isFirstStage && hoursSinceChange >= 2) score += 15;

  return Math.round(Math.min(score, 100));
}

module.exports = { computeLeadPriority };
