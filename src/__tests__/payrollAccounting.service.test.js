// Tests de los comprobantes contables de nómina. Se aísla de la base de
// datos: lo que se verifica es el cálculo de aportes/provisiones y que los
// asientos cuadren, lleven el tercero correcto y respeten la configuración.
jest.mock('../config/database', () => ({
  sequelize: {
    transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn(), finished: false, LOCK: { UPDATE: 'UPDATE' } })),
    literal: jest.fn((x) => x),
  },
}));

jest.mock('../models', () => ({
  AccountMapping: { findAll: jest.fn() },
  PayrollSetting: { findOrCreate: jest.fn() },
  Supplier: { findAll: jest.fn() },
  JournalEntry: { findAll: jest.fn() },
  JournalEntryLine: { findOne: jest.fn() },
}));

jest.mock('../services/accounting/journalEntry.service', () => ({
  createDraftEntry: jest.fn(async (tenantId, data) => ({ id: `entry-${data.sourceType}`, entry_number: 'AST-1', ...data })),
  reverseEntry: jest.fn(),
}));

const models = require('../models');
const { createDraftEntry } = require('../services/accounting/journalEntry.service');
const svc = require('../services/payroll/payrollAccountingService');
const { liquidarEmpleado, PAYROLL_CONSTANTS } = require('../services/payroll/payrollService');
const { DEFAULT_ACCOUNT_MAPPINGS } = require('../data/puc-colombia-standard');

const baseSettings = {
  accounting_voucher_mode: 'single',
  cesantias_accrual_mode: 'monthly',
  prima_accrual_mode: 'monthly',
  vacaciones_accrual_mode: 'monthly',
  employer_exonerated_114_1: false,
  arl_supplier_id: 'sup-arl',
  ccf_supplier_id: 'sup-ccf',
  sena_supplier_id: 'sup-sena',
  icbf_supplier_id: 'sup-icbf',
};

const period = { id: 'period-1', branch_id: null, period_type: 'mensual', start_date: '2026-09-01', end_date: '2026-09-30', payment_date: '2026-09-30' };

const makeEmployee = (overrides = {}) => ({
  id: 'emp-1',
  first_name: 'Ana',
  first_surname: 'Pérez',
  document_number: '1017123456',
  base_salary: 2000000,
  salary_type: 'ordinario',
  worker_type: '01',
  transport_allowance_eligible: true,
  hire_date: '2025-01-01',
  termination_date: null,
  high_risk_pension: false,
  arl_risk_class: 1,
  eps_supplier_id: 'sup-eps',
  pension_fund_supplier_id: 'sup-afp',
  severance_fund_supplier_id: 'sup-ces',
  ...overrides,
});

const liquidar = (employee, novedades = []) => liquidarEmpleado({ employee, period, novedades, softwareSecurityCode: null });

const sum = (lines, field) => Math.round(lines.reduce((s, l) => s + Number(l[field] || 0), 0) * 100) / 100;
const acc = (key) => `acc:${DEFAULT_ACCOUNT_MAPPINGS[key]}`;

beforeEach(() => {
  jest.clearAllMocks();
  // Mapeos = los de fábrica, con account_id legible por código.
  models.AccountMapping.findAll.mockResolvedValue(
    Object.entries(DEFAULT_ACCOUNT_MAPPINGS)
      .filter(([k]) => k.startsWith('payroll'))
      .map(([event_type, code]) => ({ event_type, account_id: `acc:${code}` }))
  );
  models.Supplier.findAll.mockResolvedValue([{ id: 'sup-eps', name: 'EPS Sura' }, { id: 'sup-afp', name: 'Porvenir' }]);
  models.JournalEntry.findAll.mockResolvedValue([]);
  models.JournalEntryLine.findOne.mockResolvedValue({ saldo: 0 });
});

