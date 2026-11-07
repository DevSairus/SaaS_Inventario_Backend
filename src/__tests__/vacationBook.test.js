// Tests del libro de vacaciones (cálculo puro, sin base de datos).
jest.mock('../config/database', () => ({ sequelize: { literal: jest.fn((x) => x) } }));
jest.mock('../models', () => ({ Employee: {}, PayrollNovedad: {}, PayrollPeriod: {} }));

const { computeVacationBook } = require('../services/payroll/vacationBook.service');

const employee = (extra = {}) => ({
  hire_date: '2024-01-01', termination_date: null, base_salary: 3000000,
  vacation_opening_days: null, vacation_opening_date: null, ...extra,
});
const period = (start, end, status = 'emitido') => ({ id: `p-${start}`, start_date: start, end_date: end, status });
const vac = (start, end, payload) => ({ dian_category: 'Vacaciones', payload, unpaid_days: 0, period: period(start, end) });

describe('computeVacationBook', () => {
  test('dos años completos sin tomar: 30 días disponibles', () => {
    const b = computeVacationBook(employee(), [], '2025-12-30');
    expect(b.dias_vinculo).toBe(720);
    expect(b.causados).toBe(30);
    expect(b.disponibles).toBe(30);
    expect(b.valor_disponibles).toBe(3000000);
    expect(b.alertas).toHaveLength(0);
  });

  test('descuenta disfrutadas y compensadas (pago parcial)', () => {
    const b = computeVacationBook(employee(), [
      vac('2025-01-01', '2025-01-15', { comunes: [{ fechaInicio: '2025-01-02', fechaFin: '2025-01-20', cantidad: 8, pago: 800000 }] }),
      vac('2025-02-01', '2025-02-15', { compensadas: [{ cantidad: 7, pago: 700000 }] }),
    ], '2025-12-30');
    expect(b.disfrutados).toBe(8);
    expect(b.compensados).toBe(7);
    expect(b.disponibles).toBe(15);
    expect(b.valor_pagado).toBe(1500000);
    expect(b.movimientos.map((m) => m.tipo)).toEqual(['disfrutadas', 'compensadas']);
  });

  test('licencias no remuneradas y días no remunerados no causan', () => {
    const b = computeVacationBook(employee(), [
      { dian_category: 'Licencias', payload: { noRemunerada: [{ cantidad: 30 }] }, unpaid_days: 0, period: period('2024-06-01', '2024-06-30') },
      { dian_category: null, payload: null, unpaid_days: 6, period: period('2024-07-01', '2024-07-15') },
    ], '2024-12-30');
    expect(b.dias_no_causan).toBe(36);
    expect(b.causados).toBe(Math.round(((360 - 36) / 360) * 15 * 100) / 100);
  });

  test('saldo inicial: cuenta desde la fecha de corte e ignora novedades anteriores', () => {
    const b = computeVacationBook(employee({ vacation_opening_days: 12, vacation_opening_date: '2025-07-01' }), [
      vac('2025-03-01', '2025-03-15', { comunes: [{ cantidad: 10, pago: 1 }] }), // antes del corte: ya incluida en el saldo
      vac('2025-08-01', '2025-08-15', { comunes: [{ cantidad: 5, pago: 1 }] }),
    ], '2025-12-30');
    expect(b.saldo_inicial).toBe(12);
    expect(b.desde).toBe('2025-07-01');
    expect(b.causados).toBe(7.5); // 180 días
    expect(b.disfrutados).toBe(5);
    expect(b.disponibles).toBe(14.5);
  });

  test('no causa después del retiro', () => {
    const b = computeVacationBook(employee({ termination_date: '2024-06-30' }), [], '2025-12-30');
    expect(b.hasta).toBe('2024-06-30');
    expect(b.causados).toBe(7.5);
  });

  test('alertas: más de dos periodos, anticipadas y compensación sobre la mitad', () => {
    const acumuladas = computeVacationBook(employee({ hire_date: '2022-01-01' }), [], '2025-12-30');
    expect(acumuladas.disponibles).toBe(60);
    expect(acumuladas.alertas[0]).toMatch(/más de dos periodos/);

    const anticipadas = computeVacationBook(employee(), [vac('2024-03-01', '2024-03-15', { comunes: [{ cantidad: 15, pago: 1 }] })], '2024-12-30');
    expect(anticipadas.disponibles).toBe(0);
    const masAnticipadas = computeVacationBook(employee(), [vac('2024-03-01', '2024-03-15', { comunes: [{ cantidad: 15, pago: 1 }] })], '2024-03-30');
    expect(masAnticipadas.disponibles).toBeLessThan(0);
    expect(masAnticipadas.alertas.join(' ')).toMatch(/anticipadas/);

    const compensadas = computeVacationBook(employee(), [vac('2025-01-01', '2025-01-15', { compensadas: [{ cantidad: 20, pago: 1 }] })], '2025-12-30');
    expect(compensadas.alertas.join(' ')).toMatch(/mitad/);
  });
});
