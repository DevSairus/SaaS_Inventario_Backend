// Conciliación fiscal e impuesto diferido con un libro simulado.
jest.mock('../config/database', () => ({ sequelize: { query: jest.fn() } }));
jest.mock('../config/tenantContext', () => ({ getCurrentSchema: () => 'tenant_x' }));
jest.mock('../services/accounting/niifStatements.service', () => ({
  loadAccounts: jest.fn(), sumsByAccount: jest.fn(), comprehensiveIncome: jest.fn(),
}));
jest.mock('../services/accounting/fixedAssetFiscal.service', () => ({ fiscalReport: jest.fn() }));
jest.mock('../controllers/accounting/agingReport.controller', () => ({ fetchAging: jest.fn() }));

const { sequelize } = require('../config/database');
const stmts = require('../services/accounting/niifStatements.service');
const { fiscalReport } = require('../services/accounting/fixedAssetFiscal.service');
const { fetchAging } = require('../controllers/accounting/agingReport.controller');
const svc = require('../services/accounting/fiscalReconciliation.service');

const ACC = [
  ['cli', '130505', 'activo', 'deudores_comerciales'],
  ['det', '139905', 'activo', 'deudores_comerciales'],
  ['inv', '143501', 'activo', 'inventarios'],
  ['vnr', '149905', 'activo', 'inventarios'],
  ['ppe', '1524', 'activo', 'ppe'],
  ['usd', '111010', 'activo', 'efectivo'],
  ['prov', '269595', 'pasivo', 'provisiones_corrientes'],
  ['renta', '261505', 'pasivo', 'provisiones_corrientes'], // 2615: obligación fiscal, no se ajusta
];
const accounts = new Map(ACC.map(([id, code, account_type, rubro]) => [id, { id, code, name: code, account_type, rubro }]));

// Saldos por año (débito/crédito acumulados al 31-dic).
const BAL = {
  2025: { cli: [1000, 0], det: [0, 100], inv: [5000, 0], vnr: [0, 0], ppe: [3000, 0], usd: [4000, 0], prov: [0, 0], renta: [0, 0] },
  2026: { cli: [2000, 0], det: [0, 600], inv: [5000, 0], vnr: [0, 300], ppe: [3000, 0], usd: [4500, 0], prov: [0, 800], renta: [0, 900] },
};

let settingsByYear;
let manualByYear;
let profile;
beforeEach(() => {
  settingsByYear = { 2025: {}, 2026: { tax_rate: 35, tax_losses: 0, recognize_dta: true } };
  manualByYear = { 2025: [], 2026: [] };
  profile = { business_config: {}, tax_config: {} };
  stmts.loadAccounts.mockResolvedValue(accounts);
  stmts.sumsByAccount.mockImplementation(async (t, { to }) => {
    const y = Number(to.slice(0, 4));
    return new Map(Object.entries(BAL[y] || {}).map(([id, [debit, credit]]) => [id, { debit, credit }]));
  });
  stmts.comprehensiveIncome.mockResolvedValue({ totals: { current: { resultado_antes_impuestos: 10000, impuesto_ganancias: 0 } } });
  // PPE: el libro fiscal deja el valor fiscal 200 por encima (depreciación contable > tope fiscal) en 2026.
  fiscalReport.mockImplementation(async (t, year) => ({ totals: { temporary_difference: year === 2026 ? 200 : 0 } }));
  // Cartera: 2026 → una factura con 400 días (15% general), otra con 100 días (5%).
  fetchAging.mockImplementation(async ({ query }) => (query.as_of.startsWith('2026')
    ? { third_parties: [{ detail: [{ amount: 1000, days_open: 400 }, { amount: 1000, days_open: 100 }] }] }
    : { third_parties: [{ detail: [{ amount: 1000, days_open: 50 }] }] }));
  sequelize.query.mockImplementation(async (sql, { replacements = {} } = {}) => {
    if (sql.includes('fiscal_reconciliation_settings')) return [{ settings: settingsByYear[replacements.year] || {} }];
    if (sql.includes('fiscal_adjustments')) return manualByYear[replacements.year] || [];
    if (sql.includes('account_mappings')) {
      const map = { receivable_impairment_allowance: 'det', inventory_nrv_allowance: 'vnr' };
      return map[replacements.eventType] ? [{ account_id: map[replacements.eventType] }] : [];
    }
    if (sql.includes("source_type = 'niif_fx_remeasurement'")) {
      // 2026: ganancia de 500 en la cuenta USD (sigue con saldo) y pérdida de
      // 300 en un proveedor del exterior que ya se pagó (saldo cero).
      return replacements.cutoff.startsWith('2026')
        ? [{ account_id: 'usd', third_party_id: null, net_debit: 500 }, { account_id: 'cxp', third_party_id: 'p9', net_debit: -300 }]
        : [];
    }
    if (sql.includes('AS balance')) {
      const y = Number(replacements.cutoff.slice(0, 4));
      const b = (BAL[y] || {})[replacements.accountId];
      return [{ balance: b ? b[0] - b[1] : 0 }];
    }
    if (sql.includes('"public"."tenants"')) return [profile];
    throw new Error(`SQL no esperado: ${sql.slice(0, 80)}`);
  });
});

