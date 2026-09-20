// backend/src/services/radian/businessDays.js
/**
 * Días hábiles colombianos (Ley 51 de 1983, "Ley Emiliani") — necesario para
 * el plazo de 3 días hábiles entre 032 y 031/033 (ver
 * 00 - Documentación/RADIAN-Analisis-y-Plan.md §2 y §7.3).
 *
 * Festivos fijos + festivos "Emiliani" (se trasladan al lunes siguiente si
 * no caen en lunes) + festivos móviles calculados desde el Domingo de
 * Resurrección (algoritmo de Meeus/Jones/Butcher, calendario gregoriano).
 * Sin dependencia externa — mismo criterio del resto del proyecto de no
 * agregar librerías para algo que se puede calcular con certeza matemática.
 */
'use strict';

function easterSunday(year) {
  // Meeus/Jones/Butcher
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=marzo, 4=abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysUTC(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Traslada al lunes siguiente si la fecha no cae en lunes (Ley Emiliani).
function toNextMonday(date) {
  const dow = date.getUTCDay(); // 0=domingo, 1=lunes...
  if (dow === 1) return date;
  const daysToMonday = (8 - dow) % 7 || 7;
  return addDaysUTC(date, dow === 0 ? 1 : daysToMonday);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

const _cache = new Map();

/** Set de festivos (YYYY-MM-DD) de un año calendario, en UTC. */
function holidaysForYear(year) {
  if (_cache.has(year)) return _cache.get(year);

  const fixed = [
    new Date(Date.UTC(year, 0, 1)),   // Año Nuevo
    new Date(Date.UTC(year, 4, 1)),   // Día del Trabajo
    new Date(Date.UTC(year, 6, 20)),  // Independencia
    new Date(Date.UTC(year, 7, 7)),   // Batalla de Boyacá
    new Date(Date.UTC(year, 11, 8)),  // Inmaculada Concepción
    new Date(Date.UTC(year, 11, 25)), // Navidad
  ];

  const emiliani = [
    new Date(Date.UTC(year, 0, 6)),   // Reyes Magos
    new Date(Date.UTC(year, 2, 19)),  // San José
    new Date(Date.UTC(year, 5, 29)),  // San Pedro y San Pablo
    new Date(Date.UTC(year, 7, 15)),  // Asunción de la Virgen
    new Date(Date.UTC(year, 9, 12)),  // Día de la Raza
    new Date(Date.UTC(year, 10, 1)),  // Todos los Santos
    new Date(Date.UTC(year, 10, 11)), // Independencia de Cartagena
  ].map(toNextMonday);

  const easter = easterSunday(year);
  const movable = [
    addDaysUTC(easter, -3), // Jueves Santo
    addDaysUTC(easter, -2), // Viernes Santo
    addDaysUTC(easter, 43), // Ascensión del Señor (Emiliani, jueves+4)
    addDaysUTC(easter, 64), // Corpus Christi (Emiliani)
    addDaysUTC(easter, 71), // Sagrado Corazón (Emiliani)
  ];

  const set = new Set([...fixed, ...emiliani, ...movable].map(dateKey));
  _cache.set(year, set);
  return set;
}

function isHoliday(date) {
  return holidaysForYear(date.getUTCFullYear()).has(dateKey(date));
}

function isBusinessDay(date) {
  const dow = date.getUTCDay();
  return dow !== 0 && dow !== 6 && !isHoliday(date);
}

/**
 * Suma N días hábiles a partir de `fromDate` (sin contar `fromDate` mismo).
 * Devuelve un Date a las 23:59:59 UTC de ese día hábil — se usa como
 * vencimiento de plazo (radian_deadline_at), y el criterio de "vencido" es
 * "ya pasó ese día completo".
 */
function addBusinessDays(fromDate, n) {
  let d = new Date(fromDate);
  let remaining = n;
  while (remaining > 0) {
    d = addDaysUTC(d, 1);
    if (isBusinessDay(d)) remaining--;
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
}

/** true si `checkDate` está dentro del plazo (aún no vence). */
function isWithinBusinessDeadline(checkDate, deadlineDate) {
  return new Date(checkDate).getTime() <= new Date(deadlineDate).getTime();
}

module.exports = { addBusinessDays, isBusinessDay, isHoliday, isWithinBusinessDeadline, easterSunday };
