// Existencias y costo promedio a una fecha de corte (VNR histórico), con un
// kardex en memoria. El SQL se emula filtrando los movimientos por fecha.
jest.mock('../config/database', () => ({ sequelize: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../config/tenantContext', () => ({ getCurrentSchema: () => 'tenant_x' }));
jest.mock('../utils/tenantTime', () => ({ localDateStr: () => '2026-11-21' }));

const { sequelize } = require('../config/database');
const { stockAndCostAt } = require('../services/accounting/niifMeasurements.service');

// Producto A: compra 10 a 100 (ene), venta 4 (feb), compra 10 a 200 (mar), venta 2 (abr).
//   Hoy: 14 unidades, promedio (6×100 + 10×200)/16 = 162.5.
// La compra de marzo se digitó DESPUÉS de la venta de abril (fecha atrasada):
// el orden de creación no debe importar.
// Producto B: compra 5 a 50 en abril (después del corte de febrero): sin existencias al corte.
let MOVES;
beforeEach(() => {
  MOVES = [
    { id: 'a1', product_id: 'A', d: '2026-01-10', created: 1, movement_reason: 'purchase_receipt', direction: 'in', quantity: 10, unit_cost: 100, previous_stock: 0 },
    { id: 'a2', product_id: 'A', d: '2026-02-10', created: 2, movement_reason: 'sale', direction: 'out', quantity: 4, unit_cost: 100, previous_stock: 10 },
    { id: 'a4', product_id: 'A', d: '2026-04-05', created: 3, movement_reason: 'sale', direction: 'out', quantity: 2, unit_cost: 100, previous_stock: 6 },
    { id: 'a3', product_id: 'A', d: '2026-03-15', created: 4, movement_reason: 'purchase_receipt', direction: 'in', quantity: 10, unit_cost: 200, previous_stock: 4 },
    { id: 'b1', product_id: 'B', d: '2026-04-01', created: 5, movement_reason: 'purchase_receipt', direction: 'in', quantity: 5, unit_cost: 50, previous_stock: 0 },
  ];
  sequelize.query.mockImplementation(async (sql, { replacements }) => {
    const { cutoff } = replacements;
    if (sql.includes('movement_date::date > :cutoff')) {
      const net = {};
      for (const m of MOVES) if (m.d > cutoff) net[m.product_id] = (net[m.product_id] || 0) + (m.direction === 'in' ? m.quantity : -m.quantity);
      return Object.entries(net).map(([product_id, n]) => ({ product_id, net: n }));
    }
    if (sql.includes('movement_date::date <= :cutoff')) {
      return MOVES.filter((m) => m.d <= cutoff && replacements.ids.includes(m.product_id))
        .sort((x, y) => (x.product_id + x.d + String(x.created).padStart(3, '0')).localeCompare(y.product_id + y.d + String(y.created).padStart(3, '0')));
    }
    throw new Error(`SQL no esperado: ${sql.slice(0, 60)}`);
  });
});

const products = [
  { id: 'A', current_stock: 14, average_cost: 162.5 },
  { id: 'B', current_stock: 5, average_cost: 50 },
];

describe('VNR histórico: existencias y costo al corte', () => {
  test('al cierre de febrero: 6 unidades a 100 (la compra de marzo aún no existía)', async () => {
    const r = await stockAndCostAt('t', '2026-02-28', products);
    expect(r.get('A')).toEqual({ qty: 6, avg: 100 });
    expect(r.has('B')).toBe(false);
  });

  test('al cierre de marzo: 16 unidades a 162.5, aunque la compra se digitó con fecha atrasada', async () => {
    const r = await stockAndCostAt('t', '2026-03-31', products);
    expect(r.get('A')).toEqual({ qty: 16, avg: 162.5 });
  });

  test('corte de hoy o futuro: existencias y costo actuales, sin leer el kardex', async () => {
    const r = await stockAndCostAt('t', '2026-11-30', products);
    expect(r.get('A')).toEqual({ qty: 14, avg: 162.5 });
    expect(r.get('B')).toEqual({ qty: 5, avg: 50 });
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});
