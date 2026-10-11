// Fuentes de Flujo de Caja / cuadre de caja (buildCashFlow): abonos a saldos
// iniciales, reintegros por devolución, saldo a favor de una devolución (no
// es dinero nuevo) y fechas que llegan como objeto Date.
const rows = {};
const model = (key) => ({ findAll: jest.fn(async () => rows[key] || []) });

jest.mock('../models', () => ({
  Sale: model('Sale'),
  Purchase: model('Purchase'),
  Expense: model('Expense'),
  WorkOrder: model('WorkOrder'),
  CustomerAdvance: model('CustomerAdvance'),
  OpeningBalance: model('OpeningBalance'),
  CustomerReturn: model('CustomerReturn'),
  SupplierReturn: model('SupplierReturn'),
  Supplier: {},
  Customer: {},
  Tenant: {},
}));
jest.mock('../services/pdfService', () => ({}));
jest.mock('../services/excelService', () => ({}));
jest.mock('../services/accounting/cashReconciliation.service', () => ({}));
jest.mock('../utils/branchFilter', () => ({}));
jest.mock('../services/workshop/workOrderPayments.service', () => ({ transferableAmount: (p) => Number(p.amount) }));

const { buildCashFlow } = require('../controllers/finance/cashflow.controller');

const DAY = '2026-10-09';

beforeEach(() => {
  rows.CustomerAdvance = [
    // Anticipo normal: dinero nuevo (fecha como Date, columna TIMESTAMPTZ).
    { advance_number: 'ANT-1', amount: '50000', received_date: new Date(`${DAY}T15:00:00Z`), method: 'Efectivo', branch_id: 'b1', cash_session_id: 'cs1', refund_history: [] },
    // Saldo a favor de una devolución: NO es dinero nuevo.
    { advance_number: 'ANT-2', amount: '20000', received_date: new Date(`${DAY}T16:00:00Z`), method: null, branch_id: 'b1', customer_return_id: 'r1', refund_history: [] },
  ];
  rows.OpeningBalance = [
    { type: 'receivable', reference: 'SI-1', branch_id: 'b1', customer: { business_name: 'ACME' }, payment_history: [{ date: `${DAY}T17:00:00Z`, amount: 30000, method: 'Efectivo', branch_id: 'b1', cash_session_id: 'cs1' }] },
    { type: 'payable', reference: 'SI-2', branch_id: 'b1', supplier: { name: 'Prov' }, payment_history: [{ date: `${DAY}T18:00:00Z`, amount: 10000, method: 'Transferencia', branch_id: 'b1', cash_session_id: 'cs1' }] },
  ];
  rows.SupplierReturn = [
    { return_number: 'DP-1', refund_amount: '8000', refund_method: 'Transferencia', refund_date: new Date(`${DAY}T20:00:00Z`), refund_branch_id: 'b1', refund_cash_session_id: 'cs1', supplier: { name: 'Prov' } },
  ];
  rows.Purchase = [
    { purchase_number: 'OC-1', branch_id: 'b1', supplier: { name: 'Prov' }, payment_history: [
      { date: `${DAY}T10:00:00Z`, amount: 5000, method: 'Efectivo' },
      // Saldo a favor de una devolución aplicado: no es salida de dinero.
      { date: `${DAY}T11:00:00Z`, amount: 3000, method: 'Saldo a favor', source: 'supplier_credit' },
    ] },
  ];
  rows.CustomerReturn = [
    { return_number: 'DEV-1', refund_amount: '15000', refund_method: 'Efectivo', refund_date: new Date(`${DAY}T19:00:00Z`), refund_branch_id: 'b1', refund_cash_session_id: 'cs1', customer: { first_name: 'Ana', last_name: 'Gil' } },
  ];
});

test('incluye las fuentes nuevas y excluye el saldo a favor', async () => {
  const flow = await buildCashFlow('t1', { from_date: DAY, to_date: DAY, branch_id: 'b1' });
  const bySource = Object.fromEntries(flow.allTransactions.map((t) => [t.reference, t]));

  expect(bySource['ANT-1']).toMatchObject({ date: DAY, direction: 'in', amount: 50000 });
  expect(bySource['ANT-2']).toBeUndefined();
  expect(bySource['SI-1']).toMatchObject({ source: 'opening_receivable', direction: 'in', amount: 30000, cash_session_id: 'cs1' });
  expect(bySource['SI-2']).toMatchObject({ source: 'opening_payable', direction: 'out', amount: 10000 });
  expect(bySource['DP-1']).toMatchObject({ source: 'supplier_return_refund', direction: 'in', amount: 8000 });
  const purchaseOuts = flow.allTransactions.filter((t) => t.reference === 'OC-1');
  expect(purchaseOuts).toHaveLength(1);
  expect(purchaseOuts[0]).toMatchObject({ direction: 'out', amount: 5000 });
  expect(bySource['DEV-1']).toMatchObject({ source: 'customer_return_refund', direction: 'out', amount: 15000, date: DAY, cash_session_id: 'cs1' });
});
