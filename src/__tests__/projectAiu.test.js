// AIU personalizado por proyecto (Fase 4, req. 1.6): se carga al crear el
// proyecto (de la cotización AIU) y cada corte lo puede cambiar; un concepto
// en 0 % no aplica y la Utilidad siempre es > 0 (base del IVA).
const { aiuOf, parseAiu, aiuColumns, initialProjectAiu, ivaRateOf, aiuLabel } = require('../services/projects/projectAiu');
const { computeCut } = require('../services/projects/projectCuts.service');

const TAX_ON = { aiu: { enabled: true, admin_pct: 10, unforeseen_pct: 5, profit_pct: 5, iva_rate: 19 } };
const TAX_OFF = { aiu: { enabled: false } };

describe('AIU del proyecto', () => {
  test('nace con el AIU de la cotización si es AIU', () => {
    const quote = { aiu_enabled: true, aiu_admin_pct: '8', aiu_unforeseen_pct: '3', aiu_profit_pct: '6' };
    expect(initialProjectAiu({}, quote, TAX_ON)).toEqual({ admin_pct: 8, unforeseen_pct: 3, profit_pct: 6 });
  });

  test('el formulario manda sobre la cotización; lo que no llega sale de la cotización', () => {
    const quote = { aiu_enabled: true, aiu_admin_pct: 8, aiu_unforeseen_pct: 3, aiu_profit_pct: 6 };
    expect(initialProjectAiu({ aiu_enabled: true, aiu_admin_pct: 12 }, quote, TAX_ON)).toEqual({ admin_pct: 12, unforeseen_pct: 3, profit_pct: 6 });
    expect(initialProjectAiu({ aiu_enabled: false }, quote, TAX_ON)).toBeNull();
  });

  test('sin cotización AIU ni formulario: sin AIU; al activarlo toma los defaults del tenant', () => {
    expect(initialProjectAiu({}, null, TAX_ON)).toBeNull();
    expect(initialProjectAiu({ aiu_enabled: true }, null, TAX_ON)).toEqual({ admin_pct: 10, unforeseen_pct: 5, profit_pct: 5 });
  });

  test('no se activa si el tenant no factura AIU (salvo que ya lo tuviera)', () => {
    expect(() => initialProjectAiu({ aiu_enabled: true }, null, TAX_OFF)).toThrow(/Ajustes → Impuestos/);
    expect(parseAiu({ aiu_admin_pct: 9 }, { fallback: { admin_pct: 10, unforeseen_pct: 5, profit_pct: 5 }, tenantEnabled: false, wasEnabled: true }))
      .toEqual({ admin_pct: 9, unforeseen_pct: 5, profit_pct: 5 });
  });

  test('A o I en 0 se permiten; U en 0 no; fuera de 0–100 no', () => {
    expect(parseAiu({ aiu_enabled: true, aiu_admin_pct: 0, aiu_unforeseen_pct: 0, aiu_profit_pct: 5 })).toEqual({ admin_pct: 0, unforeseen_pct: 0, profit_pct: 5 });
    expect(() => parseAiu({ aiu_enabled: true, aiu_admin_pct: 10, aiu_unforeseen_pct: 5, aiu_profit_pct: 0 })).toThrow(/Utilidad/);
    expect(() => parseAiu({ aiu_enabled: true, aiu_admin_pct: 120, aiu_unforeseen_pct: 5, aiu_profit_pct: 5 })).toThrow(/Administración/);
  });

  test('body sin AIU = no lo toca (undefined); columnas y etiqueta', () => {
    expect(parseAiu({ name: 'x' })).toBeUndefined();
    expect(aiuColumns(null)).toEqual({ aiu_enabled: false, aiu_admin_pct: null, aiu_unforeseen_pct: null, aiu_profit_pct: null });
    expect(aiuOf(aiuColumns({ admin_pct: 10, unforeseen_pct: 0, profit_pct: 5 }))).toEqual({ admin_pct: 10, unforeseen_pct: 0, profit_pct: 5 });
    expect(aiuLabel({ admin_pct: 10, unforeseen_pct: 0, profit_pct: 5 })).toBe('A 10 % · I 0 % · U 5 %');
    expect(ivaRateOf(TAX_ON)).toBeCloseTo(0.19);
  });
});

describe('Corte con AIU propio', () => {
  const lines = [{ sale_item_id: 'l1', description: 'Obra civil', qty_contract: 10, unit_price: 100000, tax_pct: 19 }];
  const base = { lines, previous: new Map(), retentionPct: 0, advanceReceived: 0, advanceAvailable: 0, contractTotal: 0 };

  test('corte sin Imprevistos: I en 0 no suma; IVA solo sobre la U; la línea queda sin IVA', () => {
    const calc = computeCut({ items: [{ sale_item_id: 'l1', qty_cumulative: 5 }] }, {
      ...base, aiu: { admin_pct: 10, unforeseen_pct: 0, profit_pct: 5, iva_rate: 0.19 },
    });
    expect(calc.direct_amount).toBe(500000);
    expect(calc.aiu_amount).toBe(75000); // A 50.000 + U 25.000
    expect(calc.tax_amount).toBe(4750); // 19 % de 25.000
    expect(calc.total_amount).toBe(579750);
    expect(calc.items[0].tax_pct).toBe(0);
    expect(calc.aiu).toEqual({ admin_pct: 10, unforeseen_pct: 0, profit_pct: 5 });
  });

  test('corte sin AIU: IVA de cada línea', () => {
    const calc = computeCut({ items: [{ sale_item_id: 'l1', qty_cumulative: 5 }] }, { ...base, aiu: null });
    expect(calc.aiu_amount).toBe(0);
    expect(calc.tax_amount).toBe(95000);
    expect(calc.aiu).toBeNull();
  });
});
