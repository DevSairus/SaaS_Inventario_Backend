// Estados NIIF con un libro en memoria: el SQL de sumsByAccount se emula
// filtrando estas líneas (fecha, cierre anual incluido/excluido/solo).
jest.mock('../config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../config/tenantContext', () => ({ getCurrentSchema: () => 'tenant_x' }));

const { sequelize } = require('../config/database');
const svc = require('../services/accounting/niifStatements.service');

const ACCOUNTS = [
  ['caja', '110505', 'activo'], ['cli', '130505', 'activo'], ['det', '139905', 'activo'],
  ['ppe', '1524', 'activo'], ['dep', '1592', 'activo'],
  ['prov', '220505', 'pasivo'], ['banco_lp', '210505', 'pasivo', 'obligaciones_financieras_no_corrientes'],
  ['cap', '311505', 'patrimonio'], ['res', '360505', 'patrimonio'], ['acum', '370505', 'patrimonio'],
  ['ori', '383005', 'patrimonio'],
  ['ing', '413501', 'ingreso'], ['fin', '421005', 'ingreso'],
  ['cv', '613501', 'costo'], ['adm', '510506', 'gasto'], ['gdet', '519910', 'gasto'], ['int', '530505', 'gasto'], ['renta', '540505', 'gasto'],
].map(([id, code, account_type, niif_rubro = null]) => ({ id, code, name: code, account_type, parent_id: null, niif_rubro }));

// [fecha, source_type, [[cuenta, débito, crédito], ...]]
const ENTRIES = [
  ['2025-01-02', 'manual', [['caja', 10000, 0], ['cap', 0, 10000]]],
  ['2025-06-01', 'sale', [['cli', 5000, 0], ['ing', 0, 5000]]],
  ['2025-06-01', 'sale', [['cv', 2000, 0], ['caja', 0, 2000]]],
  ['2025-07-01', 'expense', [['adm', 1000, 0], ['caja', 0, 1000]]],
  // Cierre 2025: utilidad 2000 a 3605.
  ['2025-12-31', 'year_end_close', [['ing', 5000, 0], ['cv', 0, 2000], ['adm', 0, 1000], ['res', 0, 2000]]],
  // 2026
  ['2026-02-01', 'loan', [['caja', 8000, 0], ['banco_lp', 0, 8000]]],
  ['2026-02-02', 'purchase', [['ppe', 6000, 0], ['caja', 0, 6000]]],
  ['2026-03-01', 'sale', [['caja', 7000, 0], ['ing', 0, 7000]]],
  ['2026-03-01', 'sale', [['cv', 3000, 0], ['caja', 0, 3000]]],
  ['2026-03-15', 'payment', [['caja', 5000, 0], ['cli', 0, 5000]]],
  ['2026-04-01', 'fixed_asset_depreciation', [['adm', 500, 0], ['dep', 0, 500]]],
  ['2026-04-02', 'manual', [['gdet', 200, 0], ['det', 0, 200]]],
  ['2026-05-01', 'loan_payment', [['int', 300, 0], ['caja', 0, 300]]],
  ['2026-05-02', 'manual', [['caja', 100, 0], ['fin', 0, 100]]],
  ['2026-06-01', 'manual', [['renta', 900, 0], ['prov', 0, 900]]],
  ['2026-07-01', 'manual', [['ppe', 1000, 0], ['ori', 0, 1000]]], // revaluación a ORI
  ['2026-08-01', 'manual', [['acum', 500, 0], ['caja', 0, 500]]], // dividendos pagados
];

sequelize.query.mockImplementation(async (sql, { replacements }) => {
  if (sql.includes('chart_of_accounts')) return ACCOUNTS;
  const { from, to } = replacements;
  let close = 'include';
  if (sql.includes("source_type <> 'year_end_close'")) close = 'exclude';
  else if (sql.includes("source_type = 'year_end_close'")) close = 'only';
  const sums = new Map();
  for (const [date, type, lines] of ENTRIES) {
    if (from && date < from) continue;
    if (date > to) continue;
    if (close === 'exclude' && type === 'year_end_close') continue;
    if (close === 'only' && type !== 'year_end_close') continue;
    for (const [account_id, debit, credit] of lines) {
      const s = sums.get(account_id) || { account_id, debit: 0, credit: 0 };
      s.debit += debit; s.credit += credit;
      sums.set(account_id, s);
    }
  }
  return [...sums.values()];
});

