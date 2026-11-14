// 6.5 — Liquidación de vacaciones fuera de período.
const mockSettlementFindOne = jest.fn();
const mockPeriodFindOne = jest.fn();
const mockNovedadCreate = jest.fn();
const mockNovedadDestroy = jest.fn();
const mockEntryFindOne = jest.fn();
const mockReverse = jest.fn();

const mockTx = { finished: false, commit: jest.fn(async () => { mockTx.finished = true; }), rollback: jest.fn(async () => { mockTx.finished = true; }), LOCK: { UPDATE: 'UPDATE' } };
jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn(async () => { mockTx.finished = false; return mockTx; }) } }));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/payroll/payrollService', () => ({ PAYROLL_CONSTANTS: { DIAS_MES_COMERCIAL: 30 }, diasComerciales: (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5) + 1 }));
jest.mock('../services/accounting/journalEntry.service', () => ({ reverseEntry: (...a) => mockReverse(...a) }));
jest.mock('../models', () => ({
  PayrollVacationSettlement: { findOne: (...a) => mockSettlementFindOne(...a) },
  PayrollPeriod: { findOne: (...a) => mockPeriodFindOne(...a) },
  PayrollNovedad: { create: (...a) => mockNovedadCreate(...a), destroy: (...a) => mockNovedadDestroy(...a) },
  JournalEntry: { findOne: (...a) => mockEntryFindOne(...a) },
}));

const svc = require('../services/payroll/payrollVacationService');
const { computeVacationBook } = require('../services/payroll/vacationBook.service');

const employee = { id: 'e1', is_active: true, hire_date: '2024-01-01', termination_date: null, base_salary: 3000000 };
const book = { disponibles: 15, saldo_inicial: 0, causados: 20, compensados: 0 };

describe('calculateSettlement', () => {
  test('valor del día = base/30; total = disfrutadas + compensadas', () => {
    expect(svc.calculateSettlement({ baseSalary: 3000000, daysEnjoyed: 10, daysCompensated: 2 })).toMatchObject({
      daily_value: 100000, value_enjoyed: 1000000, value_compensated: 200000, total_value: 1200000,
    });
  });
  test('la base alterna (con promedio de variables) reemplaza al básico', () => {
    expect(svc.calculateSettlement({ baseSalary: 3000000, baseOverride: 3300000, daysEnjoyed: 15 })).toMatchObject({ daily_value: 110000, total_value: 1650000 });
  });
});

describe('validateSettlement', () => {
  const ok = { days_enjoyed: 10, days_compensated: 0, start_date: '2026-12-01', end_date: '2026-12-15' };
  test('caso válido no lanza', () => expect(() => svc.validateSettlement({ employee, input: ok, book })).not.toThrow());
  test('sin días se rechaza', () => expect(() => svc.validateSettlement({ employee, input: { days_enjoyed: 0, days_compensated: 0 }, book })).toThrow(/Indique los días/));
  test('más de los disponibles se rechaza', () => expect(() => svc.validateSettlement({ employee, input: { ...ok, days_enjoyed: 16 }, book })).toThrow(/disponible/));
  test('compensar más de la mitad se rechaza (art. 189)', () => {
    expect(() => svc.validateSettlement({ employee, input: { days_enjoyed: 0, days_compensated: 11 }, book: { ...book, disponibles: 20, causados: 20 } })).toThrow(/mitad/);
    expect(() => svc.validateSettlement({ employee, input: { days_enjoyed: 0, days_compensated: 10 }, book: { ...book, disponibles: 20, causados: 20 } })).not.toThrow();
  });
  test('disfrutadas exigen fechas coherentes', () => {
    expect(() => svc.validateSettlement({ employee, input: { ...ok, start_date: undefined }, book })).toThrow(/primer y el último/);
    expect(() => svc.validateSettlement({ employee, input: { ...ok, end_date: '2026-11-01' }, book })).toThrow(/anterior/);
  });
  test('empleado retirado va por la liquidación definitiva', () => {
    expect(() => svc.validateSettlement({ employee: { ...employee, termination_date: '2026-12-31' }, input: ok, book })).toThrow(/liquidación definitiva/);
  });
});

describe('libro de vacaciones', () => {
  const settlement = { status: 'pagada', payroll_period_id: null, doc_number: 7, days_enjoyed: 10, value_enjoyed: 1000000, days_compensated: 2, value_compensated: 200000, start_date: '2026-12-01', end_date: '2026-12-14', payment_date: '2026-11-28' };

  test('una liquidación pagada sin período descuenta días del libro', () => {
    const emp = { hire_date: '2025-01-01', base_salary: 3000000 };
    const sin = computeVacationBook(emp, [], '2026-01-01');
    const con = computeVacationBook(emp, svc.settlementsAsNovedades([settlement]), '2026-01-01');
    expect(sin.disponibles - con.disponibles).toBeCloseTo(12, 1);
    expect(con.disfrutados).toBe(10);
    expect(con.compensados).toBe(2);
  });
  test('absorbida por un período, borrador o anulada no se cuenta aparte (ya está en novedades o no existe)', () => {
    expect(svc.settlementsAsNovedades([{ ...settlement, payroll_period_id: 'p1' }, { ...settlement, status: 'borrador' }, { ...settlement, status: 'anulada' }])).toEqual([]);
  });
});