const adj = (esf, key) => esf.adjustments.find((a) => a.key === key)?.amount;

describe('conciliación fiscal', () => {
  test('provisión fiscal de cartera por método', () => {
    expect(svc.fiscalReceivablePct('general', 90)).toBe(0);
    expect(svc.fiscalReceivablePct('general', 91)).toBe(5);
    expect(svc.fiscalReceivablePct('general', 181)).toBe(10);
    expect(svc.fiscalReceivablePct('general', 361)).toBe(15);
    expect(svc.fiscalReceivablePct('individual', 361)).toBe(33);
    expect(svc.fiscalReceivablePct('individual', 300)).toBe(0);
    expect(svc.fiscalReceivablePct('none', 1000)).toBe(0);
  });

  test('parámetros validados', () => {
    expect(svc.normalizeSettings({}).tax_rate).toBe(35);
    expect(() => svc.normalizeSettings({ receivable_method: 'x' })).toThrow();
    expect(() => svc.normalizeSettings({ tax_rate: 120 })).toThrow();
  });

  test('patrimonial: ajustes automáticos y totales', async () => {
    const esf = await svc.esfReconciliation('t', '2026-12-31');
    expect(adj(esf, 'auto:ppe')).toBe(200);
    // Deterioro NIIF 600; provisión fiscal 1000×15% + 1000×5% = 200 → valor fiscal de la cartera sube 400.
    expect(adj(esf, 'auto:cartera')).toBe(400);
    expect(adj(esf, 'auto:vnr')).toBe(300);
    expect(adj(esf, 'auto:prov:prov')).toBe(-800);
    expect(adj(esf, 'auto:prov:renta')).toBeUndefined(); // 2615 no se ajusta
    expect(adj(esf, 'auto:fx:usd:')).toBe(-500);
    // El proveedor ya pagado: la diferencia se realizó, no queda ajuste.
    expect(esf.adjustments.some((a) => a.key.startsWith('auto:fx:cxp'))).toBe(false);
    const deudores = esf.rubros.find((r) => r.code === 'deudores_comerciales');
    expect(deudores.book).toBe(1400);
    expect(deudores.fiscal).toBe(1800);
    // Activo: 200 + 400 + 300 − 500 = 400; pasivo: −800 → patrimonio fiscal +1200.
    expect(esf.totals.adjustment).toEqual({ activo: 400, pasivo: -800, patrimonio: 1200 });
  });

  test('renta líquida: resultado + variación de temporarias + permanentes', async () => {
    manualByYear[2026] = [{ id: 'm1', statement: 'eri', difference_type: 'permanente', amount: 150, description: 'Multas' }];
    settingsByYear[2026].tax_losses = 1000;
    const eri = await svc.eriReconciliation('t', 2026);
    const effect = (prefix) => eri.temporary.find((t) => t.key.startsWith(prefix))?.effect;
    expect(effect('auto:ppe')).toBe(200); // depreciación contable no deducible aún
    // Cartera: 2025 deterioro 100 vs fiscal 0 (50 días) → +100; 2026 → +400: variación +300.
    expect(effect('auto:cartera')).toBe(300);
    expect(effect('auto:vnr')).toBe(300);
    expect(effect('auto:prov:prov')).toBe(800); // pasivo: provisión no deducible suma
    expect(effect('auto:fx:usd')).toBe(-500); // ganancia no realizada no gravada
    expect(eri.totals.temporary).toBe(1100);
    expect(eri.totals.permanent).toBe(150);
    expect(eri.totals.renta_liquida).toBe(11250);
    expect(eri.totals.compensacion_perdidas).toBe(1000);
    expect(eri.totals.renta_liquida_gravable).toBe(10250);
    expect(eri.totals.impuesto_estimado).toBe(3587.5);
  });

  test('impuesto diferido: activo por deducibles, pasivo por imponibles', async () => {
    const dt = await svc.deferredTax('t', '2026-12-31');
    // Deducibles: ppe 200 + cartera 400 + vnr 300 + provisión 800 = 1700 → 595. Imponible: fx 500 → 175.
    expect(dt.dta).toBe(595);
    expect(dt.dtl).toBe(175);
  });

  test('sin renta futura probable el activo diferido se limita al pasivo', async () => {
    settingsByYear[2026].recognize_dta = false;
    const dt = await svc.deferredTax('t', '2026-12-31');
    expect(dt.dta_gross).toBe(595);
    expect(dt.dta).toBe(175);
  });

  test('régimen SIMPLE y Grupo 3 no tienen impuesto diferido', async () => {
    profile = { business_config: {}, tax_config: { fiscal_profile: { regime: 'simple' } } };
    await expect(svc.deferredTax('t', '2026-12-31')).rejects.toMatchObject({ statusCode: 400 });
    profile = { business_config: { niif_group: '3' }, tax_config: {} };
    await expect(svc.deferredTax('t', '2026-12-31')).rejects.toMatchObject({ statusCode: 400 });
  });
});
