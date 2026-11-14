// backend/src/services/projects/workHours.js
//
// Clasificación de las horas de la planilla de obra (Fase 4, req. 1.1).
//
// Reglas (Colombia):
//   - Nocturno: desde las 7:00 p. m. (Ley 2466 de 2025, desde el 25-dic-2025;
//     antes 9:00 p. m.) hasta las 6:00 a. m.
//   - Dominical o festivo: según el día calendario de cada minuto trabajado
//     (un turno que pasa la medianoche del sábado al domingo tiene minutos de
//     domingo). Festivos con la Ley Emiliani (services/radian/businessDays.js).
//   - Hora extra: lo que pase de las horas ordinarias del día, sumando todos
//     los proyectos del empleado ese día (el día es el de la entrada).
//     Horas ordinarias por día = payroll_settings.daily_hours, o la jornada
//     semanal / 6 (Ley 2101).
//   - El descanso (almuerzo) se descuenta a mitad del turno.
//   - Registros sin entrada ni salida (solo horas): cuentan como diurnos.
//
// Categorías (las de la nómina electrónica DIAN):
//   ORD  ordinaria diurna (ya pagada con el salario)
//   HRNs recargo nocturno            HRDDFs recargo diurno dominical/festivo
//   HRNDFs recargo nocturno dom/fest HEDs extra diurna   HENs extra nocturna
//   HEDDFs extra diurna dom/fest     HENDFs extra nocturna dom/fest

const { isHoliday } = require('../radian/businessDays');
const { weeklyHoursFor } = require('../payroll/jornada');

const CATEGORIES = ['ORD', 'HRNs', 'HRDDFs', 'HRNDFs', 'HEDs', 'HENs', 'HEDDFs', 'HENDFs'];
const PAYABLE = CATEGORIES.filter((c) => c !== 'ORD');
const LABELS = {
  ORD: 'Ordinarias', HRNs: 'Recargo nocturno', HRDDFs: 'Recargo dominical/festivo', HRNDFs: 'Recargo nocturno dominical/festivo',
  HEDs: 'Extra diurna', HENs: 'Extra nocturna', HEDDFs: 'Extra diurna dominical/festiva', HENDFs: 'Extra nocturna dominical/festiva',
};
const NIGHT_19_FROM = '2025-12-25';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');

/** "HH:MM" o "HH:MM:SS" → minutos desde la medianoche, o null. */
function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
const fromMinutes = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const nightStartMinutes = (iso) => (iso >= NIGHT_19_FROM ? 19 * 60 : 21 * 60);
const isNightMinute = (iso, minuteOfDay) => minuteOfDay >= nightStartMinutes(iso) || minuteOfDay < 6 * 60;

const specialCache = new Map();
function isSpecialDay(iso) {
  if (!specialCache.has(iso)) {
    const d = new Date(`${iso}T00:00:00Z`);
    specialCache.set(iso, d.getUTCDay() === 0 || isHoliday(d));
  }
  return specialCache.get(iso);
}

function category(ordinary, night, special) {
  if (ordinary) {
    if (special) return night ? 'HRNDFs' : 'HRDDFs';
    return night ? 'HRNs' : 'ORD';
  }
  if (special) return night ? 'HENDFs' : 'HEDDFs';
  return night ? 'HENs' : 'HEDs';
}

/** Horas ordinarias por día: la de la empresa, o la jornada semanal / 6. */
function dailyHoursFor(date, settings = {}) {
  const d = Number(settings?.daily_hours);
  if (d > 0) return d;
  return weeklyHoursFor(date, settings?.weekly_hours) / 6;
}

/**
 * Duración de un registro en minutos trabajados y sus minutos en orden
 * cronológico [{ date, minuteOfDay }], ya sin el descanso.
 */
function entryMinutes(entry) {
  const start = toMinutes(entry.start_time);
  const end = toMinutes(entry.end_time);
  const date = String(entry.work_date).slice(0, 10);
  if (start === null || end === null) {
    // Solo horas: diurnas, desde las 6:00 a. m. del día.
    const total = Math.round(Number(entry.hours || 0) * 60);
    return Array.from({ length: Math.max(total, 0) }, (_, i) => ({ date, minuteOfDay: Math.min(6 * 60 + i, 18 * 60 + 59), untimed: true }));
  }
  const span = end > start ? end - start : end + 1440 - start; // pasa la medianoche
  const brk = Math.min(Math.max(Number(entry.break_minutes) || 0, 0), span);
  const breakFrom = Math.floor((span - brk) / 2);
  const out = [];
  for (let i = 0; i < span; i += 1) {
    if (i >= breakFrom && i < breakFrom + brk) continue;
    const abs = start + i;
    out.push({ date: abs >= 1440 ? addDays(date, 1) : date, minuteOfDay: abs % 1440 });
  }
  return out;
}

/** Horas trabajadas de un registro con entrada/salida (para guardar en `hours`). */
function workedHours(entry) {
  return round2(entryMinutes(entry).length / 60);
}

/**
 * Clasifica los registros de UN empleado.
 * entries: [{ id, project_id, work_date, start_time?, end_time?, break_minutes?, hours }]
 * Devuelve { byEntry: Map(id → {cat: horas}), totals: {cat: horas}, days: [{ date, hours, ordinary_limit, extra }] }.
 */
function classifyEmployeeEntries(entries, settings = {}) {
  const byDate = new Map();
  for (const e of entries) {
    const d = String(e.work_date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(e);
  }
  const byEntry = new Map();
  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const days = [];
  for (const [date, list] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Primero los de solo horas, luego por hora de entrada.
    list.sort((a, b) => (toMinutes(a.start_time) ?? -1) - (toMinutes(b.start_time) ?? -1));
    const limit = Math.round(dailyHoursFor(date, settings) * 60);
    let used = 0;
    let extra = 0;
    for (const e of list) {
      const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
      for (const m of entryMinutes(e)) {
        const ordinary = used < limit;
        used += 1;
        if (!ordinary) extra += 1;
        const night = m.untimed ? false : isNightMinute(m.date, m.minuteOfDay);
        counts[category(ordinary, night, isSpecialDay(m.date))] += 1;
      }
      const hours = Object.fromEntries(CATEGORIES.map((c) => [c, round2(counts[c] / 60)]));
      byEntry.set(e.id, hours);
      for (const c of CATEGORIES) totals[c] += counts[c];
    }
    days.push({ date, hours: round2(used / 60), ordinary_limit: round2(limit / 60), extra: round2(extra / 60), special: isSpecialDay(date) });
  }
  return { byEntry, totals: Object.fromEntries(CATEGORIES.map((c) => [c, round2(totals[c] / 60)])), days };
}

module.exports = {
  CATEGORIES, PAYABLE, LABELS,
  toMinutes, fromMinutes, dailyHoursFor, entryMinutes, workedHours, classifyEmployeeEntries, isSpecialDay, nightStartMinutes,
};
