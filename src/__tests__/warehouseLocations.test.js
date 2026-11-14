// 2.2 / 2.3 — Reglas de ubicaciones de bodega y familia de categorías.
const { Op } = require('sequelize');
jest.mock('../config/database', () => ({ sequelize: { define: jest.fn(() => ({})) } }));

const svc = require('../services/inventory/warehouseLocations.service');

describe('normalizeLocationInput', () => {
  test('compone el código desde pasillo-estante-nivel', () => {
    expect(svc.normalizeLocationInput({ aisle: 'a', shelf: '3', level: '2' })).toMatchObject({ code: 'A-3-2', aisle: 'a', shelf: '3', level: '2' });
  });
  test('respeta el código explícito y lo pasa a mayúsculas', () => {
    expect(svc.normalizeLocationInput({ code: ' bod-9 ' }).code).toBe('BOD-9');
  });
  test('sin código ni partes es un error 400', () => {
    expect(() => svc.normalizeLocationInput({})).toThrow(expect.objectContaining({ status: 400 }));
  });
  test('código y descripción demasiado largos', () => {
    expect(() => svc.normalizeLocationInput({ code: 'X'.repeat(41) })).toThrow(/40/);
    expect(() => svc.normalizeLocationInput({ code: 'A', description: 'd'.repeat(201) })).toThrow(/200/);
  });
});

describe('resolveProductLocation', () => {
  const WL = (loc) => ({ findOne: jest.fn(async () => loc) });
  const base = { tenantId: 't1', warehouseId: 'w1', locationId: 'l1' };

  test('sin ubicación devuelve null', async () => {
    expect(await svc.resolveProductLocation({ ...base, locationId: null, WarehouseLocation: WL(null) })).toBeNull();
  });
  test('exige bodega en el producto', async () => {
    await expect(svc.resolveProductLocation({ ...base, warehouseId: null, WarehouseLocation: WL({}) })).rejects.toMatchObject({ status: 400 });
  });
  test('rechaza inexistente, inactiva y de otra bodega', async () => {
    await expect(svc.resolveProductLocation({ ...base, WarehouseLocation: WL(null) })).rejects.toThrow('no existe');
    await expect(svc.resolveProductLocation({ ...base, WarehouseLocation: WL({ id: 'l1', code: 'A-1', is_active: false, warehouse_id: 'w1' }) })).rejects.toThrow('inactiva');
    await expect(svc.resolveProductLocation({ ...base, WarehouseLocation: WL({ id: 'l1', code: 'A-1', is_active: true, warehouse_id: 'w2' }) })).rejects.toThrow('otra bodega');
  });
  test('acepta la ubicación válida de la misma bodega', async () => {
    expect(await svc.resolveProductLocation({ ...base, WarehouseLocation: WL({ id: 'l1', code: 'A-1', is_active: true, warehouse_id: 'w1' }) })).toBe('l1');
  });
});

describe('expandRanges', () => {
  test('pasillos × estantes × niveles, estantes con 2 dígitos', () => {
    const r = svc.expandRanges({ aisles: ['A', 'B'], shelves: 2, levels: 2 });
    expect(r).toHaveLength(8);
    expect(r[0]).toMatchObject({ code: 'A-01-1', aisle: 'A', shelf: '01', level: '1' });
    expect(r[7].code).toBe('B-02-2');
  });
  test('solo pasillos', () => {
    expect(svc.expandRanges({ aisles: ['A', 'B'] }).map((x) => x.code)).toEqual(['A', 'B']);
  });
  test('exige pasillo y limita a 500', () => {
    expect(() => svc.expandRanges({ aisles: [], shelves: 2 })).toThrow('pasillo');
    expect(() => svc.expandRanges({ aisles: ['A', 'B', 'C'], shelves: 20, levels: 10 })).toThrow('500');
  });
});

describe('orden de recorrido', () => {
  test('natural (A-2 antes de A-10) y sin ubicación al final', () => {
    const codes = ['A-10', null, 'A-2', 'B-1', 'A-1'];
    expect([...codes].sort(svc.compareLocationCodes)).toEqual(['A-1', 'A-2', 'A-10', 'B-1', null]);
  });
});

describe('categoryFamilyIds (familia = categoría + subcategorías)', () => {
  const tree = { root: ['c1', 'c2'], c1: ['c11'], c11: ['c111'], c2: [], c111: [], other: ['x'] };
  const Category = {
    findAll: jest.fn(async ({ where }) => {
      const parents = where.parent_id[Op.in];
      return parents.flatMap((p) => (tree[p] || []).map((id) => ({ id })));
    }),
  };
  test('incluye todos los descendientes y no los de otras ramas', async () => {
    const ids = await svc.categoryFamilyIds({ Category, tenantId: 't1', categoryId: 'root' });
    expect(ids.sort()).toEqual(['c1', 'c11', 'c111', 'c2', 'root']);
  });
  test('una hoja es solo ella misma', async () => {
    expect(await svc.categoryFamilyIds({ Category, tenantId: 't1', categoryId: 'c2' })).toEqual(['c2']);
  });
  test('un ciclo en los datos no cuelga la consulta', async () => {
    const cyc = { findAll: jest.fn(async ({ where }) => where.parent_id[Op.in].map((p) => ({ id: p === 'a' ? 'b' : 'a' }))) };
    const ids = await svc.categoryFamilyIds({ Category: cyc, tenantId: 't1', categoryId: 'a' });
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
