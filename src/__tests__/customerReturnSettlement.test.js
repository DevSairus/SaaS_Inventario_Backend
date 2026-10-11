// Aprobación de devoluciones de cliente (customerReturns.controller.js):
// liquidación al aprobar (settleCustomerReturn), validación de cantidades y
// nota crédito electrónica.
const mockAdvanceCreate = jest.fn(async (data) => ({ id: 'adv-1', ...data }));
const mockSaleFindOne = jest.fn();
const mockReturnFindAll = jest.fn(async () => []);
const mockItemSum = jest.fn(async () => 0);
const mockGetOpenSession = jest.fn();
const mockIsTreasuryEnabled = jest.fn();
const mockCreateCreditNote = jest.fn(async () => ({ noteSale: { id: 'nc-1' } }));
const mockReturnUpdate = jest.fn();

jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn(), define: jest.fn(() => ({})) } }));
jest.mock('../models', () => ({
  Sale: { findOne: (...args) => mockSaleFindOne(...args) },
  CustomerAdvance: { create: (...args) => mockAdvanceCreate(...args) },
  CustomerReturn: { update: (...args) => mockReturnUpdate(...args), findAll: (...args) => mockReturnFindAll(...args) },
  CustomerReturnItem: { sum: (...args) => mockItemSum(...args) },
}));
jest.mock('../services/sales/creditNote.service', () => ({
  createAndSendCreditNote: (...args) => mockCreateCreditNote(...args),
}));
jest.mock('../config/tenantContext', () => ({ getCurrentSchema: jest.fn() }));
jest.mock('../middleware/autoCheckAlerts.middleware', () => ({ markProductsForAlertCheck: jest.fn() }));
jest.mock('../utils/costResolver', () => ({ resolveUnitCost: jest.fn() }));
jest.mock('../services/finance/advanceNumber.service', () => ({ generateAdvanceNumber: jest.fn(async () => 'ANT-0001') }));
jest.mock('../services/finance/cashSession.service', () => ({
  getOpenSession: (...args) => mockGetOpenSession(...args),
  isTreasuryEnabled: (...args) => mockIsTreasuryEnabled(...args),
  assertCashAvailable: jest.fn(),
}));
jest.mock('../services/accounting/bankAccountSelection', () => ({
  resolveSelectedBankAccountId: jest.fn(async (_t, id, method) => (/efectivo/i.test(method) ? null : id || null)),
}));

const {
  settleCustomerReturn,
  validateReturnQuantities,
  issueReturnCreditNote,
} = require('../controllers/sales/customerReturns.controller');

const tx = { LOCK: { UPDATE: 'UPDATE' } };
const ctx = { user: { id: 'u1', tenant_id: 't1' }, branch_id: 'b1' };
const makeSale = (over = {}) => ({
  id: 's1', total_amount: 100000, paid_amount: 40000, returned_amount: 0, customer_id: 'c1', branch_id: 'b1',
  payment_history: [], update: jest.fn(), ...over,
});
const makeReturn = (over = {}) => ({ id: 'r1', sale_id: 's1', return_number: 'DEV-0001', total_amount: 50000, ...over });

beforeEach(() => {
  mockAdvanceCreate.mockClear();
  mockGetOpenSession.mockReset();
  mockIsTreasuryEnabled.mockReset();
  mockReturnFindAll.mockReset().mockResolvedValue([]);
  mockItemSum.mockReset().mockResolvedValue(0);
});