describe('calcularAportesYProvisiones', () => {
  const employee = makeEmployee();
  const liquidation = liquidar(employee);

  it('calcula aportes del empleador sobre el IBC', () => {
    const { aportes } = svc.calcularAportesYProvisiones({ employee, liquidation, settings: baseSettings });
    expect(aportes).toEqual({ eps: 170000, pension: 240000, arl: 10440, ccf: 80000, sena: 40000, icbf: 60000 });
  });

  it('la comisión salarial integra el IBC del empleado y del empleador; la no salarial no', () => {
    const conComision = liquidar(employee, [{ dian_category: 'Comisiones', payload: 500000 }]);
    expect(conComision.deducciones.salud.deduccion).toBeCloseTo(100000, 2);
    expect(svc.calcularAportesYProvisiones({ employee, liquidation: conComision, settings: baseSettings }).ibc).toBeCloseTo(2500000, 2);

    const noSalarial = liquidar(employee, [{ dian_category: 'Bonificaciones', payload: { bonificacionNS: 500000 } }]);
    expect(noSalarial.deducciones.salud.deduccion).toBeCloseTo(80000, 2);
    expect(svc.calcularAportesYProvisiones({ employee, liquidation: noSalarial, settings: baseSettings }).ibc).toBeCloseTo(2000000, 2);
  });

  it('con exoneración 114-1 no aporta salud, SENA ni ICBF', () => {
    const { aportes } = svc.calcularAportesYProvisiones({ employee, liquidation, settings: { ...baseSettings, employer_exonerated_114_1: true } });
    expect(aportes.eps).toBe(0);
    expect(aportes.sena).toBe(0);
    expect(aportes.icbf).toBe(0);
    expect(aportes.pension).toBe(240000);
  });

  it('la exoneración no aplica desde 10 SMLMV', () => {
    const rico = makeEmployee({ base_salary: PAYROLL_CONSTANTS.SMLMV * 10, transport_allowance_eligible: false });
    const { aportes } = svc.calcularAportesYProvisiones({ employee: rico, liquidation: liquidar(rico), settings: { ...baseSettings, employer_exonerated_114_1: true } });
    expect(aportes.eps).toBeGreaterThan(0);
  });

  it('provisiona cesantías y prima con auxilio de transporte, vacaciones sin él', () => {
    const { provisiones } = svc.calcularAportesYProvisiones({ employee, liquidation, settings: baseSettings });
    const prestacional = 2000000 + PAYROLL_CONSTANTS.AUXILIO_TRANSPORTE;
    expect(provisiones.cesantias).toBeCloseTo(prestacional / 12, 2);
    expect(provisiones.intereses_cesantias).toBeCloseTo(provisiones.cesantias * 0.12, 2);
    expect(provisiones.prima).toBeCloseTo(prestacional / 12, 2);
    expect(provisiones.vacaciones).toBeCloseTo(2000000 / 24, 2);
  });

  it('respeta los modos de causación configurados', () => {
    const { provisiones } = svc.calcularAportesYProvisiones({
      employee, liquidation,
      settings: { ...baseSettings, cesantias_accrual_mode: 'year_end', prima_accrual_mode: 'on_payment', vacaciones_accrual_mode: 'on_payment' },
    });
    expect(provisiones).toEqual({ cesantias: 0, intereses_cesantias: 0, prima: 0, vacaciones: 0 });
  });

  it('salario integral no causa cesantías ni prima, sí vacaciones', () => {
    const integral = makeEmployee({ salary_type: 'integral', base_salary: 30000000 });
    const { provisiones } = svc.calcularAportesYProvisiones({ employee: integral, liquidation: liquidar(integral), settings: baseSettings });
    expect(provisiones.cesantias).toBe(0);
    expect(provisiones.prima).toBe(0);
    expect(provisiones.vacaciones).toBeGreaterThan(0);
  });

  it('no provisiona en un periodo de liquidación definitiva', () => {
    const { provisiones } = svc.calcularAportesYProvisiones({ employee, liquidation, settings: baseSettings, isLiquidacion: true });
    expect(provisiones).toEqual({ cesantias: 0, intereses_cesantias: 0, prima: 0, vacaciones: 0 });
  });
});

