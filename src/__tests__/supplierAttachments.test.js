// 3.1 — Adjuntos del proveedor: RUT, Cámara de Comercio y su vigencia.
jest.mock('../models', () => ({ Attachment: { KINDS: ['rut', 'chamber_of_commerce', 'other'] }, User: {} }));
jest.mock('../utils/audit', () => jest.fn());
jest.mock('../services/tenantPermissions.service', () => ({ can: jest.fn() }));
jest.mock('../services/attachments/attachmentStorage', () => ({}));

const { parseValidUntil, ENTITIES } = require('../controllers/attachments.controller');

describe('vigencia de adjuntos', () => {
  test('acepta fechas reales y vacío', () => {
    expect(parseValidUntil('2026-12-31')).toBe('2026-12-31');
    expect(parseValidUntil('2028-02-29')).toBe('2028-02-29');
    expect(parseValidUntil('')).toBeNull();
    expect(parseValidUntil(undefined)).toBeNull();
  });

  test('rechaza fechas imposibles o con otro formato', () => {
    for (const bad of ['2026-02-31', '31/12/2026', '2026-13-01', 'mañana', '2027-02-29']) {
      expect(() => parseValidUntil(bad)).toThrow(/vigencia/);
    }
  });
});

describe('proveedor como entidad con adjuntos', () => {
  test('está habilitado y restringido a los roles que gestionan proveedores', () => {
    expect(ENTITIES.supplier).toMatchObject({ model: 'Supplier', label: 'proveedor' });
    expect(ENTITIES.supplier.roles).toEqual(expect.arrayContaining(['admin', 'accountant', 'warehouse_keeper']));
    expect(ENTITIES.supplier.roles).not.toContain('viewer');
  });
});
