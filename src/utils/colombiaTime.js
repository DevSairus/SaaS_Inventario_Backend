// backend/src/utils/colombiaTime.js
/**
 * Fechas y horas en hora Colombia (UTC−5, sin horario de verano), sin
 * depender de la zona horaria del servidor. En Railway el proceso corre en
 * UTC: `new Date('2026-11-13T08:00:00')` allá es 08:00 UTC (3:00 a. m. en
 * Colombia), y getHours()/getDate() devuelven la hora/día UTC. Todo lo que
 * represente una hora "de reloj" colombiana (franjas de citas, plazos
 * RADIAN) debe pasar por aquí.
 */
'use strict';

const CO_TIMEZONE = 'America/Bogota';
const CO_OFFSET = '-05:00';
const CO_OFFSET_MS = 5 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

/** Instante de una fecha (YYYY-MM-DD) y hora (HH:MM o HH:MM:SS) colombianas. */
function coDateTime(dateStr, time = '00:00:00') {
  const t = time.length === 5 ? `${time}:00` : time;
  return new Date(`${dateStr}T${t}${CO_OFFSET}`);
}

// Date "corrido" a hora Colombia: sus getUTC* dan los valores de reloj colombianos.
function shifted(date) {
  return new Date(new Date(date).getTime() - CO_OFFSET_MS);
}

/** YYYY-MM-DD del instante, en Colombia. */
function coDateStr(date) {
  const d = shifted(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** HH:MM del instante, en Colombia. */
function coTimeStr(date) {
  const d = shifted(date);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Día de la semana (0=domingo) de una fecha YYYY-MM-DD. */
function coWeekday(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** Inicio y fin (inclusive) de un día colombiano, como instantes. */
function coDayRange(dateStr) {
  return { start: coDateTime(dateStr, '00:00:00'), end: new Date(coDateTime(dateStr, '23:59:59').getTime() + 999) };
}

/** toLocaleString('es-CO') siempre en hora Colombia. */
function formatCo(date, options = { dateStyle: 'long', timeStyle: 'short' }) {
  return new Date(date).toLocaleString('es-CO', { ...options, timeZone: CO_TIMEZONE });
}

module.exports = { CO_TIMEZONE, CO_OFFSET, coDateTime, coDateStr, coTimeStr, coWeekday, coDayRange, formatCo };