describe('settleCustomerReturn', () => {
  test('lo devuelto baja primero el saldo; sin excedente no pide elegir nada', async () => {
    const sale = makeSale();
    mockSaleFindOne.mockResolvedValue(sale);
    const fields = await settleCustomerReturn(makeReturn(), {}, ctx, tx);
    expect(fields).toMatchObject({ receivable_reduction: 50000, money_back_amount: 0 });
    expect(sale.update).toHaveBeenCalledWith({ returned_amount: 50000, payment_status: 'partial' }, { transaction: tx });
  });

  test('devoluciones sucesivas con pago intermedio: se devuelve todo lo pagado de más', async () => {
    // Ya se devolvió 50.000 (cartera) y luego el cliente pagó los 10.000 que debía.
    const sale = makeSale({ paid_amount: 50000, returned_amount: 50000 });
    mockSaleFindOne.mockResolvedValue(sale);
    mockIsTreasuryEnabled.mockResolvedValue(true);
    mockGetOpenSession.mockResolvedValue({ id: 'cs1' });
    const fields = await settleCustomerReturn(makeReturn(), { settlement_type: 'refund' }, ctx, tx);
    expect(fields).toMatchObject({ receivable_reduction: 0, money_back_amount: 50000, refund_amount: 50000, refund_cash_session_id: 'cs1' });
  });

  test('con excedente exige elegir devolver o saldo a favor', async () => {
    mockSaleFindOne.mockResolvedValue(makeSale({ paid_amount: 100000 }));
    await expect(settleCustomerReturn(makeReturn(), {}, ctx, tx)).rejects.toMatchObject({ status: 400 });
  });

  test('saldo a favor: anticipo marcado con la devolución', async () => {
    mockSaleFindOne.mockResolvedValue(makeSale({ paid_amount: 100000 }));
    const fields = await settleCustomerReturn(makeReturn(), { settlement_type: 'credit' }, ctx, tx);
    expect(fields).toMatchObject({ settlement_type: 'credit', money_back_amount: 50000, credit_advance_id: 'adv-1' });
    expect(mockAdvanceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50000, customer_return_id: 'r1', customer_id: 'c1' }),
      { transaction: tx }
    );
  });

  test('saldo a favor sin cliente: error', async () => {
    mockSaleFindOne.mockResolvedValue(makeSale({ paid_amount: 100000, customer_id: null }));
    await expect(settleCustomerReturn(makeReturn(), { settlement_type: 'credit' }, ctx, tx)).rejects.toMatchObject({ status: 400 });
  });

  test('devolver dinero con Tesorería y sin caja abierta: error', async () => {
    mockSaleFindOne.mockResolvedValue(makeSale({ paid_amount: 100000 }));
    mockIsTreasuryEnabled.mockResolvedValue(true);
    mockGetOpenSession.mockResolvedValue(null);
    await expect(settleCustomerReturn(makeReturn(), { settlement_type: 'refund' }, ctx, tx)).rejects.toMatchObject({ status: 400 });
  });

  test('retenciones del cliente: se reversan, no se devuelven en dinero', async () => {
    // 97.000 en caja + 3.000 de retención; devuelve todo.
    mockSaleFindOne.mockResolvedValue(makeSale({
      paid_amount: 100000,
      payment_history: [{ source: 'retention', amount: 3000, retentions: { retefuente: 2500, reteiva: 0, reteica: 500 } }],
    }));
    const fields = await settleCustomerReturn(makeReturn({ total_amount: 100000 }), { settlement_type: 'credit' }, ctx, tx);
    expect(fields).toMatchObject({
      receivable_reduction: 0,
      money_back_amount: 97000,
      retention_reversal: { retefuente: 2500, reteiva: 0, reteica: 500 },
    });
  });

  test('reversión de OT (sin settlement): no pide elegir, deja el excedente al asiento', async () => {
    mockSaleFindOne.mockResolvedValue(makeSale({ paid_amount: 100000 }));
    const fields = await settleCustomerReturn(makeReturn(), null, ctx, tx);
    expect(fields).toEqual({ receivable_reduction: 0, money_back_amount: 50000, retention_reversal: { retefuente: 0, reteiva: 0, reteica: 0 } });
  });

  test('venta dentro de una factura agrupada: error', async () => {
    mockSaleFindOne.mockResolvedValue(makeSale({ invoiced_in_sale_id: 'inv-1' }));
    await expect(settleCustomerReturn(makeReturn(), {}, ctx, tx)).rejects.toMatchObject({ status: 400 });
  });
});

