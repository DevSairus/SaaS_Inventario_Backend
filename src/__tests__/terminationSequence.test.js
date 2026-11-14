// 6.4 — Opción A: la nómina paga los días causados hasta el retiro; la liquidación
// definitiva paga prestaciones y vacaciones, en secuencia y sin pagar nada dos veces.
const mock = {
  periodFindAll: jest.fn(), periodFindOne: jest.fn(), periodCreate: jest.fn(),
  docFindAll: jest.fn(), docFindOne: jest.fn(), employeeFindOne: jest.fn(), tenantFindByPk: jest.fn(),
  emitir: jest.fn(), book: jest.fn(),
};

jest.mock('../models', () => ({
  Employee: { findOne: (...a) => mock.employeeFindOne(...a) },
  Tenant: { findByPk: (...a) => mock.tenantFindByPk(...a) },
  PayrollPeriod: { findAll: (...a) => mock.periodFindAll(...a), findOne: (...a) => mock.periodFindOne(...a), create: (...a) => mock.periodCreate(...a) },
  PayrollDocument: { findAll: (...a) => mock.docFindAll(...a), findOne: (...a) => mock.docFindOne(...a) },
  PayrollNovedad: { destroy: jest.fn(), create: jest.fn() },
  PayrollSetting: {},
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/payroll/payrollPeriodEmissionService', () => ({
  emitirDocumentoEmpleado: (...a) => mock.emitir(...a),
  getPayrollResolution: jest.fn(),
  isEmployeeInPeriod: (employee, period) => {
    const iso = (d) => String(d || '').slice(0, 10);
    if (iso(employee.hire_date) > iso(period.end_date)) return false;
    if (employee.termination_date && iso(employee.termination_date) < iso(period.start_date)) return false;
    return true;
  },
}));
jest.mock('../services/dian/dianService', () => ({ extractDianConfig: jest.fn() }));
jest.mock('../services/accounting/autoEntries.service', () => ({ generatePayrollEntry: jest.fn() }));
jest.mock('../services/payroll/vacationBook.service', () => ({ getEmployeeBook: (...a) => mock.book(...a) }));

const { liquidarEmpleado } = require('../services/payroll/payrollService');
const service = require('../services/payroll/payrollTerminationService');

const employee = {
  id: 'emp-1', branch_id: null, hire_date: '2024-03-01', termination_date: '2026-10-15', termination_reason: 'renuncia',
  base_salary: 3000000, contract_type: '1', payroll_periodicity: 'mensual',
  first_name: 'Juan', first_surname: 'Pérez', document_type: '13', document_number: '1017',
};
const bookZero = { saldo_inicial: 0, fecha_saldo_inicial: null, causados: 0, dias_no_causan: 0, disfrutados: 0, compensados: 0, disponibles: 0 };

const docWith = (endDate, type, primas) => ({
  period: { end_date: endDate, period_type: type },
  snapshot_liquidation: primas ? { devengados: { primas } } : { devengados: {} },
});

beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  mock.tenantFindByPk.mockResolvedValue({ id: 't1' });
  mock.book.mockResolvedValue(bookZero);
  mock.docFindAll.mockResolvedValue([]);
  mock.periodFindAll.mockResolvedValue([]);
});

describe('liquidarEmpleado con el salario ya cubierto', () => {
  const periodo = { start_date: '2026-10-15', end_date: '2026-10-15', payment_date: '2026-10-15', excludes_salary: true };
  const novedades = [{ dian_category: 'Primas', payload: { cantidad: 105, pago: 1800000 } }];

  test('no paga días ni sueldo ni auxilio de transporte', () => {
    const liquidacion = liquidarEmpleado({ employee, period: periodo, novedades, autoConcepts: [], diasNoRemunerados: 0, softwareSecurityCode: 'x' });
    expect(liquidacion.devengados.basico).toEqual({ diasTrabajados: 0, sueldoTrabajado: 0 });
    expect(liquidacion.devengados.transporte).toBeUndefined();
    expect(liquidacion.devengadosTotal).toBe(1800000);
  });

  test('el tiempo laborado es el de toda la relación laboral, no 0', () => {
    const liquidacion = liquidarEmpleado({ employee, period: periodo, novedades, autoConcepts: [], diasNoRemunerados: 0, softwareSecurityCode: 'x' });
    expect(liquidacion.tiempoLaboradoDias).toBeGreaterThan(600);
  });

  test('sin la marca, el mismo período sí paga el día del retiro (comportamiento anterior)', () => {
    const liquidacion = liquidarEmpleado({ employee, period: { ...periodo, excludes_salary: false }, novedades: [], autoConcepts: [], diasNoRemunerados: 0, softwareSecurityCode: 'x' });
    expect(liquidacion.devengados.basico.diasTrabajados).toBe(1);
  });
});

