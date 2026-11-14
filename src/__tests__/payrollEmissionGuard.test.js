// 6.4 — Un empleado ya liquidado definitivamente no se vuelve a pagar en la nómina normal.
const mock = { docFindOne: jest.fn(), rollback: jest.fn(), commit: jest.fn() };

jest.mock('@dian-kit/core', () => ({ generateSoftwareSecurityCode: jest.fn() }));
jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn(async () => ({ rollback: mock.rollback, commit: mock.commit, finished: false })) },
  Employee: {}, PayrollNovedad: {}, PayrollConcept: {}, PayrollPeriod: {}, DianEvent: {}, DianResolution: {},
  PayrollDocument: { findOne: (...a) => mock.docFindOne(...a) },
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/dian/payrollDianAdapter', () => ({ submitPayrollDocument: jest.fn() }));
jest.mock('../services/dian/dianService', () => ({ getNextConsecutive: jest.fn(), extractDianConfig: jest.fn() }));
jest.mock('../services/accounting/autoEntries.service', () => ({ generatePayrollEntry: jest.fn() }));

const { emitirDocumentoEmpleado } = require('../services/payroll/payrollPeriodEmissionService');

const args = (periodType = 'mensual') => ({
  tenant: { id: 't1' }, employee: { id: 'emp-1' }, isTest: true,
  period: { id: 'p10', period_type: periodType, start_date: '2026-10-01', end_date: '2026-10-31' },
});

beforeEach(() => Object.values(mock).forEach((fn) => fn.mockReset()));

describe('emitirDocumentoEmpleado y la liquidación definitiva', () => {
  test('rechaza emitir nómina normal si hay una liquidación aceptada que cubre el período', async () => {
    mock.docFindOne
      .mockResolvedValueOnce(null) // no hay documento previo de este período
      .mockResolvedValueOnce({ id: 'doc-liq' }); // sí hay liquidación aceptada con end_date >= inicio del período
    const result = await emitirDocumentoEmpleado(args());
    expect(result).toMatchObject({ accepted: false, liquidation: null, payrollDocumentId: null });
    expect(result.error).toMatch(/liquidación definitiva aceptada por la DIAN/);
    expect(mock.rollback).toHaveBeenCalledTimes(1);

    const consulta = mock.docFindOne.mock.calls[1][0];
    expect(consulta.where).toMatchObject({ tenant_id: 't1', employee_id: 'emp-1', dian_status: 'accepted' });
    expect(consulta.include[0].where).toMatchObject({ period_type: 'liquidacion' });
  });

  test('si el documento del período ya estaba aceptado devuelve lo emitido sin consultar liquidaciones', async () => {
    mock.docFindOne.mockResolvedValueOnce({ id: 'doc-1', dian_status: 'accepted', snapshot_liquidation: { ok: true } });
    const result = await emitirDocumentoEmpleado(args());
    expect(result).toMatchObject({ accepted: true, payrollDocumentId: 'doc-1' });
    expect(mock.docFindOne).toHaveBeenCalledTimes(1);
  });

  test('el período de la propia liquidación no pasa por esta validación', async () => {
    mock.docFindOne.mockResolvedValueOnce(null);
    await emitirDocumentoEmpleado(args('liquidacion')).catch(() => {});
    // Nunca se busca "otra liquidación" (consulta con include del período de liquidación).
    const buscoLiquidacion = mock.docFindOne.mock.calls.some(([query]) => query && query.include);
    expect(buscoLiquidacion).toBe(false);
  });
});
