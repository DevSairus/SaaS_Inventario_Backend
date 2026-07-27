// Configuración de SLA para tickets de soporte
// Tiempos en horas para primera respuesta y resolución

const SLA_CONFIG = {
  // Tiempos máximos de PRIMERA RESPUESTA (horas)
  first_response: {
    urgent: 1,
    high: 4,
    medium: 8,
    low: 24,
  },
  // Tiempos máximos de RESOLUCIÓN (horas)
  resolution: {
    urgent: 4,
    high: 24,
    medium: 48,
    low: 72,
  },
  // Umbrales de alerta (porcentaje del tiempo transcurrido)
  warning_threshold: 0.75,  // 75% del tiempo = en riesgo
  breach_threshold: 1.0,    // 100% = vencido
};

/**
 * Calcula la fecha límite de SLA para un ticket dado.
 * Devuelve { first_response_due, resolution_due }
 */
function calculateSlaDue(priority, createdAt = new Date()) {
  const created = new Date(createdAt);
  const frHours = SLA_CONFIG.first_response[priority] || SLA_CONFIG.first_response.medium;
  const resHours = SLA_CONFIG.resolution[priority] || SLA_CONFIG.resolution.medium;

  const first_response_due = new Date(created.getTime() + frHours * 60 * 60 * 1000);
  const resolution_due = new Date(created.getTime() + resHours * 60 * 60 * 1000);

  return { first_response_due, resolution_due };
}

/**
 * Devuelve el estado del SLA comparando la fecha límite con ahora.
 * @param {Date|null} slaDueAt - fecha límite
 * @param {Date|null} completedAt - fecha de resolución/respuesta (si ya ocurrió)
 * @returns {'on_track'|'at_risk'|'breached'|'met'}
 */
function getSlaStatus(slaDueAt, completedAt = null) {
  if (!slaDueAt) return 'on_track';
  if (completedAt) {
    return new Date(completedAt) <= new Date(slaDueAt) ? 'met' : 'breached';
  }
  const now = new Date();
  const due = new Date(slaDueAt);
  const total = due.getTime() - new Date(due.getTime() - (due.getTime() - now.getTime())).getTime();
  const elapsed = now.getTime() - (due.getTime() - total);

  if (now >= due) return 'breached';
  const remaining = due.getTime() - now.getTime();
  const totalWindow = due.getTime() - (due.getTime() - remaining - elapsed);
  const pct = elapsed / (elapsed + remaining);

  if (pct >= SLA_CONFIG.warning_threshold) return 'at_risk';
  return 'on_track';
}

/**
 * Devuelve las horas restantes hasta el vencimiento del SLA.
 */
function getSlaRemainingHours(slaDueAt) {
  if (!slaDueAt) return null;
  const remaining = new Date(slaDueAt).getTime() - Date.now();
  return Math.round(remaining / (1000 * 60 * 60) * 10) / 10;
}

module.exports = { SLA_CONFIG, calculateSlaDue, getSlaStatus, getSlaRemainingHours };
