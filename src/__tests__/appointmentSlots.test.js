// Tests de buildDaySlots (workshopAppointments.controller.js): la regla de
// franjas disponibles que comparten la reserva pública y el reagendamiento
// del staff. Se aísla de la base de datos.
jest.mock('../config/database', () => ({ sequelize: {} }));
jest.mock('../models', () => ({}));
jest.mock('../services/whatsappService', () => ({}));

const { buildDaySlots } = require('../controllers/workshop/workshopAppointments.controller');

// 2026-10-05 es lunes.
const config = {
  business_hours: { mon: [{ start: '08:00', end: '10:00' }] },
  slot_duration_minutes: 60,
  capacity_per_slot: 2,
  min_notice_hours: 24,
  advance_booking_days: 7,
  blocked_dates: [],
};
const iso = (date, time) => new Date(`${date}T${time}:00`).toISOString();

describe('buildDaySlots', () => {
  it('genera las franjas del horario del día con su ocupación', () => {
    const now = new Date('2026-10-01T12:00:00');
    const day = buildDaySlots({ config, date: '2026-10-05', counts: { [iso('2026-10-05', '08:00')]: 2 }, now });
    expect(day.open).toBe(true);
    expect(day.slots.map(s => s.time)).toEqual(['08:00', '09:00']);
    expect(day.slots[0]).toMatchObject({ booked: 2, capacity: 2, available: false });
    expect(day.slots[1]).toMatchObject({ booked: 0, available: true });
  });

  it('público: respeta la anticipación mínima (min_notice_hours)', () => {
    const now = new Date('2026-10-04T20:00:00'); // faltan < 24 h para el lunes 08:00
    const day = buildDaySlots({ config, date: '2026-10-05', counts: {}, now, mode: 'public' });
    expect(day.slots.every(s => !s.available)).toBe(true);
  });

  it('staff: puede agendar dentro de la anticipación mínima, pero no en el pasado', () => {
    const now = new Date('2026-10-05T08:30:00');
    const day = buildDaySlots({ config, date: '2026-10-05', counts: {}, now, mode: 'staff' });
    expect(day.slots.find(s => s.time === '08:00').available).toBe(false); // ya pasó
    expect(day.slots.find(s => s.time === '09:00').available).toBe(true);  // < 24 h, permitido al staff
  });

  it('staff: no está limitado por advance_booking_days', () => {
    const now = new Date('2026-09-01T12:00:00'); // el lunes 5-oct está a más de 7 días
    expect(buildDaySlots({ config, date: '2026-10-05', counts: {}, now, mode: 'public' }).slots.some(s => s.available)).toBe(false);
    expect(buildDaySlots({ config, date: '2026-10-05', counts: {}, now, mode: 'staff' }).slots.every(s => s.available)).toBe(true);
  });

  it('staff: la capacidad y las fechas bloqueadas aplican igual', () => {
    const now = new Date('2026-10-01T12:00:00');
    const full = buildDaySlots({ config, date: '2026-10-05', counts: { [iso('2026-10-05', '09:00')]: 2 }, now, mode: 'staff' });
    expect(full.slots.find(s => s.time === '09:00').available).toBe(false);

    const blocked = buildDaySlots({ config: { ...config, blocked_dates: [{ date: '2026-10-05' }] }, date: '2026-10-05', counts: {}, now, mode: 'staff' });
    expect(blocked).toMatchObject({ open: false, reason: 'blocked' });
  });

  it('día sin horario configurado = cerrado', () => {
    const day = buildDaySlots({ config, date: '2026-10-06', counts: {}, now: new Date('2026-10-01T12:00:00'), mode: 'staff' });
    expect(day.open).toBe(false);
  });
});
