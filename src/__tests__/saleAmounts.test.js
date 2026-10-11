// Saldo de cartera neto de devoluciones (utils/saleAmounts.js) y código DIAN
// del medio de pago con las etiquetas en español que guardan las pantallas.
const { saleBalance, salePaymentStatus, saleCollectibleTotal } = require('../utils/saleAmounts');
const { dianPaymentMeans } = require('../services/sales/paymentTerms.service');

describe('saleAmounts', () => {
  test('sin devoluciones el saldo es total - pagado', () => {
    expect(saleBalance({ total_amount: '100000', paid_amount: '40000' })).toBe(60000);
  });

  test('la devolución aprobada baja el saldo', () => {
    const sale = { total_amount: 100000, paid_amount: 40000, returned_amount: 30000 };
    expect(saleCollectibleTotal(sale)).toBe(70000);
    expect(saleBalance(sale)).toBe(30000);
    expect(salePaymentStatus(sale)).toBe('partial');
  });

  test('si la devolución cubre todo lo pendiente la venta queda saldada', () => {
    const sale = { total_amount: 100000, paid_amount: 40000, returned_amount: 60000 };
    expect(saleBalance(sale)).toBe(0);
    expect(salePaymentStatus(sale)).toBe('paid');
  });

  test('venta a crédito devuelta parcialmente sin pagos sigue pendiente', () => {
    const sale = { total_amount: 100000, paid_amount: 0, returned_amount: 25000 };
    expect(saleBalance(sale)).toBe(75000);
    expect(salePaymentStatus(sale)).toBe('pending');
  });

  test('el saldo nunca es negativo', () => {
    expect(saleBalance({ total_amount: 100, paid_amount: 100, returned_amount: 50 })).toBe(0);
  });
});

describe('dianPaymentMeans: medio de pago', () => {
  const code = (payment_method) => dianPaymentMeans({ payment_form: 'contado', payment_method }).paymentMethod;

  test.each([
    ['Efectivo', '10'],
    ['Cheque', '20'],
    ['Transferencia', '47'],
    ['Transferencia Bancaria', '47'],
    ['transfer', '47'],
    ['Tarjeta de Crédito', '48'],
    ['Tarjeta de Débito', '49'],
    ['mixto', 'ZZZ'],
  ])('%s → %s', (method, expected) => {
    expect(code(method)).toBe(expected);
  });
});
