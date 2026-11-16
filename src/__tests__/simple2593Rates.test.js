// Formulario 2593: tarifas SIMPLE bimestrales (Resolución DIAN 000081 de 2024) y bimestres.
const { groupRate, periodRange } = require('../services/tax/simple2593.service');

describe('tarifa SIMPLE consolidada bimestral', () => {
  test('grupo 1 por rangos de UVT', () => {
    expect(groupRate('1', 999)).toBe(1.2);
    expect(groupRate('1', 1000)).toBe(2.8);
    expect(groupRate('1', 2500)).toBe(4.4);
    expect(groupRate('1', 5000)).toBe(5.6);
  });
  test('grupos 2, 3 y 3 (sic)', () => {
    expect([0, 1500, 3000, 9000].map((u) => groupRate('2', u))).toEqual([1.6, 2.0, 3.5, 4.5]);
    expect([0, 1500, 3000, 9000].map((u) => groupRate('3', u))).toEqual([3.1, 3.4, 4.0, 4.5]);
    expect([0, 1500, 3000, 9000].map((u) => groupRate('3p', u))).toEqual([5.9, 7.3, 12, 14.5]);
  });
  test('grupo 6 tarifa fija y por encima de 16.666 UVT la más alta', () => {
    expect(groupRate('6', 50)).toBe(1.62);
    expect(groupRate('6', 20000)).toBe(1.62);
    expect(groupRate('2', 20000)).toBe(4.5);
  });
});

describe('bimestres', () => {
  test('rangos de fechas (febrero bisiesto)', () => {
    expect(periodRange(2028, 1)).toMatchObject({ dateFrom: '2028-01-01', dateTo: '2028-02-29' });
    expect(periodRange(2026, 1)).toMatchObject({ dateFrom: '2026-01-01', dateTo: '2026-02-28' });
    expect(periodRange(2026, 6)).toMatchObject({ dateFrom: '2026-11-01', dateTo: '2026-12-31' });
  });
  test('valida año y bimestre', () => {
    expect(() => periodRange(2023, 1)).toThrow();
    expect(() => periodRange(2026, 7)).toThrow();
  });
});