describe('buildPeriodNovedades', () => {
  test('devengado de Vacaciones + descuento del anticipo por el total', () => {
    const [vac, anticipo] = svc.buildPeriodNovedades({ doc_number: 7, days_enjoyed: 10, value_enjoyed: 1000000, days_compensated: 2, value_compensated: 200000, total_value: 1200000, start_date: '2026-12-01', end_date: '2026-12-14', payment_date: '2026-12-01' });
    expect(vac.dian_category).toBe('Vacaciones');
    expect(vac.payload.comunes[0]).toMatchObject({ cantidad: 10, pago: 1000000, fechaInicio: '2026-12-01' });
    expect(vac.payload.compensadas[0]).toMatchObject({ cantidad: 2, pago: 200000 });
    expect(anticipo).toMatchObject({ dian_category: 'AnticiposDeducciones', payload: 1200000 });
  });
  test('solo compensadas no genera arreglo de disfrutadas', () => {
    const [vac] = svc.buildPeriodNovedades({ doc_number: 8, days_enjoyed: 0, days_compensated: 5, value_compensated: 500000, total_value: 500000, payment_date: '2026-12-01' });
    expect(vac.payload.comunes).toEqual([]);
  });
});

describe('attachToPeriod / voidSettlement', () => {
  const paid = () => ({
    id: 's1', employee_id: 'e1', status: 'pagada', doc_number: 7, payroll_period_id: null, payment_date: '2026-12-05', total_value: 1200000,
    days_enjoyed: 10, value_enjoyed: 1000000, days_compensated: 2, value_compensated: 200000, start_date: '2026-12-01', end_date: '2026-12-14',
    novedad_ids: [], journal_entry_id: 'j1', update: jest.fn(),
  });
  beforeEach(() => { jest.clearAllMocks(); mockNovedadCreate.mockImplementation(async () => ({ id: `n${mockNovedadCreate.mock.calls.length}` })); });

  test('crea las dos novedades y enlaza el período', async () => {
    const s = paid();
    mockSettlementFindOne.mockResolvedValue(s);
    mockPeriodFindOne.mockResolvedValue({ id: 'p1', status: 'abierto', period_type: 'mensual', start_date: '2026-12-01', end_date: '2026-12-31' });
    await svc.attachToPeriod('t1', 's1', 'p1', 'u1');
    expect(mockNovedadCreate).toHaveBeenCalledTimes(2);
    expect(s.update).toHaveBeenCalledWith({ payroll_period_id: 'p1', novedad_ids: ['n1', 'n2'] }, expect.anything());
  });
  test('rechaza período cerrado, de liquidación o que no contiene la fecha de pago', async () => {
    mockSettlementFindOne.mockResolvedValue(paid());
    mockPeriodFindOne.mockResolvedValue({ id: 'p1', status: 'emitido', period_type: 'mensual', start_date: '2026-12-01', end_date: '2026-12-31' });
    await expect(svc.attachToPeriod('t1', 's1', 'p1')).rejects.toMatchObject({ statusCode: 409 });
    mockPeriodFindOne.mockResolvedValue({ id: 'p1', status: 'abierto', period_type: 'liquidacion', start_date: '2026-12-01', end_date: '2026-12-31' });
    await expect(svc.attachToPeriod('t1', 's1', 'p1')).rejects.toThrow(/liquidación definitiva/);
    mockPeriodFindOne.mockResolvedValue({ id: 'p2', status: 'abierto', period_type: 'mensual', start_date: '2027-01-01', end_date: '2027-01-31' });
    await expect(svc.attachToPeriod('t1', 's1', 'p2')).rejects.toThrow(/no cae dentro/);
    expect(mockNovedadCreate).not.toHaveBeenCalled();
  });
  test('no se absorbe dos veces ni un borrador', async () => {
    mockSettlementFindOne.mockResolvedValue({ ...paid(), payroll_period_id: 'p1' });
    await expect(svc.attachToPeriod('t1', 's1', 'p9')).rejects.toMatchObject({ statusCode: 409 });
    mockSettlementFindOne.mockResolvedValue({ ...paid(), status: 'borrador' });
    await expect(svc.attachToPeriod('t1', 's1', 'p9')).rejects.toMatchObject({ statusCode: 409 });
  });
  test('anular exige motivo, retira las novedades y reversa el asiento', async () => {
    const s = { ...paid(), payroll_period_id: 'p1', novedad_ids: ['n1', 'n2'] };
    mockSettlementFindOne.mockResolvedValue(s);
    mockPeriodFindOne.mockResolvedValue({ id: 'p1', status: 'abierto' });
    mockEntryFindOne.mockResolvedValue({ id: 'j1', status: 'posted', reversed_by_entry_id: null });
    await expect(svc.voidSettlement('t1', 's1', '  ', 'u1')).rejects.toThrow(/motivo/);
    await svc.voidSettlement('t1', 's1', 'Error de fechas', 'u1');
    expect(mockNovedadDestroy).toHaveBeenCalled();
    expect(mockReverse).toHaveBeenCalledWith('j1', 't1', 'u1', expect.stringContaining('VAC-7'), mockTx);
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'anulada', payroll_period_id: null }), expect.anything());
  });
  test('no se anula si el período ya está emitido', async () => {
    mockSettlementFindOne.mockResolvedValue({ ...paid(), payroll_period_id: 'p1' });
    mockPeriodFindOne.mockResolvedValue({ id: 'p1', status: 'emitido' });
    await expect(svc.voidSettlement('t1', 's1', 'x', 'u1')).rejects.toMatchObject({ statusCode: 409 });
    expect(mockReverse).not.toHaveBeenCalled();
  });
});
