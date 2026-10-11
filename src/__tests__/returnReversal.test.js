// Reversión de devoluciones aprobadas (services/returns/returnReversal.js).
const mockTx = { LOCK: { UPDATE: 'UPDATE' }, finished: false, commit: jest.fn(async function () { this.finished = true; }), rollback: jest.fn(async function () { this.finished = true; }) };
const mockModels = {};
const mockCreateMovement = jest.fn();
const mockReverseEntry = jest.fn(async () => ({ reversalEntry: { id: 'je-rev' } }));
const mockGetOpenSession = jest.fn(async () => ({ id: 'cs1' }));
const mockAssertCash = jest.fn();

jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn(async () => { mockTx.finished = false; return mockTx; }), define: jest.fn(() => ({})) } }));
jest.mock('../models', () => mockModels);
jest.mock('../controllers/inventory/movements.controller', () => ({ createMovement: (...a) => mockCreateMovement(...a) }));
jest.mock('../services/accounting/journalEntry.service', () => ({
  reverseEntry: (...a) => mockReverseEntry(...a),
  assertPeriodOpen: jest.fn(),
}));
jest.mock('../services/finance/cashSession.service', () => ({
  getOpenSession: (...a) => mockGetOpenSession(...a),
  isTreasuryEnabled: jest.fn(async () => true),
  assertCashAvailable: (...a) => mockAssertCash(...a),
}));
jest.mock('../services/accounting/bankAccountSelection', () => ({ resolveSelectedBankAccountId: jest.fn(async () => null) }));

const { reverseCustomerReturn, reverseSupplierReturn } = require('../services/returns/returnReversal');

const instance = (data) => ({ ...data, update: jest.fn(async function (fields) { Object.assign(this, fields); return this; }) });
const ctx = { tenantId: 't1', userId: 'u1', branchId: 'b1' };

function setupCustomer({ ret = {}, note = null, advance = null, sale = {} } = {}) {
  const customerReturn = instance({ id: 'r1', return_number: 'DEV-1', status: 'approved', sale_id: 's1', receivable_reduction: 30000, ...ret });
  const saleInst = instance({ id: 's1', total_amount: 100000, paid_amount: 40000, returned_amount: 30000, warehouse_id: 'w1', ...sale });
  const advanceInst = advance ? instance(advance) : null;
  Object.assign(mockModels, {
    CustomerReturn: { findOne: jest.fn(async () => customerReturn) },
    CustomerReturnItem: { findAll: jest.fn(async () => [{ product_id: 'p1', quantity: 2, unit_cost: 1000, destination: 'inventory', product: { track_inventory: true } }]) },
    CustomerAdvance: { findOne: jest.fn(async () => advanceInst) },
    Sale: { findOne: jest.fn(async ({ attributes }) => (attributes ? note : saleInst)) },
    Product: { findByPk: jest.fn(async () => instance({ current_stock: 5, reserved_stock: 0 })) },
    JournalEntry: { findOne: jest.fn(async () => ({ id: 'je-1' })) },
  });
  return { customerReturn, saleInst, advanceInst };
}

beforeEach(() => {
  mockCreateMovement.mockClear();
  mockReverseEntry.mockClear();
  mockAssertCash.mockClear();
});

describe('reverseCustomerReturn', () => {
  test('exige motivo', async () => {
    setupCustomer();
    await expect(reverseCustomerReturn({ id: 'r1', ...ctx, body: {} })).rejects.toMatchObject({ status: 400 });
  });

  test('bloquea si ya hay nota crédito ante la DIAN', async () => {
    setupCustomer({ ret: { credit_note_sale_id: 'nc1' }, note: { dian_status: 'accepted' } });
    await expect(reverseCustomerReturn({ id: 'r1', ...ctx, body: { reason: 'error' } })).rejects.toThrow('nota crédito');
  });

  test('bloquea si el saldo a favor ya se usó', async () => {
    setupCustomer({ ret: { settlement_type: 'credit', credit_advance_id: 'a1' }, advance: { advance_number: 'ANT-1', status: 'active', applied_amount: 5000 } });
    await expect(reverseCustomerReturn({ id: 'r1', ...ctx, body: { reason: 'error' } })).rejects.toThrow('ya se usó');
  });

  test('deshace inventario, cartera, saldo a favor y asiento', async () => {
    const { customerReturn, saleInst, advanceInst } = setupCustomer({
      ret: { settlement_type: 'credit', credit_advance_id: 'a1' },
      advance: { advance_number: 'ANT-1', status: 'active', applied_amount: 0, refunded_amount: 0, reassigned_amount: 0 },
    });
    await reverseCustomerReturn({ id: 'r1', ...ctx, body: { reason: 'aprobada por error' } });
    expect(mockCreateMovement).toHaveBeenCalledWith(expect.objectContaining({ movement_type: 'salida', product_id: 'p1', quantity: 2 }), mockTx);
    expect(saleInst.returned_amount).toBe(0);
    expect(advanceInst.status).toBe('voided');
    expect(mockReverseEntry).toHaveBeenCalled();
    expect(customerReturn.status).toBe('reversed');
    expect(customerReturn.reversal_entry_id).toBe('je-rev');
  });

  test('si se devolvió dinero, el cliente lo reintegra por la caja (entrada, sin validar efectivo)', async () => {
    const { customerReturn } = setupCustomer({ ret: { settlement_type: 'refund', refund_amount: 20000, refund_method: 'Efectivo' } });
    await reverseCustomerReturn({ id: 'r1', ...ctx, body: { reason: 'error', payment_method: 'Efectivo' } });
    expect(customerReturn).toMatchObject({ reversal_amount: 20000, reversal_method: 'Efectivo', reversal_cash_session_id: 'cs1' });
    expect(mockAssertCash).toHaveBeenCalledTimes(0);
  });
});

