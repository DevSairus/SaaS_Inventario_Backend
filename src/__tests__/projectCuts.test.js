const { computeCut } = require('../services/projects/projectCuts.service');

// Contrato: 10 paneles a 500.000 (sin IVA), inversor 4.000.000 (sin IVA), instalación 2.000.000 (IVA 19 %).
const lines = [
  { sale_item_id: 'pan', description: 'Panel', qty_contract: 10, unit_price: 500000, tax_pct: 0 },
  { sale_item_id: 'inv', description: 'Inversor', qty_contract: 1, unit_price: 4000000, tax_pct: 0 },
  { sale_item_id: 'mo', description: 'Instalación', qty_contract: 1, unit_price: 2000000, tax_pct: 19 },
];
const contractTotal = 5000000 + 4000000 + 2000000 * 1.19; // 11.380.000
const ctx = (over = {}) => ({
  lines, previous: new Map(), aiu: null, retentionPct: 5, advanceReceived: 5690000, advanceAvailable: 5690000, contractTotal, ...over,
});

describe('cortes de obra', () => {
  test('primer corte por cantidades: solo lo nuevo, anticipo proporcional y retención', () => {
    const r = computeCut({ items: [{ sale_item_id: 'pan', qty_cumulative: 10 }, { sale_item_id: 'inv', qty_cumulative: 1 }] }, ctx());
    expect(r.direct_amount).toBe(9000000);
    expect(r.tax_amount).toBe(0);
    expect(r.retention_amount).toBe(450000); // 5 % antes de IVA
    expect(r.advance_amount).toBe(4500000); // anticipo = 50 % del contrato → 50 % de la factura
    expect(r.net_amount).toBe(4050000);
    expect(r.is_final).toBe(false);
  });

  test('% global para un hito, respetando lo ya ejecutado', () => {
    const previous = new Map([['pan', 10]]);
    const r = computeCut({ global_pct: 50 }, ctx({ previous }));
    const by = Object.fromEntries(r.items.map((i) => [i.sale_item_id, i.qty_this]));
    expect(by).toEqual({ pan: 0, inv: 0.5, mo: 0.5 });
    expect(r.tax_amount).toBe(190000);
  });

  test('el último corte amortiza todo lo que queda del anticipo', () => {
    const previous = new Map([['pan', 10], ['inv', 1]]);
    const r = computeCut({ items: [{ sale_item_id: 'mo', pct_cumulative: 100 }] }, ctx({ previous, advanceAvailable: 1190000 }));
    expect(r.is_final).toBe(true);
    expect(r.total_amount).toBe(2380000);
    expect(r.advance_amount).toBe(1190000);
    expect(r.progress_pct).toBe(100);
  });

  test('no se pasa de lo contratado ni se baja de lo facturado', () => {
    expect(() => computeCut({ items: [{ sale_item_id: 'pan', qty_cumulative: 11 }] }, ctx())).toThrow('supera lo contratado');
    expect(() => computeCut({ items: [{ sale_item_id: 'pan', qty_cumulative: 4 }] }, ctx({ previous: new Map([['pan', 6]]) }))).toThrow('no puede bajar');
  });

  test('con AIU: IVA sobre la utilidad y retención sobre directo + AIU', () => {
    const r = computeCut({ items: [{ sale_item_id: 'pan', qty_cumulative: 10 }] }, ctx({
      aiu: { admin_pct: 10, unforeseen_pct: 5, profit_pct: 10, iva_rate: 0.19 }, advanceReceived: 0, advanceAvailable: 0,
    }));
    expect(r.aiu_amount).toBe(1250000);
    expect(r.tax_amount).toBe(95000);
    expect(r.retention_amount).toBe(312500);
    expect(r.advance_amount).toBe(0);
  });
});
