// 6.2 / 6.4 — Emisión de la liquidación definitiva: causa obligatoria e idempotencia.
const mock = {
  employeeFindOne: jest.fn(), tenantFindByPk: jest.fn(), periodFindOne: jest.fn(), docFindOne: jest.fn(),
  periodCreate: jest.fn(), emitir: jest.fn(),
};

jest.mock('../models', () => ({
  Employee: { findOne: (...a) => mock.employeeFindOne(...a) },
  Tenant: { findByPk: (...a) => mock.tenantFindByPk(...a) },
  PayrollPeriod: { findOne: (...a) => mock.periodFindOne(...a), create: (...a) => mock.periodCreate(...a) },
  PayrollDocument: { findOne: (...a) => mock.docFindOne(...a) },
  PayrollNovedad: { destroy: jest.fn(), create: jest.fn() },
  PayrollSetting: {},
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/payroll/payrollPeriodEmissionService', () => ({
  emitirDocumentoEmpleado: (...a) => mock.emitir(...a), getPayrollResolution: jest.fn(),
}));
jest.mock('../services/dian/dianService', () => ({ extractDianConfig: jest.fn() }));
jest.mock('../services/accounting/autoEntries.service', () => ({ generatePayrollEntry: jest.fn() }));

const { emitirLiquidacionDefinitiva } = require('../services/payroll/payrollTerminationService');

const baseEmployee = {
  id: 'emp-1', hire_date: '2024-03-01', termination_date: '2026-10-15', base_salary: 3000000,
  contract_type: '1', first_name: 'Juan', first_surname: 'Pérez', document_type: '13', document_number: '1017',
};

describe('emitirLiquidacionDefinitiva', () => {
  beforeEach(() => {
    Object.values(mock).forEach((fn) => fn.mockReset());
    mock.tenantFindByPk.mockResolvedValue({ id: 't1' });
  });

  test('sin causa del retiro no emite y explica qué falta', async () => {
    mock.employeeFindOne.mockResolvedValue({ ...baseEmployee, termination_reason: null });
    await expect(emitirLiquidacionDefinitiva('t1', 'emp-1', 'u1')).rejects.toThrow(/causa del retiro/);
    expect(mock.emitir).not.toHaveBeenCalled();
    expect(mock.periodCreate).not.toHaveBeenCalled();
  });

  test('si la liquidación ya fue aceptada por la DIAN la devuelve sin recalcular ni reenviar', async () => {
    mock.employeeFindOne.mockResolvedValue({ ...baseEmployee, termination_reason: 'renuncia' });
    mock.periodFindOne.mockResolvedValue({ id: 'per-1', status: 'emitido' });
    mock.docFindOne.mockResolvedValue({ id: 'doc-1' });

    const result = await emitirLiquidacionDefinitiva('t1', 'emp-1', 'u1');

    expect(result).toMatchObject({ alreadyEmitted: true, payrollDocumentId: 'doc-1', breakdown: null });
    expect(mock.periodFindOne.mock.calls[0][0].where).toMatchObject({
      tenant_id: 't1', period_type: 'liquidacion', status: 'emitido', end_date: '2026-10-15',
    });
    expect(mock.periodCreate).not.toHaveBeenCalled();
    expect(mock.emitir).not.toHaveBeenCalled();
  });
});
