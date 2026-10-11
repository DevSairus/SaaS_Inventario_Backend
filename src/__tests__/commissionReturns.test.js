// Comisiones netas de devoluciones aprobadas (commissionSettlements.controller.js).
// WorkOrder y SaleItem se toman al cargar el controlador: delegan a mockImpl.
const mockImpl = { WorkOrder: null, SaleItem: null };
const mockModels = {
  WorkOrder: { findAll: (...a) => mockImpl.WorkOrder.findAll(...a) },
  SaleItem: { findAll: (...a) => mockImpl.SaleItem.findAll(...a) },
};
jest.mock('../config/database', () => ({ sequelize: { transaction: jest.fn(), define: jest.fn(() => ({})) } }));
jest.mock('../models', () => mockModels);
jest.mock('../utils/audit', () => ({}));
jest.mock('../controllers/finance/expenses.controller', () => ({ generateExpenseNumber: jest.fn() }));
jest.mock('../services/workshop/commissionCategory.service', () => ({ getOrCreateDefaultCategory: jest.fn(), getEffectivePercentage: jest.fn() }));

const { netSaleItemsOfReturns, netWorkOrderItemsOfReturns } = require('../controllers/workshop/commissionSettlements.controller');

const item = (data) => ({ ...data, setDataValue(k, v) { this[k] = v; } });

beforeEach(() => {
  Object.assign(mockModels, {
    CustomerReturn: { findAll: jest.fn(async () => [{ id: 'r1' }]) },
    CustomerReturnItem: { findAll: jest.fn(async () => [{ sale_item_id: 'si1', quantity: 1 }]) },
  });
});

test('línea de venta: descuenta lo devuelto en proporción', async () => {
  const si = item({ id: 'si1', sale_id: 's1', quantity: 4, subtotal: 400, total: 476 });
  await netSaleItemsOfReturns([si]);
  expect(si).toMatchObject({ quantity: 3, subtotal: 300, total: 357 });
});

test('línea de venta sin devoluciones: no cambia', async () => {
  mockModels.CustomerReturn.findAll = jest.fn(async () => []);
  const si = item({ id: 'si1', sale_id: 's1', quantity: 4, subtotal: 400, total: 476 });
  await netSaleItemsOfReturns([si]);
  expect(si).toMatchObject({ quantity: 4, total: 476 });
});

describe('línea de OT: descuenta lo devuelto sobre su factura', () => {
  beforeEach(() => {
    mockImpl.WorkOrder = { findAll: jest.fn(async () => [{ id: 'wo1', sale_id: 's1' }]) };
  });

  test('vínculo directo (work_order_item_id)', async () => {
    mockImpl.SaleItem = { findAll: jest.fn(async () => [{ id: 'si1', sale_id: 's1', work_order_item_id: 'woi1', product_id: 'p1', quantity: 2 }]) };
    const woi = item({ id: 'woi1', work_order_id: 'wo1', product_id: 'p1', quantity: 2, subtotal: 200, total: 238 });
    await netWorkOrderItemsOfReturns([woi]);
    expect(woi).toMatchObject({ quantity: 1, subtotal: 100, total: 119 });
  });

  test('factura anterior al vínculo: empareja por producto', async () => {
    mockImpl.SaleItem = { findAll: jest.fn(async () => [{ id: 'si1', sale_id: 's1', work_order_item_id: null, product_id: 'p1', quantity: 2 }]) };
    const woi = item({ id: 'woi1', work_order_id: 'wo1', product_id: 'p1', quantity: 2, subtotal: 200, total: 238 });
    await netWorkOrderItemsOfReturns([woi]);
    expect(woi.total).toBe(119);
  });

  test('OT sin factura: no cambia', async () => {
    mockImpl.WorkOrder = { findAll: jest.fn(async () => []) };
    const woi = item({ id: 'woi1', work_order_id: 'wo1', product_id: 'p1', quantity: 2, total: 238 });
    await netWorkOrderItemsOfReturns([woi]);
    expect(woi.total).toBe(238);
  });
});
