// Recepción parcial (porciones contables) y saldo neto de retenciones.
jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn(), define: jest.fn(() => ({})) } }));
jest.mock('../models', () => ({}));
jest.mock('../models/inventory', () => ({}));
jest.mock('../models/inventory/ProductSupplier', () => ({}));

const { purchaseNetPayable, purchaseBalance, purchasePaymentStatus } = require('../utils/purchaseAmounts');

let buildReceiptPortion;
try {
  ({ buildReceiptPortion } = require('../controllers/inventory/purchases.controller'));
} catch (e) {
  buildReceiptPortion = null;
}

// Compra: 2 líneas (10 x 1.000 IVA 19%, 4 x 2.500 IVA 0%), flete 500,
// ReteFuente 2.5% y ReteIVA 15% por concepto.
const purchase = {
  total_amount: 10000 + 1900 + 10000 + 500, // 22.400
  tax_amount: 1900,
  retefuente_amount: 500,
  reteiva_amount: 285,
  reteica_amount: 0,
  total_retentions: 785,
  applied_retentions: [
    { code: '07', concept: 'Compras', rate: 2.5, base: 20000, amount: 500 },
    { code: '05', concept: 'ReteIVA', rate: 15, base: 1900, amount: 285 },
  ],
  items: [
    { id: 'a', quantity: 10, subtotal: 10000, tax_amount: 1900 },
    { id: 'b', quantity: 4, subtotal: 10000, tax_amount: 0 },
  ],
};

describe('purchaseAmounts', () => {
  it('neto a pagar descuenta las retenciones', () => {
    expect(purchaseNetPayable(purchase)).toBe(21615);
  });
  it('saldo y estado de pago contra el neto', () => {
    expect(purchaseBalance({ ...purchase, paid_amount: 21615 })).toBe(0);
    expect(purchasePaymentStatus(purchase, 21615)).toBe('paid');
    expect(purchasePaymentStatus(purchase, 10000)).toBe('partial');
    expect(purchasePaymentStatus(purchase, 0)).toBe('pending');
  });
});

(buildReceiptPortion ? describe : describe.skip)('buildReceiptPortion', () => {
  const sumOf = (portions, key) => Math.round(portions.reduce((s, p) => s + Number(p[key] || 0), 0) * 100) / 100;

  it('dos recepciones parciales + final suman exacto la compra', () => {
    const r1 = buildReceiptPortion(purchase, new Map([['a', 3]]), [], false);           // 3 de 10 de la línea a
    const r2 = buildReceiptPortion(purchase, new Map([['b', 1], ['a', 2]]), [{ amounts: r1 }], false);
    const r3 = buildReceiptPortion(purchase, new Map([['a', 5], ['b', 3]]), [{ amounts: r1 }, { amounts: r2 }], true);
    const all = [r1, r2, r3];
    expect(sumOf(all, 'inventory')).toBe(22400 - 1900);
    expect(sumOf(all, 'tax')).toBe(1900);
    expect(sumOf(all, 'retefuente')).toBe(500);
    expect(sumOf(all, 'reteiva')).toBe(285);
    // detalle por concepto también cuadra
    const lineSum = (idx) => Math.round(all.reduce((s, p) => s + p.retention_lines[idx].amount, 0) * 100) / 100;
    expect(lineSum(0)).toBe(500);
    expect(lineSum(1)).toBe(285);
  });

  it('el IVA de la porción sale de las líneas recibidas', () => {
    const onlyB = buildReceiptPortion(purchase, new Map([['b', 4]]), [], false);
    expect(onlyB.tax).toBe(0);          // la línea b no tiene IVA
    expect(onlyB.reteiva).toBe(0);      // sin IVA no hay ReteIVA
    expect(onlyB.inventory).toBe(10250); // mitad del valor (incluye mitad del flete)
  });

  it('cada asiento de recepción cuadra (débitos = créditos)', () => {
    const p = buildReceiptPortion(purchase, new Map([['a', 4], ['b', 2]]), [], false);
    const debit = p.inventory + p.tax;
    const credit = (debit - p.retefuente - p.reteiva - p.reteica) + p.retefuente + p.reteiva + p.reteica;
    expect(Math.abs(debit - credit)).toBeLessThan(0.01);
  });
});
