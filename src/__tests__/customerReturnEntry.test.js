// Asiento de una devolución de cliente con liquidación fijada al aprobar
// (generateCustomerReturnEntry): cartera, retenciones reversadas y saldo a
// favor o reintegro, siempre cuadrado.
const mockCreateDraftEntry = jest.fn(async (_t, data) => ({ id: 'je-1', ...data }));
jest.mock('../config/database', () => ({
  sequelize: { transaction: jest.fn(async () => ({ commit: jest.fn(), rollback: jest.fn() })), define: jest.fn(() => ({})) },
}));
jest.mock('../models', () => ({
  BankAccount: { findOne: jest.fn(async () => null) },
  Tenant: { findByPk: jest.fn(async () => null) },
}));
// Código agregado después de estos tests: el seed de mapeos ICA (no aplica
// acá) y la consulta de responsabilidad de IVA del tenant (null = responsable).
jest.mock('../services/accounting/accountingSeed.service', () => ({ ensureIcaMappings: jest.fn(async () => {}) }));
jest.mock('../services/accounting/journalEntry.service', () => ({
  getMappedAccountId: jest.fn(async (_t, key) => `acc:${key}`),
  createDraftEntry: (...args) => mockCreateDraftEntry(...args),
  postEntry: jest.fn(),
  reverseEntry: jest.fn(),
  safeAutoGenerate: (fn) => fn(),
}));
jest.mock('../services/sales/globalDiscount.service', () => ({
  splitRevenueDiscount: (product, service) => ({ productRevenue: product, serviceRevenue: service }),
}));

const { generateCustomerReturnEntry } = require('../services/accounting/autoEntries.service');

const sale = { id: 's1', sale_number: 'F-1', branch_id: 'b1', customer_id: 'c1', total_amount: 119000, paid_amount: 119000, payment_method: 'Efectivo' };
const items = [{ saleItem: { item_type: 'product' }, subtotal: 100000, quantity: 1, unit_cost: 0, destination: 'none' }];
const lastLines = () => mockCreateDraftEntry.mock.calls.at(-1)[1].lines;
const balanced = (lines) => {
  const d = lines.reduce((s, l) => s + l.debit, 0);
  const c = lines.reduce((s, l) => s + l.credit, 0);
  return Math.abs(d - c) < 0.01;
};

test('saldo a favor con retención reversada', async () => {
  await generateCustomerReturnEntry({
    id: 'r1', return_number: 'DEV-1', total_amount: 119000, tax: 19000,
    receivable_reduction: 0, money_back_amount: 116000, settlement_type: 'credit',
    retention_reversal: { retefuente: 2500, reteiva: 0, reteica: 500 },
  }, items, sale, 't1', 'u1');
  const lines = lastLines();
  expect(balanced(lines)).toBe(true);
  expect(lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ account_id: 'acc:customer_advance_liability', credit: 116000 }),
    expect.objectContaining({ account_id: 'acc:sale_retefuente_receivable', credit: 2500 }),
    expect.objectContaining({ account_id: 'acc:sale_reteica_receivable', credit: 500 }),
  ]));
  expect(lines.find((l) => l.account_id === 'acc:sale_receivable')).toBeUndefined();
});

test('parte a cartera y excedente reintegrado en efectivo', async () => {
  await generateCustomerReturnEntry({
    id: 'r2', return_number: 'DEV-2', total_amount: 119000, tax: 19000,
    receivable_reduction: 70000, money_back_amount: 49000, settlement_type: 'refund', refund_method: 'Efectivo',
    retention_reversal: { retefuente: 0, reteiva: 0, reteica: 0 },
  }, items, sale, 't1', 'u1');
  const lines = lastLines();
  expect(balanced(lines)).toBe(true);
  expect(lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ account_id: 'acc:sale_receivable', credit: 70000 }),
    expect.objectContaining({ account_id: 'acc:sale_cash_account', credit: 49000 }),
  ]));
});

test('factura AIU: A, I y U devueltos van a ingreso por servicios y el asiento cuadra', async () => {
  // Costo directo devuelto 100.000 + A 10.000 + I 5.000 + U 5.000; IVA 19% sobre U = 950.
  await generateCustomerReturnEntry({
    id: 'r3', return_number: 'DEV-3', subtotal: 120000, tax: 950, total_amount: 120950,
    receivable_reduction: 120950, money_back_amount: 0,
    retention_reversal: { retefuente: 0, reteiva: 0, reteica: 0 },
  }, items, { ...sale, aiu_enabled: true }, 't1', 'u1');
  const lines = lastLines();
  expect(balanced(lines)).toBe(true);
  expect(lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ account_id: 'acc:sale_revenue_service', debit: 20000 }),
    expect.objectContaining({ account_id: 'acc:sale_revenue_product', debit: 100000 }),
  ]));
});
