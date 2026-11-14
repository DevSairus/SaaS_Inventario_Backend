// 6.6 / 6.7 — Quién entra a un período de nómina y cuándo se refresca la vista previa.
const mockFindAll = jest.fn();

jest.mock('../models', () => ({ Employee: { findAll: (...args) => mockFindAll(...args) } }));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { Op } = require('sequelize');
const {
  getEmployeesActiveInPeriod, isEmployeeInPeriod, refreshLiquidationPreview,
} = require('../services/payroll/payrollPeriodEmissionService');

const period = { period_type: 'mensual', start_date: '2026-10-01', end_date: '2026-10-31', branch_id: null };

describe('isEmployeeInPeriod', () => {
  test('ingresó antes del cierre y sigue activo: entra', () => {
    expect(isEmployeeInPeriod({ hire_date: '2025-01-15', termination_date: null }, period)).toBe(true);
  });

  test('ingresó el último día del período: entra; un día después: no', () => {
    expect(isEmployeeInPeriod({ hire_date: '2026-10-31' }, period)).toBe(true);
    expect(isEmployeeInPeriod({ hire_date: '2026-11-01' }, period)).toBe(false);
  });

  test('retirado antes de que empiece el período: no entra', () => {
    expect(isEmployeeInPeriod({ hire_date: '2024-01-01', termination_date: '2026-09-30' }, period)).toBe(false);
  });

  test('retirado dentro del período o el primer día: entra (se prorratea hasta su retiro)', () => {
    expect(isEmployeeInPeriod({ hire_date: '2024-01-01', termination_date: '2026-10-15' }, period)).toBe(true);
    expect(isEmployeeInPeriod({ hire_date: '2024-01-01', termination_date: '2026-10-01' }, period)).toBe(true);
  });

  test('acepta fechas Date y cadenas con hora', () => {
    expect(isEmployeeInPeriod({ hire_date: new Date('2026-10-10T00:00:00Z') }, period)).toBe(true);
    expect(isEmployeeInPeriod({ hire_date: '2024-01-01', termination_date: new Date('2026-09-30T00:00:00Z') }, period)).toBe(false);
    expect(isEmployeeInPeriod({ hire_date: '2024-01-01T00:00:00.000Z', termination_date: '2026-10-20T00:00:00.000Z' }, period)).toBe(true);
  });
});

describe('getEmployeesActiveInPeriod', () => {
  beforeEach(() => mockFindAll.mockReset().mockResolvedValue([]));

  test('filtra por inquilino, activos, periodicidad, ingreso y retiro con las mismas fechas que isEmployeeInPeriod', async () => {
    await getEmployeesActiveInPeriod('t1', period);
    const { where } = mockFindAll.mock.calls[0][0];
    expect(where).toMatchObject({
      tenant_id: 't1', is_active: true, payroll_periodicity: 'mensual',
      hire_date: { [Op.lte]: '2026-10-31' },
    });
    expect(where[Op.or]).toEqual([
      { termination_date: null },
      { termination_date: { [Op.gte]: '2026-10-01' } },
    ]);
    expect(where.branch_id).toBeUndefined();
  });

  test('si el período es de una sede, solo trae empleados de esa sede', async () => {
    await getEmployeesActiveInPeriod('t1', { ...period, branch_id: 'b1' });
    expect(mockFindAll.mock.calls[0][0].where.branch_id).toBe('b1');
  });
});

describe('refreshLiquidationPreview', () => {
  test('no hace nada si no hay período o no está liquidado', async () => {
    const update = jest.fn();
    expect(await refreshLiquidationPreview(null, 't1')).toBeNull();
    expect(await refreshLiquidationPreview({ status: 'borrador', update }, 't1')).toBeNull();
    expect(await refreshLiquidationPreview({ status: 'emitido', update }, 't1')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