describe('reverseSupplierReturn', () => {
  function setupSupplier({ ret = {}, adjustment = null } = {}) {
    const supplierReturn = instance({ id: 'sr1', return_number: 'DP-1', status: 'approved', purchase_id: 'p0', payable_reduction: 10000, ...ret });
    const own = instance({ id: 'p0', total_amount: 50000, paid_amount: 0, returned_amount: 10000, payment_history: [] });
    const other = instance({
      id: 'p2', total_amount: 30000, paid_amount: 8000, returned_amount: 0,
      payment_history: [{ source: 'supplier_credit', supplier_return_id: 'sr1', amount: 8000 }],
    });
    Object.assign(mockModels, {
      SupplierReturn: { findOne: jest.fn(async () => supplierReturn) },
      SupplierReturnItem: { findAll: jest.fn(async () => [{ product_id: 'x1', quantity: 3, unit_cost: 500, product: { id: 'x1' } }]) },
      Purchase: { findOne: jest.fn(async ({ where }) => (where.id === 'p2' ? other : own)) },
      SupportDocumentAdjustment: { findOne: jest.fn(async () => adjustment) },
      Product: { findByPk: jest.fn(async () => instance({ current_stock: 5, reserved_stock: 0 })) },
      JournalEntry: { findOne: jest.fn(async () => ({ id: 'je-2' })) },
    });
    return { supplierReturn, own, other };
  }

  test('bloquea si ya hay Nota de Ajuste ante la DIAN', async () => {
    setupSupplier({ ret: { support_adjustment_id: 'adj1' }, adjustment: { dian_status: 'accepted' } });
    await expect(reverseSupplierReturn({ id: 'sr1', ...ctx, body: { reason: 'error' } })).rejects.toThrow('Nota de Ajuste');
  });

  test('reingresa inventario, restaura la CxP y desaplica el saldo a favor', async () => {
    const { supplierReturn, own, other } = setupSupplier({
      ret: { settlement_type: 'credit', credit_applications: [{ purchase_id: 'p2', amount: 8000 }], credit_applied_amount: 8000 },
    });
    const result = await reverseSupplierReturn({ id: 'sr1', ...ctx, body: { reason: 'error' } });
    expect(mockCreateMovement).toHaveBeenCalledWith(expect.objectContaining({ movement_type: 'entrada', product_id: 'x1', quantity: 3 }), mockTx);
    expect(own.returned_amount).toBe(0);
    expect(other.paid_amount).toBe(0);
    expect(other.payment_history).toEqual([]);
    expect(supplierReturn).toMatchObject({ status: 'reversed', credit_applied_amount: 0 });
    expect(result.purchaseIds.sort()).toEqual(['p0', 'p2']);
  });

  test('reintegro recibido: se le devuelve al proveedor validando el efectivo de la caja', async () => {
    const { supplierReturn } = setupSupplier({ ret: { settlement_type: 'refund', refund_amount: 7000 } });
    await reverseSupplierReturn({ id: 'sr1', ...ctx, body: { reason: 'error', payment_method: 'Efectivo' } });
    expect(mockAssertCash).toHaveBeenCalledWith({ id: 'cs1' }, 7000, 'Efectivo');
    expect(supplierReturn).toMatchObject({ reversal_amount: 7000, reversal_cash_session_id: 'cs1' });
  });
});
