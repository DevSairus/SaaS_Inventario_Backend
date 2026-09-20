// backend/src/utils/crmGoalAlerts.js
//
// CRM — Gamificación, Fase 6 (alertas de vencimiento). No hay una tabla de
// alertas persistida a propósito — mismo criterio que
// components/common/CrmNotifications.jsx: es un conteo/lista EN VIVO sobre
// datos que el motor de gamificación ya calcula (CrmGoalProgress), no un
// estado propio que pueda desincronizarse.
//
// Qué es "próximo a vencer": no un número fijo de días para todo tipo de
// meta — 2 días son urgentes para una meta semanal pero irrelevantes para
// una campaña de 3 meses. El umbral es relativo a la duración del período.
const URGENCY_RATIO = 0.25; // últimos 25% del período = "por vencer"
const CRITICAL_RATIO = 0.10; // últimos 10% del período = "urgente"
const MIN_URGENCY_DAYS = 1;

function daysBetween(a, b) {
  const MS_DAY = 24 * 60 * 60 * 1000;
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / MS_DAY);
}

// Cuántos días le quedan al período visto desde `now`, y qué fracción del
// período total ya transcurrió.
function periodTiming(period, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const totalDays = Math.max(1, daysBetween(period.period_start, period.period_end) + 1);
  const daysRemaining = Math.max(0, daysBetween(today, period.period_end));
  const elapsedRatio = 1 - (daysRemaining / totalDays);
  return { totalDays, daysRemaining, elapsedRatio };
}

// Nivel de urgencia del período en sí, independiente del avance. `null`
// significa "todavía no aplica alertar por tiempo".
function periodUrgency(period, now = new Date()) {
  const { totalDays, daysRemaining, elapsedRatio } = periodTiming(period, now);
  const urgentDays = Math.max(MIN_URGENCY_DAYS, Math.round(totalDays * URGENCY_RATIO));
  const criticalDays = Math.max(MIN_URGENCY_DAYS, Math.round(totalDays * CRITICAL_RATIO));

  if (elapsedRatio >= (1 - CRITICAL_RATIO) || daysRemaining <= criticalDays) {
    return { level: 'critica', daysRemaining };
  }
  if (elapsedRatio >= (1 - URGENCY_RATIO) || daysRemaining <= urgentDays) {
    return { level: 'alta', daysRemaining };
  }
  return { level: null, daysRemaining };
}

// Construye la alerta de una meta+target ya con el progreso resuelto. Nunca
// alerta una meta ya cumplida (percent >= 100) ni una métrica point_in_time
// por tiempo restante — esas se miden "ahora mismo", no tiene sentido
// decirle a alguien "te quedan 3 días" para algo que no acumula (§3.4/§13.2).
// Devuelve null si no corresponde alertar.
function buildGoalAlert({ goal, metricDef, period, entry, now = new Date() }) {
  if (!entry) return null;
  const percent = entry.percent;
  if (percent >= 100) return null; // ya cumplida — nada que avisar

  const { level, daysRemaining } = periodUrgency(period, now);
  if (!level) return null; // todavía hay tiempo de sobra

  const remaining_value = metricDef.inverted
    ? null // "menos es mejor": no hay un "cuánto falta", solo el % ya lo dice
    : Math.max(0, parseFloat(goal.target_value) - entry.current_value);

  return {
    goal_id: goal.id,
    name: goal.name,
    goal_type: goal.goal_type,
    metric: goal.metric,
    scope: goal.scope,
    period_type: goal.period_type,
    period_end: period.period_end,
    days_remaining: daysRemaining,
    percent: entry.percent,
    current_value: entry.current_value,
    target_value: parseFloat(goal.target_value),
    remaining_value,
    urgency: level, // 'alta' | 'critica'
  };
}

module.exports = { periodTiming, periodUrgency, buildGoalAlert, URGENCY_RATIO, CRITICAL_RATIO };