describe('generarComprobantesNomina', () => {
  it('un solo comprobante cuadrado, con la cédula del empleado como tercero', async () => {
    models.PayrollSetting.findOrCreate.mockResolvedValue([baseSettings]);
    const employee = makeEmployee();
    const result = await svc.generarComprobantesNomina(period, [{ employee, liquidation: liquidar(employee) }], 'tenant-1', 'user-1');

    expect(createDraftEntry).toHaveBeenCalledTimes(1);
    const { lines, sourceType } = createDraftEntry.mock.calls[0][1];
    expect(sourceType).toBe('payroll');
    expect(sum(lines, 'debit')).toBeCloseTo(sum(lines, 'credit'), 2);

    // Devengados y neto por empleado
    const basico = lines.find((l) => l.account_id === acc('payroll_expense:basico'));
    expect(basico).toMatchObject({ debit: 2000000, third_party_id: 'emp-1' });
    const neto = lines.find((l) => l.account_id === acc('payroll_net_payable'));
    expect(neto.third_party_id).toBe('emp-1');
    expect(neto.credit).toBeCloseTo(2000000 + PAYROLL_CONSTANTS.AUXILIO_TRANSPORTE - 160000, 2);

    // Deducción de salud: tercero = EPS del empleado, empleado en la descripción
    const saludEmpleado = lines.find((l) => l.account_id === acc('payroll_social_security_payable') && l.description.startsWith('Salud (empleado)'));
    expect(saludEmpleado).toMatchObject({ credit: 80000, third_party_id: 'sup-eps' });
    expect(saludEmpleado.description).toContain('1017123456');

    // Aportes del empleador por fondo; provisiones por empleado
    const arl = lines.find((l) => l.account_id === acc('payroll_arl_payable'));
    expect(arl).toMatchObject({ credit: 10440, third_party_id: 'sup-arl' });
    const provPrima = lines.find((l) => l.account_id === acc('payroll_provision:prima'));
    expect(provPrima.third_party_id).toBe('emp-1');
    expect(result.warnings).toEqual([]);
  });

  it('modo split: comprobante de nómina y de aportes/provisiones por separado, cada uno cuadrado', async () => {
    models.PayrollSetting.findOrCreate.mockResolvedValue([{ ...baseSettings, accounting_voucher_mode: 'split' }]);
    const employee = makeEmployee();
    await svc.generarComprobantesNomina(period, [{ employee, liquidation: liquidar(employee) }], 'tenant-1', 'user-1');

    expect(createDraftEntry).toHaveBeenCalledTimes(2);
    const [nomina, aportes] = createDraftEntry.mock.calls.map((c) => c[1]);
    expect(nomina.sourceType).toBe('payroll');
    expect(aportes.sourceType).toBe('payroll_provisions');
    for (const { lines } of [nomina, aportes]) {
      expect(sum(lines, 'debit')).toBeCloseTo(sum(lines, 'credit'), 2);
    }
    expect(nomina.lines.some((l) => l.account_id === acc('payroll_employer:eps'))).toBe(false);
  });

  it('consolida los aportes de varios empleados por fondo de destino', async () => {
    models.PayrollSetting.findOrCreate.mockResolvedValue([baseSettings]);
    const a = makeEmployee();
    const b = makeEmployee({ id: 'emp-2', document_number: '222', eps_supplier_id: 'sup-eps' });
    await svc.generarComprobantesNomina(period, [{ employee: a, liquidation: liquidar(a) }, { employee: b, liquidation: liquidar(b) }], 'tenant-1', 'user-1');

    const { lines } = createDraftEntry.mock.calls[0][1];
    const gastoEps = lines.filter((l) => l.account_id === acc('payroll_employer:eps'));
    expect(gastoEps).toHaveLength(1);
    expect(gastoEps[0].debit).toBe(340000);
    const pensionEmpleador = lines.filter((l) => l.account_id === acc('payroll_pension_payable') && l.description.startsWith('Aportes'));
    expect(pensionEmpleador).toHaveLength(1);
    expect(pensionEmpleador[0]).toMatchObject({ credit: 480000, third_party_id: 'sup-afp' });
  });

  it('el pago de prima debita primero lo provisionado del empleado y el excedente va al gasto', async () => {
    models.PayrollSetting.findOrCreate.mockResolvedValue([baseSettings]);
    models.JournalEntryLine.findOne.mockResolvedValue({ saldo: 500000 });
    const employee = makeEmployee();
    const liquidation = liquidar(employee, [{ dian_category: 'Primas', payload: { cantidad: 180, pago: 1100000 } }]);
    await svc.generarComprobantesNomina(period, [{ employee, liquidation }], 'tenant-1', 'user-1');

    const { lines } = createDraftEntry.mock.calls[0][1];
    const { provisiones } = svc.calcularAportesYProvisiones({ employee, liquidation, settings: baseSettings });
    const disponible = 500000 + provisiones.prima;
    const contraPasivo = lines.find((l) => l.account_id === acc('payroll_provision:prima') && l.debit > 0);
    const alGasto = lines.find((l) => l.account_id === acc('payroll_expense:prima') && l.description.startsWith('Pago'));
    expect(contraPasivo.debit).toBeCloseTo(disponible, 2);
    expect(alGasto.debit).toBeCloseTo(1100000 - disponible, 2);
    expect(sum(lines, 'debit')).toBeCloseTo(sum(lines, 'credit'), 2);
  });

  it('avisa cuando el empleado no tiene EPS asignada', async () => {
    models.PayrollSetting.findOrCreate.mockResolvedValue([baseSettings]);
    const employee = makeEmployee({ eps_supplier_id: null });
    const { warnings } = await svc.generarComprobantesNomina(period, [{ employee, liquidation: liquidar(employee) }], 'tenant-1', 'user-1');
    expect(warnings.some((w) => w.includes('no tiene EPS'))).toBe(true);
  });

  it('no duplica si el periodo ya tiene comprobantes', async () => {
    models.JournalEntry.findAll.mockResolvedValue([{ id: 'ya-existe' }]);
    const employee = makeEmployee();
    const result = await svc.generarComprobantesNomina(period, [{ employee, liquidation: liquidar(employee) }], 'tenant-1', 'user-1');
    expect(result.alreadyExisted).toBe(true);
    expect(createDraftEntry).not.toHaveBeenCalled();
  });
});

