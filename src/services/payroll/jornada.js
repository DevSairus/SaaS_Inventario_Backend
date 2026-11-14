// backend/src/services/payroll/jornada.js
//
// Jornada máxima legal semanal (Ley 2101 de 2021, reducción gradual desde
// 48 horas). Se usa para el valor de la hora (horas extra/recargos: salario
// mensual / horas del mes) y para "Número de horas laboradas" de la PILA.
// La empresa puede fijar otra jornada en Configuración de Nómina
// (payroll_settings.weekly_hours). Esa jornada propia es la que se REPORTA en
// la PILA (weeklyHoursFor), pero para el VALOR DE LA HORA (monthlyHoursFor)
// nunca puede superar la máxima legal de la fecha: un divisor mayor de horas
// al mes abarataría ilegalmente la hora extra y los recargos.
// Mismo cálculo en frontend/src/constants/payroll.js.

const LEY_2101 = [
  { from: '2026-07-15', hours: 42 },
  { from: '2025-07-15', hours: 44 },
  { from: '2024-07-15', hours: 46 },
  { from: '2023-07-15', hours: 47 },
];

const toISO = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

// Jornada máxima legal semanal vigente en `date` (por defecto, hoy).
function legalWeeklyHours(date = null) {
  const iso = toISO(date || new Date());
  return (LEY_2101.find((s) => iso >= s.from) || { hours: 48 }).hours;
}

// Jornada semanal de la empresa (la que se reporta en la PILA): la propia si
// está definida; si no, la máxima legal de la fecha.
function weeklyHoursFor(date, override = null) {
  const o = Number(override);
  if (o > 0) return o;
  return legalWeeklyHours(date);
}

// Horas del mes para el valor de la hora = horas semanales x 30 / 6 (mes
// comercial de 30 días, 6 días laborables por semana): 44 h -> 220, 42 h -> 210.
// Si la jornada propia supera la máxima legal de la fecha, se usa la legal.
function monthlyHoursFor(date, override = null) {
  const semanales = Math.min(weeklyHoursFor(date, override), legalWeeklyHours(date));
  return (semanales * 30) / 6;
}

module.exports = { legalWeeklyHours, weeklyHoursFor, monthlyHoursFor };
