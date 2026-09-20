// backend/src/utils/crmGoalPeriods.js
//
// CRM — Gamificación, Fase 1. Ver gamificacion-crm-diseno.md §3.3.
// weekly/monthly: no se crea una fila de período nueva manualmente — el
// rango vigente se calcula sobre la marcha (igual que el `trend` de
// controllers/crm/dashboard.controller.js). custom: usa starts_at/ends_at
// fijos de la propia CrmGoal.
//
// Fase 4 (§6) — el dashboard de cumplimiento necesita además el período
// ANTERIOR (para el delta de tendencia) y la lista de los últimos N
// períodos (para el histórico de cumplidos/no cumplidos). Se resuelven acá
// con el mismo cálculo de bucket, para no tener dos nociones distintas de
// "período" en el sistema.
function toDateOnly(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Rango de la semana ISO (lunes-domingo) desplazada `offset` semanas
// respecto de `now` (0 = la vigente, -1 = la anterior).
function weekRangeAt(offset = 0, now = new Date()) {
  const day = now.getUTCDay(); // 0=domingo
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday + (offset * 7)
  ));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { period_start: toDateOnly(start), period_end: toDateOnly(end) };
}

// Rango del mes calendario desplazado `offset` meses respecto de `now`.
function monthRangeAt(offset = 0, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
  return { period_start: toDateOnly(start), period_end: toDateOnly(end) };
}

function currentWeekRange(now = new Date()) {
  return weekRangeAt(0, now);
}

function currentMonthRange(now = new Date()) {
  return monthRangeAt(0, now);
}

// Devuelve el período vigente de una meta "ahora", o null si es `custom` y
// la fecha actual cae fuera de starts_at/ends_at (la meta no está activa
// en este momento — no se crea progreso para ella).
function resolveCurrentPeriod(goal, now = new Date()) {
  if (goal.period_type === 'weekly') return currentWeekRange(now);
  if (goal.period_type === 'monthly') return currentMonthRange(now);

  // custom
  if (!goal.starts_at || !goal.ends_at) return null;
  const today = toDateOnly(now);
  if (today < goal.starts_at || today > goal.ends_at) return null;
  return { period_start: goal.starts_at, period_end: goal.ends_at };
}

// Período inmediatamente anterior al vigente. Para `custom` no existe: la
// meta no se recicla sola (§3.3), así que no hay "campaña anterior" con la
// que comparar — devuelve null y el dashboard simplemente no muestra delta.
function resolvePreviousPeriod(goal, now = new Date()) {
  if (goal.period_type === 'weekly') return weekRangeAt(-1, now);
  if (goal.period_type === 'monthly') return monthRangeAt(-1, now);
  return null;
}

// Últimos `count` períodos de la meta, ordenados del más viejo al más
// reciente. El último elemento es el vigente cuando la fecha de hoy cae
// dentro de él (`is_current: true`); en una meta `custom` ya cerrada, el
// último es simplemente el período histórico de esa campaña.
function listRecentPeriods(goal, count = 6, now = new Date()) {
  const today = toDateOnly(now);
  const mark = (p) => ({ ...p, is_current: today >= p.period_start && today <= p.period_end });

  if (goal.period_type === 'weekly' || goal.period_type === 'monthly') {
    const at = goal.period_type === 'weekly' ? weekRangeAt : monthRangeAt;
    const periods = [];
    for (let offset = -(count - 1); offset <= 0; offset += 1) {
      periods.push(mark(at(offset, now)));
    }
    return periods;
  }

  // custom: una sola ventana, la que definió el admin
  if (!goal.starts_at || !goal.ends_at) return [];
  return [mark({ period_start: goal.starts_at, period_end: goal.ends_at })];
}

module.exports = {
  resolveCurrentPeriod,
  resolvePreviousPeriod,
  listRecentPeriods,
  currentWeekRange,
  currentMonthRange,
  weekRangeAt,
  monthRangeAt,
};