// Pagos que entran al asiento de la venta (pago mixto, abonos de OT) y
// saldo de gastos neto de retenciones.
jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn(), define: jest.fn(() => ({})) } }));
jest.mock('../models', () => ({}));
jest.mock('../services/accounting/journalEntry.service', () => ({}));

const { salePaymentsForEntry } = require('../services/accounting/autoEntries.service');
const { expenseNetPayable, expenseBalance, expensePaymentStatus } = require('../utils/expenseAmounts');

describe('salePaymentsForEntry', () => {
  test('pago mixto: un pago por medio, marcados in_sale_entry', () => {
    const sale = {
      paid_amount: 100000,
      payment_method: 'mixed',
      payment_history: [
        { amount: 60000, method: 'cash', in_sale_entry: true },
        { amount: 40000, method: 'transfer', bank_account_id: 'b1', in_sale_entry: true },
      ],
    };
    const payments = salePaymentsForEntry(sale);
    expect(payments).toHaveLength(2);
    expect(payments[1].bank_account_id).toBe('b1');
  });

  test('abonos posteriores y anticipos no entran al asiento de la venta', () => {
    const sale = {
      paid_amount: 150000,
      payment_history: [
        { amount: 50000, method: 'cash', in_sale_entry: true },
        { amount: 70000, method: 'transfer' }, // abono en cartera: asiento propio
        { amount: 30000, source: 'advance' },
      ],
    };
    expect(salePaymentsForEntry(sale).map((p) => p.amount)).toEqual([50000]);
  });

  test('ventas de antes de la marca: el pago al confirmar se reconoce por su nota', () => {
    const sale = {
      paid_amount: 80000,
      payment_history: [
        { amount: 50000, method: 'cash', notes: 'Pago registrado al confirmar la venta' },
        { amount: 30000, method: 'cash' },
      ],
    };
    expect(salePaymentsForEntry(sale).map((p) => p.amount)).toEqual([50000]);
  });

  test('ventas muy viejas sin historial: paid_amount menos anticipos/retenciones', () => {
    expect(salePaymentsForEntry({ paid_amount: 90000, payment_method: 'Efectivo', payment_history: [] }))
      .toEqual([{ amount: 90000, method: 'Efectivo' }]);
    expect(salePaymentsForEntry({ paid_amount: 50000, payment_history: [{ amount: 50000, source: 'advance' }] }))
      .toEqual([]);
  });

  test('abonos de OT trasladados conservan si ya tienen asiento de anticipo', () => {
    const sale = {
      paid_amount: 70000,
      payment_history: [
        { amount: 50000, method: 'transfer', source: 'work_order', in_sale_entry: true, advance_accounted: true },
        { amount: 20000, method: 'cash', source: 'work_order', in_sale_entry: true, advance_accounted: false },
      ],
    };
    expect(salePaymentsForEntry(sale).map((p) => p.advance_accounted)).toEqual([true, false]);
  });
});

describe('expenseAmounts', () => {
  const expense = { total_amount: 1190000, total_retentions: 25000 + 28560, paid_amount: 0 };

  test('se le debe al proveedor el neto de retenciones', () => {
    expect(expenseNetPayable(expense)).toBe(1136440);
    expect(expenseBalance(expense)).toBe(1136440);
  });

  test('pagar el neto deja el gasto pagado y sin saldo', () => {
    expect(expensePaymentStatus(expense, 1136440)).toBe('paid');
    expect(expenseBalance({ ...expense, paid_amount: 1136440 })).toBe(0);
  });

  test('parcial y pendiente', () => {
    expect(expensePaymentStatus(expense, 500000)).toBe('partial');
    expect(expensePaymentStatus(expense, 0)).toBe('pending');
  });

  test('gastos viejos pagados por el bruto no quedan con saldo negativo', () => {
    expect(expenseBalance({ ...expense, paid_amount: 1190000 })).toBe(0);
  });
});

describe('workOrderPayments.transferableAmount', () => {
  const { transferableAmount } = require('../services/workshop/workOrderPayments.service');

  test('descuenta lo que ya pasó a anticipo', () => {
    expect(transferableAmount({ amount: 100000 })).toBe(100000);
    expect(transferableAmount({ amount: 100000, moved_to_advance_amount: 30000 })).toBe(70000);
    expect(transferableAmount({ amount: 100000, moved_to_advance_amount: 100000 })).toBe(0);
  });
});
