// 6.1 — Flujograma de nómina: validaciones previas, etapas y responsables.
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models', () => ({}));

const { evaluateChecks, buildStages, blockingErrors, STAGES } = require('../services/payroll/payrollWorkflow.service');

const period = { id: 'p1', status: 'abierto', period_type: 'mensual', start_date: '2026-11-01', end_date: '2026-11-30' };
const emp = (o = {}) => ({ id: 'e1', first_name: 'Ana', first_surname: 'Pérez', document_number: '123', base_salary: 2000000, eps_supplier_id: 's1', pension_fund_supplier_id: 's2', ...o });
const settings = { arl_supplier_id: 'a', ccf_supplier_id: 'b', sena_supplier_id: 'c', icbf_supplier_id: 'd' };
const mapped = new Set(['payroll_net_payable', 'payroll_expense:basico']);
const run = (o = {}) => evaluateChecks({ period, employees: [emp()], novedades: [], settings, mappedKeys: mapped, ...o });
const levels = (checks) => checks.map((c) => `${c.key}:${c.level}`);

describe('evaluateChecks', () => {
  test('período limpio: todo ok y nada bloquea', () => {
    const c = run();
    expect(c.novedades[0].level).toBe('ok');
    expect(c.empleados[0].level).toBe('ok');
    expect(c.seguridad_social[0].level).toBe('ok');
    expect(blockingErrors(c, 'liquidado')).toEqual([]);
    expect(blockingErrors(c, 'emitido')).toEqual([]);
  });

  test('sin empleados, sin documento o sin salario son errores que bloquean', () => {
    expect(levels(run({ employees: [] }).empleados)).toContain('sin_empleados:error');
    const c = run({ employees: [emp({ document_number: ' ' }), emp({ id: 'e2', base_salary: 0 })] });
    expect(levels(c.empleados)).toEqual(expect.arrayContaining(['sin_documento:error', 'sin_salario:error']));
    expect(blockingErrors(c, 'liquidado').length).toBe(2);
    expect(blockingErrors(c, 'emitido').length).toBe(2);
    expect(blockingErrors(c, 'cerrado')).toEqual([]);
  });

  test('sin EPS/pensión/fondos solo avisa (no bloquea)', () => {
    const c = run({ employees: [emp({ eps_supplier_id: null, pension_fund_supplier_id: null })], settings: { ...settings, arl_supplier_id: null } });
    expect(levels(c.seguridad_social)).toEqual(expect.arrayContaining(['sin_eps:warning', 'sin_pension:warning', 'aportes_sin_fondo:warning']));
    expect(c.seguridad_social.find((x) => x.key === 'aportes_sin_fondo').items).toEqual(['ARL']);
    expect(blockingErrors(c, 'liquidado')).toEqual([]);
  });

  test('pensionado sin fondo de pensiones no genera aviso', () => {
    expect(levels(run({ employees: [emp({ pension_fund_supplier_id: null, is_pensioned: true })] }).seguridad_social)).not.toContain('sin_pension:warning');
  });

  test('contrato vencido avisa', () => {
    expect(levels(run({ employees: [emp({ contract_end_date: '2026-10-15' })] }).empleados)).toContain('contrato_vencido:warning');
  });

  test('novedades de quien no entra al período, vacaciones sin agregar y retiros sin liquidar avisan', () => {
    const c = run({
      novedades: [{ employee_id: 'otro' }, { employee_id: 'e1' }],
      unattachedVacations: [{ doc_number: 7 }],
      pendingTerminations: [emp({ id: 'e9', first_name: 'Luis' })],
    });
    expect(levels(c.novedades)).toEqual(expect.arrayContaining(['novedades_sin_empleado:warning', 'vacaciones_sin_agregar:warning', 'retiros_sin_liquidar:warning']));
    expect(c.novedades.find((x) => x.key === 'vacaciones_sin_agregar').items).toEqual(['VAC-7']);
  });

  test('mapeos contables faltantes avisan en la etapa de emisión', () => {
    const c = run({ mappedKeys: new Set(['payroll_net_payable']) });
    expect(c.emision[0]).toMatchObject({ key: 'mapeos_contables', level: 'warning', items: ['payroll_expense:basico'] });
  });
});

describe('buildStages', () => {
  const events = [
    { event_type: 'status_change', to_status: 'liquidado', user_name: 'Sergio', created_at: '2026-11-30T10:00:00Z' },
    { event_type: 'advance_blocked', to_status: 'emitido', user_name: 'Sergio', created_at: '2026-11-30T11:00:00Z' },
  ];

  test('tiene las seis etapas en orden', () => {
    expect(STAGES.map((s) => s.key)).toEqual(['novedades', 'empleados', 'seguridad_social', 'liquidacion', 'emision', 'cierre']);
  });

  test('período abierto: preparación abierta, liquidación es la etapa actual', () => {
    const s = buildStages({ period, checks: run(), events: [] });
    expect(s.map((x) => x.state)).toEqual(['open', 'open', 'open', 'current', 'pending', 'pending']);
  });

  test('período liquidado: la preparación y la liquidación quedan hechas con su responsable; emisión es la actual', () => {
    const s = buildStages({ period: { ...period, status: 'liquidado' }, checks: run(), events });
    expect(s.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'current', 'pending']);
    expect(s[3]).toMatchObject({ responsible: 'Sergio', completed_at: '2026-11-30T10:00:00Z' });
  });

  test('un intento bloqueado no cuenta como etapa cumplida', () => {
    const s = buildStages({ period: { ...period, status: 'liquidado' }, checks: run(), events });
    expect(s[4].responsible).toBeNull();
  });

  test('período cerrado: todo hecho', () => {
    expect(buildStages({ period: { ...period, status: 'cerrado' }, checks: run(), events }).every((x) => x.state === 'done')).toBe(true);
  });

  test('la validación de cada etapa es la peor de sus verificaciones', () => {
    const s = buildStages({ period, checks: run({ employees: [emp({ base_salary: 0 })] }), events: [] });
    expect(s.find((x) => x.key === 'empleados').validation).toBe('error');
    expect(s.find((x) => x.key === 'novedades').validation).toBe('ok');
  });
});
