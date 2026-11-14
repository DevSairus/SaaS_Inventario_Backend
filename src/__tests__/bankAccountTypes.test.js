// 5.2 — Cuentas bancarias por clasificación: tipo, moneda y cuenta padre del PUC.
const { BANK_ACCOUNT_TYPES, resolveTypeAndCurrency } = require('../services/accounting/bankAccountTypes');
const { PUC_COLOMBIA_STANDARD } = require('../data/puc-colombia-standard');

describe('resolveTypeAndCurrency', () => {
  test('sin tipo es corriente en COP (compatibilidad con cuentas existentes)', () => {
    expect(resolveTypeAndCurrency(undefined, undefined)).toEqual({ type: 'corriente', currency: 'COP' });
    expect(resolveTypeAndCurrency('', '')).toEqual({ type: 'corriente', currency: 'COP' });
  });
  test('ahorros es en pesos', () => {
    expect(resolveTypeAndCurrency('ahorros', 'cop')).toEqual({ type: 'ahorros', currency: 'COP' });
  });
  test('corriente o ahorros con otra moneda se rechaza', () => {
    expect(() => resolveTypeAndCurrency('corriente', 'USD')).toThrow(/Moneda extranjera/);
    expect(() => resolveTypeAndCurrency('ahorros', 'EUR')).toThrow(/pesos/);
  });
  test('moneda extranjera exige moneda ISO distinta de COP, en mayúscula', () => {
    expect(resolveTypeAndCurrency('moneda_extranjera', ' usd ')).toEqual({ type: 'moneda_extranjera', currency: 'USD' });
    expect(() => resolveTypeAndCurrency('moneda_extranjera', '')).toThrow(/moneda/);
    expect(() => resolveTypeAndCurrency('moneda_extranjera', 'COP')).toThrow(/distinta de COP/);
    expect(() => resolveTypeAndCurrency('moneda_extranjera', 'DOLAR')).toThrow(/3 letras/);
  });
  test('tipo desconocido se rechaza con 400', () => {
    try { resolveTypeAndCurrency('fiducia', 'COP'); throw new Error('no lanzó'); } catch (e) { expect(e.statusCode).toBe(400); }
  });
});

describe('cuentas PUC por tipo', () => {
  const byCode = new Map(PUC_COLOMBIA_STANDARD.map((a) => [a.code, a]));
  test.each(Object.entries(BANK_ACCOUNT_TYPES))('%s: el catálogo base trae su cuenta padre y su grupo', (type, spec) => {
    expect(byCode.get(spec.parentCode)).toMatchObject({ type: 'activo', accepts_entries: true, parent_code: spec.groupCode });
    expect(byCode.get(spec.groupCode)).toBeDefined();
  });
  test('los padres se declaran antes que sus hijos (el seed los crea en orden)', () => {
    const order = PUC_COLOMBIA_STANDARD.map((a) => a.code);
    for (const code of ['111010', '112005', '429581', '529581']) {
      const acc = byCode.get(code);
      expect(order.indexOf(acc.parent_code)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(acc.parent_code)).toBeLessThan(order.indexOf(code));
    }
  });
});
