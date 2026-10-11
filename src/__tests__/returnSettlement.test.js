// Motor de liquidación de devoluciones (services/returns/returnSettlement.js).
// Regla: lo devuelto baja primero lo que se debe; solo el excedente es
// dinero (o saldo a favor). Retenciones en proporción a lo devuelto.
const { customerReturnSettlement: customer, supplierReturnSettlement: supplier } = require('../services/returns/returnSettlement');

const noRet = { retefuente: 0, reteiva: 0, reteica: 0 };

describe('devolución de cliente', () => {
  test.each([
    ['venta a crédito sin pagos, devolución parcial', { total_amount: 100, paid_amount: 0 }, 30, { reduction: 30, money_back: 0 }],
    ['venta pagada a medias, devuelve menos que el saldo', { total_amount: 100, paid_amount: 40 }, 50, { reduction: 50, money_back: 0 }],
    ['venta pagada a medias, devuelve más que el saldo', { total_amount: 100, paid_amount: 40 }, 80, { reduction: 60, money_back: 20 }],
    ['venta pagada, devolución parcial', { total_amount: 100, paid_amount: 100 }, 30, { reduction: 0, money_back: 30 }],
    ['segunda devolución tras pagar el saldo', { total_amount: 100, paid_amount: 50, returned_amount: 50 }, 50, { reduction: 0, money_back: 50 }],
    ['segunda devolución sin pago intermedio', { total_amount: 100, paid_amount: 40, returned_amount: 50 }, 50, { reduction: 10, money_back: 40 }],
  ])('%s', (_name, sale, amount, expected) => {
    expect(customer(sale, amount)).toEqual({ ...expected, retention_reversal: noRet });
  });

  test('suma de devoluciones nunca devuelve más de lo pagado', () => {
    // 100 con 40 pagados; tres devoluciones de 40, 30 y 30.
    let sale = { total_amount: 100, paid_amount: 40, returned_amount: 0 };
    let moneyBack = 0;
    for (const amount of [40, 30, 30]) {
      const r = customer(sale, amount);
      sale = { ...sale, returned_amount: sale.returned_amount + r.reduction };
      moneyBack += r.money_back;
    }
    expect(moneyBack).toBe(40);
    expect(sale.returned_amount).toBe(60);
  });

  test('retención del cliente sobre factura pagada: se reversa, no se devuelve', () => {
    const sale = { total_amount: 100, paid_amount: 100, payment_history: [{ source: 'retention', retentions: { retefuente: 2.5, reteica: 0.5 } }] };
    expect(customer(sale, 100)).toEqual({ reduction: 0, money_back: 97, retention_reversal: { retefuente: 2.5, reteiva: 0, reteica: 0.5 } });
  });

  test('retención ya reversada por una devolución anterior no se reversa dos veces', () => {
    const sale = { total_amount: 100, paid_amount: 100, returned_amount: 0, payment_history: [{ source: 'retention', retentions: { retefuente: 3 } }] };
    const r = customer(sale, 100, { retefuente: 1.5 });
    expect(r.retention_reversal.retefuente).toBe(1.5);
    expect(r.money_back).toBe(98.5);
  });

  test('retención en factura sin pagar: lo devuelto baja la cartera y el resto reversa la retención', () => {
    const sale = { total_amount: 100, paid_amount: 3, payment_history: [{ source: 'retention', retentions: { retefuente: 3 } }] };
    expect(customer(sale, 100)).toEqual({ reduction: 97, money_back: 0, retention_reversal: { retefuente: 3, reteiva: 0, reteica: 0 } });
  });
});

describe('devolución a proveedor', () => {
  const base = { total_amount: 119, total_retentions: 1, retefuente_amount: 1 };

  test.each([
    ['compra sin pagar, devolución total', { ...base, paid_amount: 0 }, 119, { reduction: 118, money_back: 0, retention_reversal: { retefuente: 1, reteiva: 0, reteica: 0 } }],
    ['compra pagada, devolución total', { ...base, paid_amount: 118 }, 119, { reduction: 0, money_back: 118, retention_reversal: { retefuente: 1, reteiva: 0, reteica: 0 } }],
    ['compra pagada a medias, devuelve la mitad', { ...base, paid_amount: 59 }, 59.5, { reduction: 59, money_back: 0, retention_reversal: { retefuente: 0.5, reteiva: 0, reteica: 0 } }],
    ['compra sin retenciones pagada, parcial', { total_amount: 100, paid_amount: 100 }, 25, { reduction: 0, money_back: 25, retention_reversal: noRet }],
  ])('%s', (_name, purchase, amount, expected) => {
    expect(supplier(purchase, amount)).toEqual(expected);
  });
});
