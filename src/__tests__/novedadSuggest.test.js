// Tests de los valores sugeridos de novedades de nómina (cálculo puro).
jest.mock('../config/database', () => ({ sequelize: { literal: jest.fn((x) => x) } }));
jest.mock('../models', () => ({}));

const { suggestNovedad, businessDaysBetween, lastBusinessDay, calendarDays } = require('../services/payroll/novedadSuggest.service');
const { PAYROLL_CONSTANTS } = require('../services/payroll/payrollService');

const employee = (extra = {}) => ({ base_salary: 3000000, salary_type: 'ordinario', hire_date: '2024-01-01', transport_allowance_eligible: true, ...extra });
const period = { start_date: '2026-11-01', end_date: '2026-11-30' };
const ctx = (extra = {}) => ({ employee: employee(), period, settings: {}, commissionsAvg: 0, ...extra });

describe('días hábiles (festivos de noviembre 2026: lunes 2 y lunes 16)', () => {
  test('15 hábiles desde el martes 3, lunes a sábado: terminan el viernes 20', () => {
    expect(lastBusinessDay('2026-11-03', 15)).toBe('2026-11-20');
    expect(businessDaysBetween('2026-11-03', '2026-11-20').count).toBe(15);
  });
  test('sin sábados: terminan el martes 24', () => {
    expect(lastBusinessDay('2026-11-03', 15, false)).toBe('2026-11-24');
  });
  test('días calendario inclusivos', () => {
    expect(calendarDays('2026-11-03', '2026-11-05')).toBe(3);
    expect(calendarDays('2026-11-05', '2026-11-03')).toBeNull();
  });
});

describe('suggestNovedad', () => {
  test('vacaciones: fecha de inicio + días → fecha de fin y valor', () => {
    const r = suggestNovedad(ctx(), { category: 'Vacaciones', subtype: 'comunes', values: { fechaInicio: '2026-11-03', cantidad: '15' }, source: 'cantidad' });
    expect(r.values.fechaFin).toBe('2026-11-20');
    expect(r.values.pago).toBe(1500000);
    expect(r.detail).toMatch(/regresa el 21 de nov de 2026/);
  });

  test('vacaciones: al cambiar la fecha de fin se recalculan los días', () => {
    const r = suggestNovedad(ctx(), { category: 'Vacaciones', subtype: 'comunes', values: { fechaInicio: '2026-11-03', cantidad: '15', fechaFin: '2026-11-10' }, source: 'fechaFin' });
    expect(r.values.cantidad).toBe(7);
    expect(r.values.pago).toBe(700000);
  });

  test('vacaciones con comisiones: suma el promedio mensual (art. 192)', () => {
    const r = suggestNovedad(ctx({ commissionsAvg: 600000 }), { category: 'Vacaciones', subtype: 'compensadas', values: { cantidad: 7 } });
    expect(r.values.pago).toBe(Math.round((3600000 / 30) * 7));
  });

  test('incapacidad común: 66,67 % con piso en el mínimo; laboral: 100 %', () => {
    const comun = suggestNovedad(ctx(), { category: 'Incapacidades', values: { fechaInicio: '2026-11-03', fechaFin: '2026-11-07' } });
    expect(comun.values.cantidad).toBe(5);
    expect(comun.values.tipo).toBe('1');
    expect(comun.values.pago).toBe(Math.round(100000 * 0.6667 * 5));

    const minimo = suggestNovedad(ctx({ employee: employee({ base_salary: PAYROLL_CONSTANTS.SMLMV }) }), { category: 'Incapacidades', values: { fechaInicio: '2026-11-03', fechaFin: '2026-11-04', tipo: '1' } });
    expect(minimo.values.pago).toBe(Math.round((PAYROLL_CONSTANTS.SMLMV / 30) * 2));

    const laboral = suggestNovedad(ctx(), { category: 'Incapacidades', values: { fechaInicio: '2026-11-03', fechaFin: '2026-11-07', tipo: '2' } });
    expect(laboral.values.pago).toBe(500000);
  });

  test('licencia remunerada por días calendario; integral sobre el 70 %', () => {
    const r = suggestNovedad(ctx(), { category: 'Licencias', subtype: 'remunerada', values: { fechaInicio: '2026-11-03', fechaFin: '2026-11-07' } });
    expect(r.values).toEqual({ cantidad: 5, pago: 500000 });
    const integral = suggestNovedad(ctx({ employee: employee({ salary_type: 'integral', base_salary: 30000000 }) }), { category: 'Licencias', subtype: 'maternidadPaternidad', values: { fechaInicio: '2026-11-01', fechaFin: '2026-11-14' } });
    expect(integral.values.pago).toBe(Math.round(((30000000 * 0.7) / 30) * 14));
    const nr = suggestNovedad(ctx(), { category: 'Licencias', subtype: 'noRemunerada', values: { fechaInicio: '2026-11-03', fechaFin: '2026-11-04' } });
    expect(nr.values).toEqual({ cantidad: 2 });
  });

  test('prima: días del semestre hasta el fin del periodo, con auxilio de transporte si aplica', () => {
    const dic = { start_date: '2026-12-01', end_date: '2026-12-30' };
    const r = suggestNovedad(ctx({ period: dic, employee: employee({ base_salary: 2000000 }) }), { category: 'Primas', values: {} });
    expect(r.values.cantidad).toBe(180);
    expect(r.values.pago).toBe(Math.round(((2000000 + PAYROLL_CONSTANTS.AUXILIO_TRANSPORTE) * 180) / 360));
    const alto = suggestNovedad(ctx({ period: dic, employee: employee({ base_salary: 4000000 }) }), { category: 'Primas', values: { cantidad: 90 } });
    expect(alto.values.pago).toBe(1000000); // gana más de 2 mínimos: sin auxilio
  });

  test('cesantías: intereses al 12 %; sindicato: salario × %', () => {
    const c = suggestNovedad(ctx(), { category: 'Cesantias', values: { pago: 3000000 } });
    expect(c.values).toEqual({ porcentaje: 12, pagoIntereses: 360000 });
    const s = suggestNovedad(ctx(), { category: 'Sindicatos', values: { porcentaje: 1 } });
    expect(s.values.deduccion).toBe(30000);
  });

  test('sin salario: avisa y no inventa valores', () => {
    const r = suggestNovedad(ctx({ employee: employee({ base_salary: 0 }) }), { category: 'Vacaciones', subtype: 'compensadas', values: { cantidad: 5 } });
    expect(r.values.pago).toBeUndefined();
    expect(r.warnings[0]).toMatch(/salario/);
  });
});
