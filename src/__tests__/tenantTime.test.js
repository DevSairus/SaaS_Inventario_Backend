const {
  tenantTimeZone, wallTimeToInstant, localDateStr, localTimeStr, weekdayOf, localDayRange,
} = require('../utils/tenantTime');

describe('tenantTime', () => {
  test('zona del tenant, o Colombia si falta o es inválida', () => {
    expect(tenantTimeZone({ business_config: { timezone: 'America/Mexico_City' } })).toBe('America/Mexico_City');
    expect(tenantTimeZone({ business_config: {} })).toBe('America/Bogota');
    expect(tenantTimeZone({ business_config: { timezone: 'Marte/Olympus' } })).toBe('America/Bogota');
  });

  test('hora de pared de Colombia -> instante UTC y de vuelta', () => {
    const dt = wallTimeToInstant('2026-11-10', '08:00', 'America/Bogota');
    expect(dt.toISOString()).toBe('2026-11-10T13:00:00.000Z');
    expect(localDateStr(dt, 'America/Bogota')).toBe('2026-11-10');
    expect(localTimeStr(dt, 'America/Bogota')).toBe('08:00');
  });

  test('una cita a las 8 p. m. de Colombia sigue siendo de ese día aunque en UTC ya sea el siguiente', () => {
    const dt = wallTimeToInstant('2026-11-10', '20:00', 'America/Bogota');
    expect(dt.toISOString()).toBe('2026-11-11T01:00:00.000Z');
    expect(localDateStr(dt, 'America/Bogota')).toBe('2026-11-10');
  });

  test('respeta el horario de verano de otras zonas', () => {
    expect(wallTimeToInstant('2026-07-01', '08:00', 'America/New_York').toISOString()).toBe('2026-07-01T12:00:00.000Z');
    expect(wallTimeToInstant('2026-12-01', '08:00', 'America/New_York').toISOString()).toBe('2026-12-01T13:00:00.000Z');
  });

  test('día de la semana y rango del día local', () => {
    expect(weekdayOf('2026-11-10')).toBe(2); // martes
    const [start, end] = localDayRange('2026-11-10', 'America/Bogota');
    expect(start.toISOString()).toBe('2026-11-10T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-11T04:59:59.999Z');
  });
});
