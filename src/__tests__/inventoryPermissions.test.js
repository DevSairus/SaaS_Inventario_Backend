// 2.1 — Permisos de inventario separados (crear / editar / eliminar / aprobar).
const fs = require('fs');
const path = require('path');

const mockOverrides = [];
jest.mock('../models', () => ({
  TenantRolePermission: { findAll: jest.fn(async () => mockOverrides) },
}));

const { PERMISSIONS, PERMISSIONS_BY_KEY } = require('../config/permissions.catalog');
const service = require('../services/tenantPermissions.service');

const OLD_KEYS = ['inventory.products.write', 'inventory.warehouses.write', 'inventory.adjustments.write', 'inventory.physical_counts.write'];

describe('catálogo de permisos de inventario', () => {
  test('los permisos únicos anteriores ya no existen y los nuevos sí', () => {
    OLD_KEYS.forEach((k) => expect(PERMISSIONS_BY_KEY[k]).toBeUndefined());
    ['products', 'warehouses', 'categories', 'locations'].forEach((r) => {
      ['create', 'edit', 'delete'].forEach((a) => expect(PERMISSIONS_BY_KEY[`inventory.${r}.${a}`]).toBeDefined());
    });
    ['create', 'edit', 'delete', 'approve'].forEach((a) => expect(PERMISSIONS_BY_KEY[`inventory.adjustments.${a}`]).toBeDefined());
    expect(PERMISSIONS_BY_KEY['inventory.physical_counts.approve']).toBeDefined();
    expect(PERMISSIONS_BY_KEY['inventory.transfers.write']).toBeDefined(); // sigue: enviar/recibir/cancelar
  });

  test('los valores por defecto replican a los permisos anteriores (nadie gana ni pierde acceso)', () => {
    const same = (newKey, roles) => expect([...PERMISSIONS_BY_KEY[newKey].roles].sort()).toEqual([...roles].sort());
    const products = ['admin', 'manager', 'warehouse_keeper', 'inventory_lead'];
    ['create', 'edit', 'delete'].forEach((a) => same(`inventory.products.${a}`, products));
    const wh = ['admin', 'manager', 'warehouse_keeper'];
    ['create', 'edit', 'delete'].forEach((a) => same(`inventory.warehouses.${a}`, wh));
    ['create', 'edit', 'delete', 'approve'].forEach((a) => same(`inventory.adjustments.${a}`, wh));
    ['create', 'edit', 'delete'].forEach((a) => same(`inventory.categories.${a}`, wh));
    same('inventory.consumptions.delete', wh);
    ['create', 'approve'].forEach((a) => same(`inventory.physical_counts.${a}`, products));
    ['create', 'delete'].forEach((a) => same(`inventory.transfers.${a}`, PERMISSIONS_BY_KEY['inventory.transfers.write'].roles));
  });

  test('toda clave usada en las rutas existe en el catálogo', () => {
    const dir = path.join(__dirname, '..', 'routes');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name))));
    walk(dir);
    const used = new Set();
    files.forEach((f) => {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/require(?:Any)?Permission\(([^)]*)\)/g)) {
        for (const k of m[1].matchAll(/'([a-z_]+\.[a-z_.]+)'/g)) used.add(k[1]);
      }
    });
    expect(used.size).toBeGreaterThan(20);
    const missing = [...used].filter((k) => !PERMISSIONS_BY_KEY[k]);
    expect(missing).toEqual([]);
    OLD_KEYS.forEach((k) => expect(used.has(k)).toBe(false));
  });
});

describe('rol con "crear" sin "eliminar"', () => {
  beforeEach(() => { mockOverrides.length = 0; service.invalidate('t1'); });

  test('la empresa puede quitarle eliminar productos al bodeguero y conservar crear/editar', async () => {
    mockOverrides.push({ role: 'warehouse_keeper', permission_key: 'inventory.products.delete', allowed: false });
    expect(await service.can('t1', 'warehouse_keeper', 'inventory.products.create')).toBe(true);
    expect(await service.can('t1', 'warehouse_keeper', 'inventory.products.edit')).toBe(true);
    expect(await service.can('t1', 'warehouse_keeper', 'inventory.products.delete')).toBe(false);
  });

  test('sin excepciones, el bodeguero conserva todo lo que tenía', async () => {
    for (const a of ['create', 'edit', 'delete']) expect(await service.can('t1', 'warehouse_keeper', `inventory.products.${a}`)).toBe(true);
    expect(await service.can('t1', 'warehouse_keeper', 'inventory.adjustments.approve')).toBe(true);
  });

  test('un rol sin permiso por defecto puede recibir solo una acción', async () => {
    mockOverrides.push({ role: 'seller', permission_key: 'inventory.adjustments.create', allowed: true });
    expect(await service.can('t1', 'seller', 'inventory.adjustments.create')).toBe(true);
    expect(await service.can('t1', 'seller', 'inventory.adjustments.approve')).toBe(false);
  });
});

test('hay un PERMISSIONS por cada clave (sin duplicados)', () => {
  const keys = PERMISSIONS.map((p) => p.key);
  expect(new Set(keys).size).toBe(keys.length);
});
