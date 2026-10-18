// Excedente de un pago (cliente paga más que el total) que queda como anticipo.
jest.mock('../models', () => ({}));
jest.mock('../services/finance/advanceNumber.service', () => ({}));
jest.mock('../services/accounting/bankAccountSelection', () => ({}));

const { splitExcess, advanceMethodLabel } = require('../services/finance/customerAdvance.service');

describe('splitExcess', () => {
  test('pago mixto: el excedente sale del último medio y conserva su cuenta bancaria', () => {
    const r = splitExcess([
      { method: 'cash', amount: 50000 },
      { method: 'transfer', amount: 40000, bank_account_id: 'b1' },
    ], 12650);
    expect(r.splits).toEqual([
      { method: 'cash', amount: 50000 },
      { method: 'transfer', amount: 27350, bank_account_id: 'b1' },
    ]);
    expect(r.advanceParts).toEqual([{ method: 'transfer', amount: 12650, bank_account_id: 'b1' }]);
    expect(r.unassigned).toBe(0);
  });

  test('si el último medio no alcanza, toma del anterior y quita los que quedan en 0', () => {
    const r = splitExcess([
      { method: 'cash', amount: 50000 },
      { method: 'transfer', amount: 10000 },
    ], 15000);
    expect(r.splits).toEqual([{ method: 'cash', amount: 45000 }]);
    expect(r.advanceParts.map(p => [p.method, p.amount])).toEqual([['cash', 5000], ['transfer', 10000]]);
  });

  test('excedente mayor que lo recibido queda sin asignar', () => {
    const r = splitExcess([{ method: 'cash', amount: 5000 }], 9000);
    expect(r.unassigned).toBe(4000);
  });
});

describe('advanceMethodLabel', () => {
  test('traduce códigos del modal de venta a las etiquetas de anticipos', () => {
    expect(advanceMethodLabel('cash')).toBe('Efectivo');
    expect(advanceMethodLabel('transfer')).toBe('Transferencia');
    expect(advanceMethodLabel('debit_card')).toBe('Tarjeta de Débito');
    expect(advanceMethodLabel('Cheque')).toBe('Cheque');
  });
});