const rubro = (esf, code) => esf.sections.flatMap((s) => s.rubros).find((r) => r.code === code);

describe('estados financieros NIIF', () => {
  test('situación financiera: corriente / no corriente, cuadra y compara', async () => {
    const esf = await svc.financialPosition('t', { as_of: '2026-11-30' });
    expect(esf.compare_as_of).toBe('2025-12-31');
    expect(esf.totals.current.cuadra).toBe(true);
    expect(esf.totals.prior.cuadra).toBe(true);
    // caja 2026: 7000 (2025) + 8000 - 6000 + 7000 - 3000 + 5000 - 300 + 100 - 500 = 17300
    expect(rubro(esf, 'efectivo').current).toBe(17300);
    expect(rubro(esf, 'efectivo').prior).toBe(7000);
    expect(rubro(esf, 'deudores_comerciales').current).toBe(-200); // clientes 0 - deterioro 200
    expect(rubro(esf, 'ppe').current).toBe(6500); // 6000 + 1000 reval - 500 dep
    expect(esf.sections.find((s) => s.code === 'pasivo_no_corriente').current).toBe(8000);
    // Resultado 2026 sin cierre: 7000+100 - 3000 - 500 - 200 - 300 - 900 = 2200
    expect(rubro(esf, 'resultado_ejercicio').current).toBe(2000 + 2200);
    expect(rubro(esf, 'resultado_ejercicio').prior).toBe(2000);
    expect(rubro(esf, 'ori_acumulado').current).toBe(1000);
    expect(rubro(esf, 'ganancias_acumuladas').current).toBe(-500);
  });

  test('resultado integral: el cierre anual no deja el año cerrado en cero', async () => {
    const eri = await svc.comprehensiveIncome('t', { from: '2026-01-01', to: '2026-12-31', compare_from: '2025-01-01', compare_to: '2025-12-31' });
    const t = eri.totals;
    expect(t.prior.resultado_periodo).toBe(2000); // 2025 cerrado, igual se ve
    expect(t.current.ganancia_bruta).toBe(4000);
    expect(t.current.resultado_operacional).toBe(3300); // 4000 - 500 - 200
    expect(t.current.ingresos_financieros).toBe(100);
    expect(t.current.costos_financieros).toBe(300);
    expect(t.current.resultado_antes_impuestos).toBe(3100);
    expect(t.current.impuesto_ganancias).toBe(900);
    expect(t.current.resultado_periodo).toBe(2200);
    expect(t.current.otro_resultado_integral).toBe(1000);
    expect(t.current.resultado_integral_total).toBe(3200);
  });

  test('cambios en el patrimonio: saldo final = patrimonio del ESF; cierre como traslado', async () => {
    const ecp = await svc.equityChanges('t', { from: '2025-01-01', to: '2025-12-31' });
    const row = (k) => ecp.rows.find((r) => r.key === k);
    expect(row('resultado_periodo').values.resultado_ejercicio).toBe(2000);
    expect(row('otros_movimientos').values.capital).toBe(10000);
    expect(row('cierre_ejercicio').total).toBe(0); // el cierre no cambia el patrimonio total
    expect(row('saldo_final').total).toBe(12000);

    const ecp26 = await svc.equityChanges('t', { from: '2026-01-01', to: '2026-11-30' });
    const r26 = (k) => ecp26.rows.find((r) => r.key === k);
    expect(r26('saldo_inicial').total).toBe(12000);
    expect(r26('resultado_periodo').total).toBe(2200);
    expect(r26('otro_resultado_integral').values.ori_acumulado).toBe(1000);
    expect(r26('otros_movimientos').values.ganancias_acumuladas).toBe(-500);
    const esf = await svc.financialPosition('t', { as_of: '2026-11-30' });
    expect(r26('saldo_final').total).toBe(esf.totals.current.patrimonio);
  });

  test('fechas inválidas -> 400', async () => {
    await expect(svc.comprehensiveIncome('t', { from: '2026-02-01', to: '2026-01-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.equityChanges('t', { from: 'x', to: '2026-01-01' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
