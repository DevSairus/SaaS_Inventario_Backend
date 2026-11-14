// Sede con la que se numera la nómina electrónica. Caso real: período creado
// para "todas las sedes" (branch_id null) → "No se puede generar el
// consecutivo DIAN sin una sede", aunque los empleados tenían sede.
const mock = { resFindOne: jest.fn() };

jest.mock('@dian-kit/core', () => ({ generateSoftwareSecurityCode: jest.fn() }));
jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn() },
  Employee: {}, PayrollNovedad: {}, PayrollConcept: {}, PayrollPeriod: {}, DianEvent: {}, PayrollDocument: {},
  DianResolution: { findOne: (...a) => mock.resFindOne(...a) },
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/dian/payrollDianAdapter', () => ({ submitPayrollDocument: jest.fn() }));
jest.mock('../services/dian/dianService', () => ({ getNextConsecutive: jest.fn(), extractDianConfig: jest.fn() }));
jest.mock('../services/accounting/autoEntries.service', () => ({ generatePayrollEntry: jest.fn() }));

const { resolvePayrollNumberingBranch } = require('../services/payroll/payrollPeriodEmissionService');

// Resoluciones de nómina activas: solo la sede principal tiene una.
const RESOLUTIONS = [{ branch_id: 'sede-principal' }];
beforeEach(() => {
  mock.resFindOne.mockReset();
  mock.resFindOne.mockImplementation(async ({ where }) => (
    where.branch_id ? RESOLUTIONS.find((r) => r.branch_id === where.branch_id) || null : RESOLUTIONS[0] || null
  ));
});

describe('resolvePayrollNumberingBranch', () => {
  test('período sin sede: usa la sede del empleado si tiene resolución', async () => {
    const b = await resolvePayrollNumberingBranch({ tenantId: 't1', preferredBranchIds: [null, 'sede-principal'], isTest: false });
    expect(b).toBe('sede-principal');
  });

  test('período sin sede y empleado de una sede sin resolución propia: usa la resolución de la empresa', async () => {
    const b = await resolvePayrollNumberingBranch({ tenantId: 't1', preferredBranchIds: [null, 'sede-norte'], isTest: false });
    expect(b).toBe('sede-principal');
  });

  test('el período con sede y resolución propia manda sobre la del empleado', async () => {
    RESOLUTIONS.push({ branch_id: 'sede-norte' });
    const b = await resolvePayrollNumberingBranch({ tenantId: 't1', preferredBranchIds: ['sede-norte', 'sede-principal'], isTest: false });
    expect(b).toBe('sede-norte');
    RESOLUTIONS.pop();
  });

  test('sin ninguna resolución devuelve la sede preferida (getNextConsecutive explica qué falta)', async () => {
    mock.resFindOne.mockResolvedValue(null);
    const b = await resolvePayrollNumberingBranch({ tenantId: 't1', preferredBranchIds: [null, 'sede-norte'], isTest: false });
    expect(b).toBe('sede-norte');
  });
});