describe('tramo de salario pendiente', () => {
  test('con la nómina del mes ya pagada hasta el retiro, el salario queda cubierto', async () => {
    mock.docFindOne.mockResolvedValue({ period: { end_date: '2026-10-15' } });
    const rango = await service.obtenerRangoSalarioPendiente('t1', employee);
    expect(rango).toMatchObject({ inicio: '2026-10-16', fin: '2026-10-15', salarioCubierto: true, pagadoHasta: '2026-10-15' });
  });

  test('con pagos solo hasta el mes anterior quedan días por pagar', async () => {
    mock.docFindOne.mockResolvedValue({ period: { end_date: '2026-09-30' } });
    const rango = await service.obtenerRangoSalarioPendiente('t1', employee);
    expect(rango).toMatchObject({ inicio: '2026-10-01', fin: '2026-10-15', salarioCubierto: false });
  });
});

describe('secuencia obligatoria: períodos normales pendientes', () => {
  const periodo = (id, start, end, extra = {}) => ({ id, period_type: 'mensual', branch_id: null, start_date: start, end_date: end, status: 'abierto', ...extra });

  test('lista los períodos del empleado hasta el retiro que no tienen documento aceptado', async () => {
    mock.periodFindAll.mockResolvedValue([periodo('p9', '2026-09-01', '2026-09-30'), periodo('p10', '2026-10-01', '2026-10-31')]);
    mock.docFindAll.mockResolvedValue([{ payroll_period_id: 'p9' }]);
    const pendientes = await service.obtenerPeriodosPendientes('t1', employee);
    expect(pendientes.map((p) => p.id)).toEqual(['p10']);
  });

  test('ignora períodos de otra periodicidad o de otra sede', async () => {
    mock.periodFindAll.mockResolvedValue([
      periodo('q1', '2026-10-01', '2026-10-15', { period_type: 'quincenal' }),
      periodo('s1', '2026-10-01', '2026-10-31', { branch_id: 'otra-sede' }),
    ]);
    expect(await service.obtenerPeriodosPendientes('t1', { ...employee, branch_id: 'mi-sede' })).toEqual([]);
  });

  test('si no hay períodos o todos están pagados, no hay pendientes', async () => {
    expect(await service.obtenerPeriodosPendientes('t1', employee)).toEqual([]);
    mock.periodFindAll.mockResolvedValue([periodo('p10', '2026-10-01', '2026-10-31')]);
    mock.docFindAll.mockResolvedValue([{ payroll_period_id: 'p10' }]);
    expect(await service.obtenerPeriodosPendientes('t1', employee)).toEqual([]);
  });
});

describe('prima ya pagada en nómina', () => {
  const retiroDiciembre = { ...employee, termination_date: '2026-12-28' };

  test('descuenta la prima del semestre pagada en un período normal', async () => {
    mock.docFindAll.mockResolvedValue([
      docWith('2026-12-20', 'mensual', { cantidad: 180, pago: 1500000, pagoNS: 0 }),
      docWith('2026-06-30', 'mensual', { cantidad: 180, pago: 1400000 }),
    ]);
    expect(await service.obtenerPrimaYaPagada('t1', retiroDiciembre, '2026-07-01')).toBe(1500000);
  });

  test('no cuenta primas de semestres anteriores ni de otra liquidación', async () => {
    mock.docFindAll.mockResolvedValue([
      docWith('2025-12-20', 'mensual', { pago: 1300000 }),
      docWith('2026-12-28', 'liquidacion', { pago: 999 }),
    ]);
    expect(await service.obtenerPrimaYaPagada('t1', retiroDiciembre, '2026-07-01')).toBe(0);
  });
});

