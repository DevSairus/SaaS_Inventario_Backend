// Métodos de depreciación, deterioro y libro fiscal (cálculo puro).
jest.mock('../config/database', () => ({ sequelize: { literal: jest.fn((x) => x) } }));
jest.mock('../models', () => ({}));

const { computeDepreciationForPeriod } = require('../services/accounting/fixedAssetDepreciation.service');
const { fiscalSchedule, fiscalRateOf } = require('../services/accounting/fixedAssetFiscal.service');

const asset = (extra = {}) => ({
  acquisition_cost: 12000000, salvage_value: 0, acquisition_date: '2026-01-01', useful_life_months: 60, category: 'maquinaria', ...extra,
});

describe('métodos', () => {
  test('terrenos y "no se deprecia": nada', () => {
    expect(computeDepreciationForPeriod(asset({ category: 'terrenos' }), '2026-01', 0)).toBe(0);
    expect(computeDepreciationForPeriod(asset({ depreciation_method: 'no_deprecia' }), '2026-01', 0)).toBe(0);
  });
  test('menor cuantía: todo en el primer mes', () => {
    expect(computeDepreciationForPeriod(asset({ acquisition_cost: 2000000, depreciation_method: 'menor_cuantia' }), '2026-01', 0)).toBe(2000000);
  });
  test('saldos decrecientes: más al principio y cierra en el residual', () => {
    const a = asset({ depreciation_method: 'saldos_decrecientes', salvage_value: 1200000 });
    expect(computeDepreciationForPeriod(a, '2026-01', 0)).toBe(400000); // 12.000.000 × 2 / 60
    // Al final, línea recta sobre lo que falta: 2 meses, 400.000 pendientes
    expect(computeDepreciationForPeriod(a, '2030-11', 10400000)).toBe(200000);
    expect(computeDepreciationForPeriod(a, '2030-12', 10800000)).toBe(0);
  });
  test('unidades de producción: saldo × uso / unidades que quedan', () => {
    const a = asset({ depreciation_method: 'unidades_produccion', total_units: 10000 });
    expect(computeDepreciationForPeriod(a, '2026-03', 0, { units: 250, unitsUsedBefore: 0 })).toBe(300000);
    expect(computeDepreciationForPeriod(a, '2026-04', 300000, { units: 0, unitsUsedBefore: 250 })).toBe(0);
    expect(computeDepreciationForPeriod(a, '2026-05', 300000, { units: 9750, unitsUsedBefore: 250 })).toBe(11700000);
  });
  test('deterioro: baja el saldo por depreciar', () => {
    expect(computeDepreciationForPeriod(asset(), '2030-12', 9000000, { impaired: 2950000 })).toBe(50000);
  });
});

describe('libro fiscal (art. 137 E.T.)', () => {
  test('tasas por categoría y propia', () => {
    expect(fiscalRateOf({ category: 'equipo_computo' })).toBe(20);
    expect(fiscalRateOf({ category: 'construcciones' })).toBe(2.22);
    expect(fiscalRateOf({ category: 'vehiculo', fiscal_max_rate: '5' })).toBe(5);
  });
  test('vida contable más corta que la fiscal: la deducción sigue después', () => {
    // Maquinaria de 12.000.000 a 3 años contables (33 %/año) con tope fiscal de 10 %/año.
    const a = asset({ useful_life_months: 36 });
    const contable = new Map([[2026, 4000000], [2027, 4000000], [2028, 4000000]]);
    const s = fiscalSchedule(a, contable, 2036);
    expect(s[0]).toMatchObject({ year: 2026, accounting: 4000000, fiscal: 1200000, difference: 2800000 });
    expect(s[3]).toMatchObject({ year: 2029, accounting: 0, fiscal: 1200000 });
    expect(s[9]).toMatchObject({ year: 2035, fiscal: 1200000, fiscal_accumulated: 12000000 });
    expect(s[10].fiscal).toBe(0);
  });
  test('vida contable más larga: fiscal = contable', () => {
    const s = fiscalSchedule(asset({ useful_life_months: 240 }), new Map([[2026, 600000]]), 2026);
    expect(s[0]).toMatchObject({ fiscal: 600000, difference: 0 });
  });
  test('compra a mitad de año: tope proporcional a los meses de uso', () => {
    const s = fiscalSchedule(asset({ acquisition_date: '2026-07-01', useful_life_months: 12 }), new Map([[2026, 6000000]]), 2026);
    expect(s[0].fiscal).toBe(600000); // 10 % × 6/12
  });
  test('base fiscal propia: costo fiscal y sin valor residual fiscal', () => {
    // Contable: 12.000.000 con residual 2.000.000 (base 10 M); fiscal: costo 11 M y residual 0.
    const a = asset({ salvage_value: 2000000, fiscal_cost: 11000000, fiscal_salvage_value: 0, useful_life_months: 120 });
    const s = fiscalSchedule(a, new Map([[2026, 1000000]]), 2026);
    expect(s[0].cap).toBe(1100000); // 10 % del costo fiscal
    expect(s[0].fiscal).toBe(1000000); // no pasa de lo contable del año
    const long = fiscalSchedule(a, new Map([[2026, 1000000], [2027, 12000000]]), 2040);
    expect(long[long.length - 1].fiscal_accumulated).toBe(11000000); // agota el costo fiscal completo
  });

  test('menor cuantía se deduce completo en el año; terrenos nada', () => {
    expect(fiscalSchedule(asset({ acquisition_cost: 2000000, depreciation_method: 'menor_cuantia' }), new Map([[2026, 2000000]]), 2026)[0].fiscal).toBe(2000000);
    expect(fiscalSchedule(asset({ category: 'terrenos' }), new Map(), 2026)[0].fiscal).toBe(0);
  });
});
