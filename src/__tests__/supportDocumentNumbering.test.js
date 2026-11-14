// 3.3 — Documento Soporte: numeración propia y validación fiscal del proveedor.
// (No sustituye la prueba contra el set de habilitación de la DIAN.)
const mockFindOne = jest.fn();

jest.mock('../models', () => ({
  DianResolution: { findOne: (...args) => mockFindOne(...args) },
  // Sin tenant en simulación: getNextConsecutive no debe crear resoluciones SIM*.
  Tenant: { findByPk: jest.fn().mockResolvedValue({ id: 't1', dian_config: { environment: 'test' } }) },
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { getNextConsecutive } = require('../services/dian/dianService');
const { checkReadiness, assertReadiness, DianSupplierIncompleteError } = require('../services/dian/supplierDianReadiness');

const makeResolution = (overrides = {}) => ({
  prefix: 'DS', from_number: '1', to_number: '500', current_number: '6', valid_to: '2099-12-31',
  increment: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});
const tx = { LOCK: { UPDATE: 'UPDATE' } };

describe('getNextConsecutive – Documento Soporte', () => {
  beforeEach(() => mockFindOne.mockReset());

  test('busca la resolución propia del tipo support_document en la sede y ambiente', async () => {
    mockFindOne.mockResolvedValue(makeResolution());
    await getNextConsecutive('t1', 'b1', true, tx, null, 'support_document');
    expect(mockFindOne.mock.calls[0][0].where).toEqual({
      tenant_id: 't1', branch_id: 'b1', is_active: true, is_test: true, document_type: 'support_document',
    });
  });

  test('toma el consecutivo actual con el prefijo propio y avanza la numeración', async () => {
    const resolution = makeResolution();
    mockFindOne.mockResolvedValue(resolution);
    const result = await getNextConsecutive('t1', 'b1', false, tx, null, 'support_document');
    expect(result).toMatchObject({ consecutive: 6, invoiceNumber: 'DS6' });
    expect(resolution.increment).toHaveBeenCalledWith('current_number', { transaction: tx });
  });

  test('sin resolución propia explica que no sirve la de facturación', async () => {
    mockFindOne.mockResolvedValue(null);
    await expect(getNextConsecutive('t1', 'b1', true, tx, null, 'support_document'))
      .rejects.toThrow(/Documento Soporte.*propia resolución de numeración/);
  });

  test('un reintento reutiliza el mismo número y no consume otro', async () => {
    const resolution = makeResolution({ current_number: '10' });
    mockFindOne.mockResolvedValue(resolution);
    const result = await getNextConsecutive('t1', 'b1', true, tx, 'DS7', 'support_document');
    expect(result).toMatchObject({ consecutive: 7, invoiceNumber: 'DS7' });
    expect(resolution.increment).not.toHaveBeenCalled();
  });

  test('compara los números como números (BIGINT llega como texto): 6 no es mayor que 500', async () => {
    mockFindOne.mockResolvedValue(makeResolution({ current_number: '60', to_number: '500' }));
    await expect(getNextConsecutive('t1', 'b1', true, tx, null, 'support_document')).resolves.toMatchObject({ consecutive: 60 });
  });

  test('rechaza una resolución con el rango agotado o vencida', async () => {
    mockFindOne.mockResolvedValue(makeResolution({ current_number: '501', to_number: '500' }));
    await expect(getNextConsecutive('t1', 'b1', true, tx, null, 'support_document')).rejects.toThrow(/Se agotó el rango/);
    mockFindOne.mockResolvedValue(makeResolution({ valid_to: '2020-01-01' }));
    await expect(getNextConsecutive('t1', 'b1', true, tx, null, 'support_document')).rejects.toThrow(/venció/);
  });

  test('sin sede no consume numeración', async () => {
    await expect(getNextConsecutive('t1', null, true, tx, null, 'support_document')).rejects.toThrow(/sede/);
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});

describe('supplierDianReadiness', () => {
  test('proveedor nacional: exige identificación, tipo de persona y código DIVIPOLA', () => {
    const result = checkReadiness({ tax_id: '900123456', person_type: '', city_code: '' });
    expect(result.ready).toBe(false);
    expect(result.missing.map((f) => f.key)).toEqual(['person_type', 'city_code']);
  });

  test('proveedor completo queda listo', () => {
    expect(checkReadiness({ tax_id: '900123456', person_type: 'juridica', city_code: '05001' }).ready).toBe(true);
  });

  test('proveedor del exterior pide ciudad en texto, no código DIVIPOLA', () => {
    expect(checkReadiness({ tax_id: 'X1', person_type: 'natural', country_code: 'US', city: 'Miami' }).ready).toBe(true);
    expect(checkReadiness({ tax_id: 'X1', person_type: 'natural', country_code: 'US' }).missing.map((f) => f.key)).toEqual(['city']);
  });

  test('assertReadiness lanza un error con código y campos faltantes para la UI', () => {
    try {
      assertReadiness({ id: 'p1', tax_id: '', person_type: 'natural', city_code: '05001' });
      throw new Error('debía lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(DianSupplierIncompleteError);
      expect(e.code).toBe('DIAN_SUPPLIER_INCOMPLETE');
      expect(e.supplierId).toBe('p1');
      expect(e.missingFields).toEqual(['tax_id']);
    }
  });

  test('sin proveedor ni datos ad hoc no está listo', () => {
    expect(checkReadiness(null).ready).toBe(false);
  });
});
