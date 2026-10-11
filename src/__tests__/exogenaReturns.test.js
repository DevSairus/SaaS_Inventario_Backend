// Exógena con devoluciones aprobadas en el año (services/returns/returnFiscalData.js).
const mockQuery = jest.fn();
const mockCustomerReturns = jest.fn(async () => []);
const mockSupplierReturns = jest.fn(async () => []);
jest.mock('../config/database', () => ({ sequelize: { query: (...a) => mockQuery(...a), define: jest.fn(() => ({})) } }));
jest.mock('../config/tenantContext', () => ({ getCurrentSchema: () => 'tenant_x' }));
jest.mock('../services/returns/returnFiscalData', () => ({
  approvedCustomerReturns: (...a) => mockCustomerReturns(...a),
  approvedSupplierReturns: (...a) => mockSupplierReturns(...a),
  isPriorYearDocument: jest.requireActual('../services/returns/returnFiscalData').isPriorYearDocument,
}));

const customer = { customer_id: 'c1', tax_id: '900123456', document_type: '31', business_name: 'ACME SAS' };

beforeEach(() => { mockQuery.mockReset(); mockCustomerReturns.mockReset().mockResolvedValue([]); mockSupplierReturns.mockReset().mockResolvedValue([]); });

test('1007: devoluciones de clientes van en dred', async () => {
  mockQuery.mockResolvedValue([{ ...customer, ibru: 1000000, dred: 50000 }]);
  mockCustomerReturns.mockResolvedValue([{ ...customer, base: 200000 }]);
  const svc = require('../services/exogena/format1007.service');
  const { records } = await svc.buildRecords('t1', 2026, { sale: '4001' });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ ibru: 1000000, dred: 250000 });
});

test('1007: cliente con devolución pero sin ventas en el año sale con ibru 0', async () => {
  mockQuery.mockResolvedValue([]);
  mockCustomerReturns.mockResolvedValue([{ ...customer, base: 80000 }]);
  const svc = require('../services/exogena/format1007.service');
  const { records } = await svc.buildRecords('t1', 2026, { sale: '4001' });
  expect(records[0]).toMatchObject({ ibru: 0, dred: 80000 });
});

test('1005: IVA de devoluciones en ventas (ivade) por cliente', async () => {
  mockQuery.mockResolvedValue([]);
  mockCustomerReturns.mockResolvedValue([{ ...customer, tax_net: 19000 }]);
  const svc = require('../services/exogena/format1005.service');
  const { records } = await svc.buildRecords('t1', 2026);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ vimp: 0, ivade: 19000 });
});

test('1006: IVA recuperado en devoluciones de compras por proveedor', async () => {
  mockQuery.mockResolvedValue([]);
  mockSupplierReturns.mockResolvedValue([{ supplier_id: 's1', tax_id: '800111222', document_type: '31', business_name: 'PROV SAS', tax_net: 3800 }]);
  const svc = require('../services/exogena/format1006.service');
  const { records } = await svc.buildRecords('t1', 2026);
  expect(records[0]).toMatchObject({ imp: 0, iva: 3800 });
});

test('1003: la retención de lo devuelto se descuenta, nunca por debajo de 0', async () => {
  mockQuery.mockResolvedValue([{ ...customer, valor: 1000000, ret: 25000 }]);
  mockCustomerReturns.mockResolvedValue([{ ...customer, base: 400000, sale_retefuente: 25000, retefuente_share: 10000 }]);
  const svc = require('../services/exogena/format1003.service');
  const { records } = await svc.buildRecords('t1', 2026);
  expect(records[0]).toMatchObject({ valor: 600000, ret: 15000 });
});

describe('opción prior_year_returns (1003)', () => {
  const priorYearReturn = { ...customer, base: 400000, sale_retefuente: 25000, retefuente_share: 10000, sale_date: '2025-11-20' };

  test('por defecto (skip): la devolución de una factura del año anterior no cambia el formato', async () => {
    mockQuery.mockResolvedValue([{ ...customer, valor: 1000000, ret: 25000 }]);
    mockCustomerReturns.mockResolvedValue([priorYearReturn]);
    const svc = require('../services/exogena/format1003.service');
    const { records } = await svc.buildRecords('t1', 2026, {}, {});
    expect(records[0]).toMatchObject({ valor: 1000000, ret: 25000 });
  });

  test('subtract: se resta en el año de la devolución', async () => {
    mockQuery.mockResolvedValue([{ ...customer, valor: 1000000, ret: 25000 }]);
    mockCustomerReturns.mockResolvedValue([priorYearReturn]);
    const svc = require('../services/exogena/format1003.service');
    const { records } = await svc.buildRecords('t1', 2026, {}, { prior_year_returns: 'subtract' });
    expect(records[0]).toMatchObject({ valor: 600000, ret: 15000 });
  });

  test('subtract sin retenciones del cliente este año: se informa como excluida', async () => {
    mockQuery.mockResolvedValue([]);
    mockCustomerReturns.mockResolvedValue([priorYearReturn]);
    const svc = require('../services/exogena/format1003.service');
    const { records, skipped } = await svc.buildRecords('t1', 2026, {}, { prior_year_returns: 'subtract' });
    expect(records).toHaveLength(0);
    expect(skipped).toEqual([expect.objectContaining({ reason: 'devolucion_sin_retenciones_en_el_ano' })]);
  });
});