describe('cálculo de la liquidación (opción A)', () => {
  test('con salario cubierto: sin tramo de sueldo, nota explicativa y período de un solo día', async () => {
    mock.docFindOne.mockResolvedValue({ period: { end_date: '2026-10-15' } });
    const preview = await service.previewLiquidacionDefinitiva('t1', 'emp-1', {}).catch(() => null);
    expect(preview).toBeNull(); // Employee.findOne aún no devuelve nada
    mock.employeeFindOne.mockResolvedValue(employee);
    const result = await service.previewLiquidacionDefinitiva('t1', 'emp-1', {});
    expect(result.breakdown.salarioCubierto).toBe(true);
    expect(result.periodo).toMatchObject({ start_date: '2026-10-15', end_date: '2026-10-15', excludes_salary: true });
    expect(result.liquidation.devengados.basico.sueldoTrabajado).toBe(0);
    expect(result.breakdown.notasLimitaciones.join(' ')).toMatch(/no incluye salario/);
  });

  test('descuenta la prima ya pagada del valor que se paga en la liquidación', async () => {
    const retiro = { ...employee, termination_date: '2026-12-28' };
    mock.employeeFindOne.mockResolvedValue(retiro);
    mock.docFindOne.mockResolvedValue({ period: { end_date: '2026-12-28' } });
    mock.docFindAll.mockResolvedValue([docWith('2026-12-20', 'mensual', { pago: 1500000 })]);
    const result = await service.previewLiquidacionDefinitiva('t1', 'emp-1', {});
    const prima = result.breakdown.prima;
    expect(prima.yaPagada).toBe(1500000);
    expect(prima.prima).toBe(Math.max(0, prima.primaCausada - 1500000));
    const novedadPrima = result.breakdown.novedades.find((n) => n.dian_category === 'Primas');
    expect(novedadPrima ? novedadPrima.payload.pago : 0).toBe(prima.prima);
  });
});

describe('emisión: secuencia obligatoria', () => {
  test('con un período normal pendiente no crea ni emite la liquidación', async () => {
    mock.employeeFindOne.mockResolvedValue(employee);
    mock.periodFindOne.mockResolvedValue(null);
    mock.periodFindAll.mockResolvedValue([{ id: 'p10', period_type: 'mensual', branch_id: null, start_date: '2026-10-01', end_date: '2026-10-31', status: 'abierto' }]);
    await expect(service.emitirLiquidacionDefinitiva('t1', 'emp-1', 'u1')).rejects.toThrow(/Antes de emitir la liquidación definitiva.*2026-10-01 a 2026-10-31/);
    expect(mock.periodCreate).not.toHaveBeenCalled();
    expect(mock.emitir).not.toHaveBeenCalled();
  });

  test('con la nómina pagada crea el período enlazado al empleado y sin salario', async () => {
    mock.employeeFindOne.mockResolvedValue(employee);
    mock.periodFindOne.mockResolvedValue(null);
    mock.docFindOne.mockResolvedValue({ period: { end_date: '2026-10-15' } });
    const periodo = { id: 'liq-1', status: 'abierto', update: jest.fn() };
    mock.periodCreate.mockResolvedValue(periodo);
    mock.emitir.mockResolvedValue({ accepted: false, error: 'rechazado en la prueba' });

    await service.emitirLiquidacionDefinitiva('t1', 'emp-1', 'u1').catch(() => {});

    const creado = mock.periodCreate.mock.calls[0]?.[0];
    expect(creado).toMatchObject({
      employee_id: 'emp-1', period_type: 'liquidacion', start_date: '2026-10-15', end_date: '2026-10-15', excludes_salary: true,
    });
  });
});
