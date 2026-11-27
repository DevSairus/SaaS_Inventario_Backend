// Cuadre de caja por medio de pago: balde de cada pago y matriz
// entradas/salidas/esperado (services/finance/cashSessionReport.service.js).
jest.mock('../models', () => ({}));
jest.mock('../controllers/finance/cashflow.controller', () => ({ toDateOnly: (v) => String(v).slice(0, 10) }));
const { paymentKey, methodMatrix } = require('../services/finance/cashSessionReport.service');

test('los pagos que no son dinero van en su propio balde', () => {
  expect(paymentKey({ method: 'Efectivo' })).toBe('efectivo');
  expect(paymentKey({ method: 'debit_card' })).toBe('tarjeta');
  expect(paymentKey({ method: 'Nequi' })).toBe('transferencia');
  expect(paymentKey({ method: 'Efectivo', source: 'advance' })).toBe('anticipo');
  expect(paymentKey({ source: 'retention' })).toBe('retenciones');
  expect(paymentKey({ method: 'Saldo a favor', source: 'supplier_credit' })).toBe('saldo_a_favor');
});

test('esperado por medio = base y salidas solo en efectivo; otras salidas no restan', () => {
  const m = methodMatrix([
    { direction: 'in', method: 'Efectivo', amount: 100000 },
    { direction: 'in', method: 'tarjeta_credito', amount: 50000 },
    { direction: 'out', method: 'cash', amount: 30000 },
    { direction: 'out', method: 'Transferencia', amount: 20000 },
    { direction: 'in', method: 'transfer', amount: 70000 },
  ], 200000);
  expect(m.efectivo).toEqual({ in: 100000, out: 30000, expected: 270000 });
  expect(m.tarjeta).toEqual({ in: 50000, out: 0, expected: 50000 });
  expect(m.transferencia).toEqual({ in: 70000, out: 20000, expected: 70000 });
  expect(m.otro.expected).toBe(0);
});
