jest.mock('../config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../config/tenantContext', () => ({ getCurrentSchema: () => 'tenant_x' }));

const { normalizeMatrix, pctForDays, KINDS, allowanceLines, fxLines, deferredTaxLines } = require('../services/accounting/niifMeasurements.service');

const sum = (lines, k) => Math.round(lines.reduce((s, l) => s + Number(l[k] || 0), 0) * 100) / 100;

describe('mediciones NIIF', () => {
  test('matriz de deterioro: ordena, agrega tramo 0 y valida %', () => {
    const m = normalizeMatrix([{ from_days: 181, pct: 50 }, { from_days: 91, pct: 20 }]);
    expect(m).toEqual([{ from_days: 0, pct: 0 }, { from_days: 91, pct: 20 }, { from_days: 181, pct: 50 }]);
    expect(pctForDays(m, 0)).toBe(0);
    expect(pctForDays(m, 90)).toBe(0);
    expect(pctForDays(m, 91)).toBe(20);
    expect(pctForDays(m, 500)).toBe(50);
    expect(() => normalizeMatrix([{ from_days: 0, pct: 120 }])).toThrow(/entre 0 y 100/);
    expect(normalizeMatrix([]).length).toBeGreaterThan(1); // matriz por defecto
  });

  const accounts = {
    receivable_impairment_allowance: { id: 'allow' },
    receivable_impairment_expense: { id: 'exp' },
    receivable_impairment_recovery: { id: 'rec' },
  };

  test('provisión que sube: gasto contra la cuenta correctora', () => {
    const lines = allowanceLines({ cutoff_date: '2026-11-30', accounts, summary: { adjustment: 1500 } }, KINDS.receivable_impairment);
    expect(lines).toEqual([
      expect.objectContaining({ account_id: 'exp', debit: 1500, credit: 0 }),
      expect.objectContaining({ account_id: 'allow', debit: 0, credit: 1500 }),
    ]);
  });

  test('provisión que baja: recuperación (ingreso), no gasto negativo', () => {
    const lines = allowanceLines({ cutoff_date: '2026-11-30', accounts, summary: { adjustment: -400 } }, KINDS.receivable_impairment);
    expect(lines).toEqual([
      expect.objectContaining({ account_id: 'allow', debit: 400, credit: 0 }),
      expect.objectContaining({ account_id: 'rec', debit: 0, credit: 400 }),
    ]);
  });

  test('diferencia en cambio: cuadra y separa ganancia de pérdida', () => {
    const result = {
      cutoff_date: '2026-11-30',
      accounts: { fx_gain: { id: 'gain' }, fx_loss: { id: 'loss' } },
      summary: { gains: 300, losses: 120 },
      detail: [
        // banco USD sube 200 (ganancia), proveedor p1 sube 120 (pérdida), proveedor p2 baja 100 (ganancia)
        { account_id: 'bank', third_party_id: null, account_type: 'activo', difference: 200, label: 'Banco', currency: 'USD', foreign_amount: 10, rate: 4000 },
        { account_id: 'cxp', third_party_id: 'p1', account_type: 'pasivo', difference: -120, label: 'Prov', currency: 'USD', foreign_amount: 5, rate: 4000 },
        { account_id: 'cxp', third_party_id: 'p2', account_type: 'pasivo', difference: 100, label: 'Prov2', currency: 'USD', foreign_amount: 5, rate: 4000 },
        { account_id: 'x', account_type: 'activo', difference: null, label: 'Sin tasa' },
      ],
    };
    const lines = fxLines(result);
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    expect(lines.find((l) => l.account_id === 'bank')).toMatchObject({ debit: 200, credit: 0 });
    expect(lines.find((l) => l.third_party_id === 'p1')).toMatchObject({ debit: 0, credit: 120 });
    expect(lines.find((l) => l.third_party_id === 'p2')).toMatchObject({ debit: 100, credit: 0 });
    expect(lines.find((l) => l.account_id === 'gain')).toMatchObject({ credit: 300 });
    expect(lines.find((l) => l.account_id === 'loss')).toMatchObject({ debit: 120 });
    expect(lines.some((l) => l.account_id === 'x')).toBe(false);
  });

  test('impuesto diferido: activo y pasivo por separado, neto al gasto', () => {
    const accounts = { deferred_tax_asset: { id: 'dta' }, deferred_tax_liability: { id: 'dtl' }, deferred_tax_expense: { id: 'exp' } };
    // Activo sube 100, pasivo sube 30 → ingreso neto por impuesto diferido 70.
    const lines = deferredTaxLines({ cutoff_date: '2026-12-31', accounts, summary: { dta_required: 300, dta_book: 200, dtl_required: 80, dtl_book: 50 } });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    expect(lines.find((l) => l.account_id === 'dta')).toMatchObject({ debit: 100, credit: 0 });
    expect(lines.find((l) => l.account_id === 'dtl')).toMatchObject({ debit: 0, credit: 30 });
    expect(lines.find((l) => l.account_id === 'exp')).toMatchObject({ debit: 0, credit: 70 });
    // Ambos bajan igual: hay asiento aunque el neto sea cero.
    const same = deferredTaxLines({ cutoff_date: '2026-12-31', accounts, summary: { dta_required: 100, dta_book: 150, dtl_required: 0, dtl_book: 50 } });
    expect(same).toHaveLength(2);
    expect(sum(same, 'debit')).toBe(sum(same, 'credit'));
  });
});
