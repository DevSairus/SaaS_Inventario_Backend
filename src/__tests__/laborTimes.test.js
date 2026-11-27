// Tempario y productividad (services/workshop/laborTimes.service.js):
// horas disponibles por jornada, festivos y ausencias; precio por hora.
jest.mock('../models', () => ({}));
const { availableHours, hourlyPrice, normalizeSchedule, DEFAULT_SCHEDULE } = require('../services/workshop/laborTimes.service');

test('precio por hora = horas × valor hora, en pesos enteros', () => {
  expect(hourlyPrice(1.5, 60000)).toBe(90000);
  expect(hourlyPrice(0.33, 50000)).toBe(16500);
});

test('jornada: 7 días con horas entre 0 y 24', () => {
  expect(normalizeSchedule({ 1: 8, 6: '4' })).toEqual({ 0: 0, 1: 8, 2: 0, 3: 0, 4: 0, 5: 0, 6: 4 });
  expect(normalizeSchedule({ 1: 25 })).toBeNull();
  expect(normalizeSchedule(null)).toBeNull();
});

test('horas disponibles: jornada por día, sin domingos ni festivos', () => {
  // Semana del 2026-11-09 (lunes 9 = festivo? no) al 2026-11-15 (domingo).
  // Lunes 16-nov-2026 es festivo (Independencia de Cartagena, trasladado).
  const week = availableHours({ from: '2026-11-09', to: '2026-11-15', schedule: DEFAULT_SCHEDULE });
  expect(week).toEqual({ hours: 44, absent_hours: 0, workdays: 6 });
  const withHoliday = availableHours({ from: '2026-11-16', to: '2026-11-22', schedule: DEFAULT_SCHEDULE });
  expect(withHoliday.hours).toBe(36); // sin el lunes festivo
  const noSkip = availableHours({ from: '2026-11-16', to: '2026-11-22', schedule: DEFAULT_SCHEDULE, skipHolidays: false });
  expect(noSkip.hours).toBe(44);
});

test('las ausencias descuentan sus días, recortadas al periodo', () => {
  const r = availableHours({
    from: '2026-11-09', to: '2026-11-15', schedule: DEFAULT_SCHEDULE,
    absences: [{ start_date: '2026-11-05', end_date: '2026-11-10' }, { start_date: '2026-11-14', end_date: '2026-11-20' }],
  });
  // Ausente lunes 9, martes 10 (8+8) y sábado 14 (4).
  expect(r).toEqual({ hours: 24, absent_hours: 20, workdays: 3 });
});