describe('liquidacionVigente', () => {
  const original = { devengadosTotal: 100 };
  const reemplazo = { devengadosTotal: 150 };

  it('sin notas de ajuste usa la liquidación original', () => {
    expect(svc.liquidacionVigente({ snapshot_liquidation: original, adjustments: [] })).toBe(original);
  });

  it('ignora notas no aceptadas', () => {
    const doc = { snapshot_liquidation: original, adjustments: [{ dian_status: 'rejected', adjustment_type: 'replace', snapshot_liquidation: reemplazo }] };
    expect(svc.liquidacionVigente(doc)).toBe(original);
  });

  it('la última nota aceptada manda: Reemplazar usa su liquidación, Eliminar deja al empleado fuera', () => {
    const replace = { dian_status: 'accepted', adjustment_type: 'replace', snapshot_liquidation: reemplazo, dian_accepted_at: '2026-10-01T10:00:00Z' };
    const del = { dian_status: 'accepted', adjustment_type: 'delete', snapshot_liquidation: null, dian_accepted_at: '2026-10-02T10:00:00Z' };
    expect(svc.liquidacionVigente({ snapshot_liquidation: original, adjustments: [replace] })).toBe(reemplazo);
    expect(svc.liquidacionVigente({ snapshot_liquidation: original, adjustments: [del, replace] })).toBeNull();
  });
});
