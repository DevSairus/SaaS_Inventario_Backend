// Horarios de obra (Fase 4, req. 1.1): clasificación de la planilla en
// ordinarias, extra y recargos, y valor de la novedad de nómina.
// Fechas: 2026-11-13 viernes, 2026-11-14 sábado, 2026-11-15 domingo,
// 2026-11-16 lunes festivo (Independencia de Cartagena, Ley Emiliani).
const { classifyEmployeeEntries, workedHours, dailyHoursFor } = require('../services/projects/workHours');

jest.mock('../models', () => ({}));
jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn() } }));
jest.mock('../services/payroll/payrollPeriodEmissionService', () => ({}));
jest.mock('../services/payroll/payrollAccountingService', () => ({}));
const { hoursPay } = require('../services/payroll/projectHoursPayroll.service');

const E8 = { daily_hours: 8 };
let n = 0;
const entry = (work_date, start_time, end_time, extra = {}) => ({ id: `e${++n}`, project_id: 'A', work_date, start_time, end_time, break_minutes: 0, ...extra });
const nonZero = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v > 0));

describe('clasificación de la planilla', () => {
  test('viernes 7:00–17:00 con 1 h de almuerzo: 8 ordinarias y 1 extra diurna', () => {
    const { totals } = classifyEmployeeEntries([entry('2026-11-13', '07:00', '17:00', { break_minutes: 60 })], E8);
    expect(nonZero(totals)).toEqual({ ORD: 8, HEDs: 1 });
  });

  test('desde las 7:00 p. m. es nocturno (Ley 2466): 14:00–22:00 → 5 ordinarias y 3 de recargo nocturno', () => {
    const { totals } = classifyEmployeeEntries([entry('2026-11-13', '14:00', '22:00')], E8);
    expect(nonZero(totals)).toEqual({ ORD: 5, HRNs: 3 });
  });

  test('antes del 25-dic-2025 el nocturno empezaba a las 9:00 p. m.', () => {
    const { totals } = classifyEmployeeEntries([entry('2025-11-14', '18:00', '22:00')], E8);
    expect(nonZero(totals)).toEqual({ ORD: 3, HRNs: 1 });
  });

  test('domingo y festivo: recargo dominical/festivo', () => {
    expect(nonZero(classifyEmployeeEntries([entry('2026-11-15', '08:00', '12:00')], E8).totals)).toEqual({ HRDDFs: 4 });
    expect(nonZero(classifyEmployeeEntries([entry('2026-11-16', '08:00', '10:00')], E8).totals)).toEqual({ HRDDFs: 2 });
  });

  test('turno que pasa la medianoche del sábado al domingo', () => {
    const { totals } = classifyEmployeeEntries([entry('2026-11-14', '22:00', '06:00')], E8);
    expect(nonZero(totals)).toEqual({ HRNs: 2, HRNDFs: 6 });
  });

  test('dos obras el mismo día: la extra se cuenta sumando ambas, en orden de entrada', () => {
    const a = entry('2026-11-13', '06:00', '12:00');
    const b = entry('2026-11-13', '13:00', '17:00', { project_id: 'B' });
    const { byEntry, totals, days } = classifyEmployeeEntries([b, a], E8);
    expect(nonZero(byEntry.get(a.id))).toEqual({ ORD: 6 });
    expect(nonZero(byEntry.get(b.id))).toEqual({ ORD: 2, HEDs: 2 });
    expect(nonZero(totals)).toEqual({ ORD: 8, HEDs: 2 });
    expect(days[0]).toMatchObject({ hours: 10, extra: 2 });
  });

  test('sin horas por día configuradas: jornada semanal / 6 (42 h → 7 h)', () => {
    expect(dailyHoursFor('2026-11-13', {})).toBe(7);
    const { totals } = classifyEmployeeEntries([entry('2026-11-13', '08:00', '16:00')], {});
    expect(nonZero(totals)).toEqual({ ORD: 7, HEDs: 1 });
  });

  test('registros de solo horas cuentan como diurnos', () => {
    const { totals } = classifyEmployeeEntries([{ id: 'x', work_date: '2026-11-13', hours: 9 }], E8);
    expect(nonZero(totals)).toEqual({ ORD: 8, HEDs: 1 });
  });

  test('horas trabajadas de un turno con descanso y de uno nocturno', () => {
    expect(workedHours({ work_date: '2026-11-13', start_time: '07:00', end_time: '17:00', break_minutes: 60 })).toBe(9);
    expect(workedHours({ work_date: '2026-11-14', start_time: '22:00', end_time: '06:00' })).toBe(8);
  });
});

describe('valor de la novedad', () => {
  // Salario 2.100.000 / 210 h = 10.000 la hora.
  test('extra: valor hora × (1 + %); recargo: valor hora × %', () => {
    expect(hoursPay({ baseSalary: 2100000, monthHours: 210, category: 'HEDs', hours: 2, pct: 25 })).toBe(25000);
    expect(hoursPay({ baseSalary: 2100000, monthHours: 210, category: 'HRNs', hours: 3, pct: 35 })).toBe(10500);
    expect(hoursPay({ baseSalary: 2100000, monthHours: 210, category: 'HRDDFs', hours: 4, pct: 90 })).toBe(36000);
  });
});
