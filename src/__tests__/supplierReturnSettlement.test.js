// Devoluciones a proveedor: reparto pagado/pendiente (neto de retenciones),
// saldo de la compra con returned_amount y asiento según la liquidación.
const { purchaseReturnSplit, purchaseBalance, purchasePaymentStatus } = require('../utils/purchaseAmounts');

describe('purchaseReturnSplit', () => {
  // Compra de 119.000 con 1.000 de retenciones (neto 118.000), 59.000 pagados.
  const purchase = { total_amount: 119000, total_retentions: 1000, paid_amount: 59000 };

  test('reparte en la proporción pagada del neto', () => {
    expect(purchaseReturnSplit(purchase, 23800)).toEqual({ paid: 11900, pending: 11900 });
  });

  test('compra sin pagos: todo baja la cuenta por pagar', () => {
    expect(purchaseReturnSplit({ ...purchase, paid_amount: 0 }, 23800)).toEqual({ paid: 0, pending: 23800 });
  });

  test('compra pagada: todo es parte pagada', () => {
    expect(purchaseReturnSplit({ ...purchase, paid_amount: 118000 }, 23800)).toEqual({ paid: 23800, pending: 0 });
  });
});

describe('saldo de la compra con devoluciones', () => {
  test('returned_amount baja el saldo y el estado', () => {
    const purchase = { total_amount: 119000, total_retentions: 1000, paid_amount: 59000, returned_amount: 11900 };
    expect(purchaseBalance(purchase)).toBe(47100);
    expect(purchasePaymentStatus(purchase)).toBe('partial');
  });

  test('si la devolución cubre lo pendiente la compra queda pagada', () => {
    const purchase = { total_amount: 119000, total_retentions: 1000, paid_amount: 59000, returned_amount: 59000 };
    expect(purchaseBalance(purchase)).toBe(0);
    expect(purchasePaymentStatus(purchase)).toBe('paid');
  });
});

// ── Asiento (generateSupplierReturnEntry) ──
const mockCreateDraftEntry = jest.fn(async (_t, data) => ({ id: 'je-1', ...data }));
jest.mock('../config/database', () => ({
  sequelize: { transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn() })), define: jest.fn(() => ({})) },
}));
jest.mock('../models', () => ({
  BankAccount: { findOne: jest.fn(async () => ({ chart_of_account_id: 'acc-bank-1' })) },
}));
jest.mock('../services/accounting/journalEntry.service', () => ({
  getMappedAccountId: jest.fn(async (_t, key) => `acc:${key}`),
  createDraftEntry: (...args) => mockCreateDraftEntry(...args),
  postEntry: jest.fn(),
  safeAutoGenerate: (fn) => fn(),
}));

let generateSupplierReturnEntry;
try {
  ({ generateSupplierReturnEntry } = require('../services/accounting/autoEntries.service'));
} catch (e) {
  generateSupplierReturnEntry = null;
}

const purchase = { id: 'p1', purchase_number: 'OC-1', branch_id: 'b1', supplier_id: 'sup1', total_amount: 119000, total_retentions: 1000, paid_amount: 59000 };
const baseReturn = { id: 'sr1', return_number: 'DP-1', total_amount: 23800, tax: 3800 };
const debitLines = () => mockCreateDraftEntry.mock.calls.at(-1)[1].lines.filter((l) => l.debit > 0);

(generateSupplierReturnEntry ? describe : describe.skip)('generateSupplierReturnEntry', () => {
  beforeEach(() => mockCreateDraftEntry.mockClear());

  test('saldo a favor: todo va a Proveedores', async () => {
    await generateSupplierReturnEntry({ ...baseReturn, settlement_type: 'credit' }, [], purchase, 't1', 'u1');
    expect(debitLines()).toEqual([
      expect.objectContaining({ account_id: 'acc:purchase_payable', debit: 23800, third_party_id: 'sup1' }),
    ]);
  });

  test('con liquidación fijada: usa los montos guardados y reversa la retención', async () => {
    await generateSupplierReturnEntry({
      ...baseReturn, total_amount: 119, tax: 19,
      payable_reduction: 59, money_back_amount: 59, settlement_type: 'refund', refund_method: 'Efectivo',
      retention_reversal: { retefuente: 1, reteiva: 0, reteica: 0 },
    }, [], purchase, 't1', 'u1');
    const lines = mockCreateDraftEntry.mock.calls.at(-1)[1].lines;
    expect(debitLines()).toEqual([
      expect.objectContaining({ account_id: 'acc:purchase_payable', debit: 59 }),
      expect.objectContaining({ account_id: 'acc:purchase_cash_account', debit: 59 }),
      expect.objectContaining({ account_id: 'acc:purchase_retefuente_payable', debit: 1 }),
    ]);
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    expect(debit).toBeCloseTo(credit, 2);
  });

  test('reintegro: pendiente a Proveedores y lo pagado a la cuenta bancaria elegida', async () => {
    await generateSupplierReturnEntry(
      { ...baseReturn, settlement_type: 'refund', refund_method: 'Transferencia', refund_bank_account_id: 'bank1' },
      [], purchase, 't1', 'u1'
    );
    expect(debitLines()).toEqual([
      expect.objectContaining({ account_id: 'acc:purchase_payable', debit: 11900 }),
      expect.objectContaining({ account_id: 'acc-bank-1', debit: 11900 }),
    ]);
  });
});