describe('validateReturnQuantities', () => {
  const sale = { id: 's1', items: [{ id: 'si1', quantity: 5, product_name: 'Filtro' }] };

  test('agrupa líneas repetidas antes de comparar con lo disponible', async () => {
    mockItemSum.mockResolvedValue(2);
    await expect(validateReturnQuantities(sale, [
      { sale_item_id: 'si1', quantity: 2 }, { sale_item_id: 'si1', quantity: 2 },
    ], {})).rejects.toThrow('solo quedan 3');
  });

  test('cantidades negativas o inválidas: error', async () => {
    await expect(validateReturnQuantities(sale, [{ sale_item_id: 'si1', quantity: -1 }], {})).rejects.toMatchObject({ status: 400 });
    await expect(validateReturnQuantities(sale, [{ sale_item_id: 'si1', quantity: 'abc' }], {})).rejects.toMatchObject({ status: 400 });
  });

  test('solo cuenta devoluciones pendientes/aprobadas (no rechazadas)', async () => {
    await validateReturnQuantities(sale, [{ sale_item_id: 'si1', quantity: 5 }], { countPending: true });
    expect(mockReturnFindAll.mock.calls[0][0].where.status).toEqual({ [require('sequelize').Op.in]: ['pending', 'approved'] });
    await validateReturnQuantities(sale, [{ sale_item_id: 'si1', quantity: 5 }], { countPending: false });
    expect(mockReturnFindAll.mock.calls[1][0].where.status).toEqual({ [require('sequelize').Op.in]: ['approved'] });
  });

  test('producto ya devuelto completo: mensaje claro', async () => {
    mockItemSum.mockResolvedValue(5);
    await expect(validateReturnQuantities(sale, [{ sale_item_id: 'si1', quantity: 1 }], {})).rejects.toThrow('ya fue devuelto en su totalidad');
  });
});

describe('issueReturnCreditNote', () => {
  const ret = () => ({
    id: 'r1', sale_id: 's1', return_number: 'DEV-0001', reason: 'defective',
    items: [{ sale_item_id: 'si1', quantity: '2' }, { sale_item_id: null, quantity: 1 }],
  });
  beforeEach(() => { mockCreateCreditNote.mockClear(); mockReturnUpdate.mockClear(); });

  test('factura electrónica aceptada: nota crédito solo fiscal, por los ítems devueltos', async () => {
    mockSaleFindOne.mockResolvedValue({ id: 's1', document_type: 'factura', dian_status: 'accepted', cufe: 'abc', is_consolidated_invoice: false });
    const note = await issueReturnCreditNote(ret(), 't1', 'u1');
    expect(note).toEqual({ id: 'nc-1' });
    expect(mockCreateCreditNote).toHaveBeenCalledWith(expect.objectContaining({
      saleId: 's1',
      items: [{ sale_item_id: 'si1', quantity: 2 }],
      skipAccounting: true,
      reason: 'Devolución DEV-0001: Producto Defectuoso',
    }));
    expect(mockReturnUpdate).toHaveBeenCalledWith({ credit_note_sale_id: 'nc-1' }, { where: { id: 'r1', tenant_id: 't1' } });
  });

  test('remisión o factura no electrónica: no emite nota', async () => {
    mockSaleFindOne.mockResolvedValue({ id: 's1', document_type: 'remision', dian_status: 'not_applicable', cufe: null });
    await expect(issueReturnCreditNote(ret(), 't1', 'u1')).resolves.toBeNull();
    expect(mockCreateCreditNote).not.toHaveBeenCalled();
  });

  test('ya tiene nota: no emite otra', async () => {
    await expect(issueReturnCreditNote({ ...ret(), credit_note_sale_id: 'nc-0' }, 't1', 'u1')).resolves.toBeNull();
    expect(mockCreateCreditNote).not.toHaveBeenCalled();
  });
});
