// Costo promedio ponderado (único método de costeo de inventario).
const { weightedAverageCost } = require('../utils/costResolver');

describe('weightedAverageCost', () => {
  test('promedia stock anterior y entrada', () => {
    expect(weightedAverageCost(10, 100, 10, 200)).toBe(150);
    expect(weightedAverageCost('5', '1000', '15', '1200')).toBe(1150);
  });
  test('sin stock o con stock negativo: el costo de la entrada', () => {
    expect(weightedAverageCost(0, 100, 10, 200)).toBe(200);
    expect(weightedAverageCost(-5, 100, 10, 200)).toBe(200);
  });
  test('entrada sin costo: diluye con stock, conserva el promedio sin stock', () => {
    expect(weightedAverageCost(10, 100, 10, 0)).toBe(50);
    expect(weightedAverageCost(0, 100, 10, 0)).toBe(100);
  });
});
