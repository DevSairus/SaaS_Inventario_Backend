// Fechas y horas "de pared" en la zona del tenant (business_config.timezone).
// El servidor corre en UTC: nunca armar instantes con new Date('YYYY-MM-DDTHH:mm')
// ni leer getHours()/getDate(), porque eso usa la zona del proceso.

const DEFAULT_TIMEZONE = 'America/Bogota';

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Zona del tenant, o la de Colombia si no tiene o está mal configurada. */
function tenantTimeZone(tenant) {
  const tz = tenant?.business_config?.timezone;
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

function zonedParts(date, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
}

/**
 * 'YYYY-MM-DD' + 'HH:mm' en `timeZone` -> instante (Date). Usa el desfase real
 * de la zona en esa fecha (Intl), no un UTC-5 fijo.
 */
function wallTimeToInstant(dateStr, hhmm, timeZone = DEFAULT_TIMEZONE) {
  const guess = new Date(`${dateStr}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}Z`);
  const p = zonedParts(guess, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

/** 'YYYY-MM-DD' del instante en `timeZone`. */
function localDateStr(date, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(new Date(date), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'HH:mm' del instante en `timeZone`. */
function localTimeStr(date, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(new Date(date), timeZone);
  return `${p.hour}:${p.minute}`;
}

/** Día de la semana (0 = domingo) de una fecha 'YYYY-MM-DD', sin depender de la zona del proceso. */
function weekdayOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

/** Inicio y fin (instantes) del día 'YYYY-MM-DD' en `timeZone`. */
function localDayRange(dateStr, timeZone = DEFAULT_TIMEZONE) {
  const start = wallTimeToInstant(dateStr, '00:00', timeZone);
  const next = new Date(`${dateStr}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = wallTimeToInstant(next.toISOString().slice(0, 10), '00:00', timeZone);
  return [start, new Date(end.getTime() - 1)];
}

/** Fecha y hora larga en español, en `timeZone`. */
function formatDateTimeEs(date, timeZone = DEFAULT_TIMEZONE) {
  return new Date(date).toLocaleString('es-CO', { timeZone, dateStyle: 'long', timeStyle: 'short' });
}

module.exports = {
  DEFAULT_TIMEZONE,
  tenantTimeZone,
  wallTimeToInstant,
  localDateStr,
  localTimeStr,
  weekdayOf,
  localDayRange,
  formatDateTimeEs,
};
