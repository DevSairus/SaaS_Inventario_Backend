// Depreciación de activos fijos: línea recta, saldo inicial, cambio de
// estimación hacia adelante y prorrateo del mes de la baja (cálculo puro).
jest.mock('../config/database', () => ({ sequelize: { literal: jest.fn((x) => x) } }));
jest.mock('../models', () => ({}));

const { computeDepreciationForPeriod, openingFields, monthsBetween } = require('../services/accounting/fixedAssetDepreciation.service');

const asset = (extra = {}) => ({
  acquisition_cost: 12000000, salvage_value: 0, acquisition_date: '2026-01-01', useful_life_months: 60, ...extra,
});

describe('línea recta', () => {
  test('cuota mensual y prorrateo del mes de compra', () => {
    expect(computeDepreciationForPeriod(asset(), '2026-01', 0)).toBe(200000);
    // Comprado el 16 de abril (30 días): 15 días del mes
    expect(computeDepreciationForPeriod(asset({ acquisition_date: '2026-04-16' }), '2026-04', 0)).toBe(100000);
  });
  test('nunca pasa del saldo por depreciar', () => {
    expect(computeDepreciationForPeriod(asset(), '2030-12', 11950000)).toBe(50000);
    expect(computeDepreciationForPeriod(asset(), '2031-01', 12000000)).toBe(0);
  });
  test('mes de la baja: solo hasta el día de la baja', () => {
    expect(computeDepreciationForPeriod(asset(), '2026-06', 1000000, { untilDate: '2026-06-15' })).toBe(100000);
  });
});

describe('saldo inicial', () => {
  test('activo de 2020 que ya traía depreciación: sigue desde el mes siguiente con la vida restante', () => {
    const f = openingFields({
      acquisition_cost: 25000000, salvage_value: 0, acquisition_date: '2020-01-01', useful_life_months: 120,
      opening_accumulated_depreciation: 16666666.4, opening_period: '2026-08',
    });
    expect(monthsBetween('2020-01', '2026-08') + 1).toBe(80);
    expect(f).toMatchObject({ opening_period: '2026-08', basis_period: '2026-09', basis_months: 40, basis_amount: 8333333.6, useful_life_months: 120, status: 'activo' });
    const a = asset({ acquisition_cost: 25000000, acquisition_date: '2020-01-01', useful_life_months: 120, ...f });
    expect(computeDepreciationForPeriod(a, '2026-09', 16666666.4)).toBe(208333.34);
  });
  test('vida restante indicada a mano y activo ya totalmente depreciado', () => {
    const f = openingFields({ acquisition_cost: 1000000, salvage_value: 0, acquisition_date: '2024-01-01', useful_life_months: 36, opening_accumulated_depreciation: 400000, opening_period: '2025-12', remaining_months: 12 });
    expect(f).toMatchObject({ basis_months: 12, basis_amount: 600000, useful_life_months: 36 });
    const full = openingFields({ acquisition_cost: 1000000, salvage_value: 0, acquisition_date: '2020-01-01', useful_life_months: 36, opening_accumulated_depreciation: 1000000, opening_period: '2025-12' });
    expect(full.status).toBe('totalmente_depreciado');
  });
  test('validaciones', () => {
    const base = { acquisition_cost: 1000000, salvage_value: 0, acquisition_date: '2024-01-01', useful_life_months: 36 };
    expect(openingFields(base)).toEqual({});
    expect(() => openingFields({ ...base, opening_accumulated_depreciation: 100 })).toThrow(/mes de corte/);
    expect(() => openingFields({ ...base, opening_accumulated_depreciation: 2000000, opening_period: '2025-01' })).toThrow(/no puede superar/);
    expect(() => openingFields({ ...base, opening_accumulated_depreciation: 100, opening_period: '2023-01' })).toThrow(/anterior a la compra/);
  });
});

describe('cambio de estimación hacia adelante', () => {
  test('desde el período de la base, la cuota es saldo / meses restantes', () => {
    const a = asset({ basis_period: '2027-01', basis_amount: 9600000, basis_months: 24 });
    expect(computeDepreciationForPeriod(a, '2026-12', 2200000)).toBe(200000); // antes del cambio: cuota original
    expect(computeDepreciationForPeriod(a, '2027-01', 2400000)).toBe(400000); // después: 9.600.000 / 24
  });
});
