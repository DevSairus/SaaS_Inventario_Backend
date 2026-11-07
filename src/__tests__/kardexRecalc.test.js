// Recálculo del kardex en orden de fecha (cálculo puro).
jest.mock('../config/database', () => ({ sequelize: { literal: jest.fn((x) => x) } }));
jest.mock('../models', () => ({}));

const { recomputeKardex } = require('../services/inventory/kardexRecalc.service');

const mv = (id, type, direction, quantity, unit_cost) => ({ id, movement_reason: type, direction, quantity, unit_cost });

describe('recomputeKardex', () => {
  test('compra registrada tarde: las ventas posteriores a su fecha toman el nuevo promedio', () => {
    // Orden por fecha: compra 10 a $100, compra atrasada 10 a $200, venta 5.
    // La venta se registró con $100 (antes de ingresar la segunda compra).
    const { rows, finalAvg, finalQty } = recomputeKardex([
      mv('c1', 'purchase_receipt', 'in', 10, 100),
      mv('c2', 'purchase_receipt', 'in', 10, 200),
      mv('v1', 'sale', 'out', 5, 100),
    ]);
    expect(rows.find((r) => r.id === 'v1')).toMatchObject({ oldCost: 100, newCost: 150, changed: true });
    expect(rows.filter((r) => r.changed)).toHaveLength(1);
    expect(finalAvg).toBe(150);
    expect(finalQty).toBe(15);
  });

  test('traslados no cambian el promedio, pero toman el promedio vigente a su fecha', () => {
    const { rows, finalAvg } = recomputeKardex([
      mv('c1', 'purchase_receipt', 'in', 10, 100),
      mv('t1', 'transfer_send', 'out', 4, 90),
      mv('t2', 'transfer_receive', 'in', 4, 90),
      mv('v1', 'sale', 'out', 2, 100),
    ]);
    expect(finalAvg).toBe(100);
    expect(rows.find((r) => r.id === 't1')).toMatchObject({ newCost: 100, changed: true });
    expect(rows.find((r) => r.id === 't2')).toMatchObject({ newCost: 100, changed: true });
    expect(rows.find((r) => r.id === 'v1').changed).toBe(false);
  });

  test('devolución de cliente vuelve al promedio; devolución a proveedor sale con su costo', () => {
    const { rows, finalAvg } = recomputeKardex([
      mv('c1', 'purchase_receipt', 'in', 10, 100),
      mv('c2', 'purchase_receipt', 'in', 10, 200),
      mv('d1', 'customer_return', 'in', 1, 100),
      mv('p1', 'supplier_return', 'out', 10, 200),
    ]);
    expect(rows.find((r) => r.id === 'd1')).toMatchObject({ newCost: 150, changed: true });
    expect(rows.find((r) => r.id === 'p1')).toMatchObject({ newCost: 200, changed: false });
    // Quedan 11 unidades: (21 × 150 − 10 × 200) / 11
    expect(finalAvg).toBe(104.55);
  });

  test('saldo inicial y stock negativo', () => {
    const { rows } = recomputeKardex([
      mv('v1', 'sale', 'out', 8, 50),
      mv('c1', 'purchase_receipt', 'in', 10, 80),
      mv('v2', 'sale', 'out', 2, 50),
    ], { qty: 5, avg: 50 });
    // 5 − 8 = −3 → entra 10 a 80: con stock negativo el promedio es el de la entrada.
    expect(rows.find((r) => r.id === 'v2')).toMatchObject({ newCost: 80, changed: true });
  });
});
