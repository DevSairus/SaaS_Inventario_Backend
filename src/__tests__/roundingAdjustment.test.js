// 5.1 — Ajuste al peso: línea automática cuando el asiento no cuadra por redondeo.
const mockTenantFind = jest.fn();
const mockMappingFind = jest.fn();
const mockEntryCreate = jest.fn();
const mockLinesBulkCreate = jest.fn();

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models', () => ({
  Tenant: { findByPk: (...a) => mockTenantFind(...a) },
  AccountMapping: { findOne: (...a) => mockMappingFind(...a) },
  FiscalPeriod: { findOne: jest.fn().mockResolvedValue({ id: 'p1', status: 'open', month: 11, year: 2026 }), create: jest.fn() },
  JournalEntry: { findOne: jest.fn().mockResolvedValue(null), create: (...a) => mockEntryCreate(...a) },
  JournalEntryLine: { bulkCreate: (...a) => mockLinesBulkCreate(...a) },
}));

const {
  computeAdjustment, normalizeConfig, balanceWithAdjustment, buildTaxRoundingLine, DEFAULT_CONFIG,
} = require('../services/accounting/roundingAdjustment.service');
const { createDraftEntry } = require('../services/accounting/journalEntry.service');

const ACCOUNTS = { rounding_adjustment_income: 'acc-429581', rounding_adjustment_expense: 'acc-529581' };

beforeEach(() => {
  jest.clearAllMocks();
  mockTenantFind.mockResolvedValue({ id: 't1', tax_config: {} });
  mockMappingFind.mockImplementation(async ({ where }) => (ACCOUNTS[where.event_type] ? { account_id: ACCOUNTS[where.event_type] } : null));
  mockEntryCreate.mockImplementation(async (data) => ({ id: 'e1', ...data }));
  mockLinesBulkCreate.mockResolvedValue([]);
});

describe('computeAdjustment (pura)', () => {
  test('débitos de más → crédito a favor (ingreso)', () => {
    expect(computeAdjustment(100000.4, 100000, DEFAULT_CONFIG)).toEqual({ side: 'credit', amount: 0.4, kind: 'income' });
  });
  test('créditos de más → débito en contra (gasto)', () => {
    expect(computeAdjustment(100000, 100000.7, DEFAULT_CONFIG)).toEqual({ side: 'debit', amount: 0.7, kind: 'expense' });
  });
  test('1 centavo y 1 peso exactos se ajustan', () => {
    expect(computeAdjustment(10.01, 10, DEFAULT_CONFIG)).toMatchObject({ amount: 0.01 });
    expect(computeAdjustment(11, 10, DEFAULT_CONFIG)).toMatchObject({ amount: 1, kind: 'income' });
  });
  test('cuadrado o ruido numérico no genera línea', () => {
    expect(computeAdjustment(10, 10, DEFAULT_CONFIG)).toBeNull();
    expect(computeAdjustment(10.001, 10, DEFAULT_CONFIG)).toBeNull();
  });
  test('más del tope NO se ajusta (es un error real)', () => {
    expect(computeAdjustment(12, 10, DEFAULT_CONFIG)).toBeNull();
  });
  test('tope parametrizable y desactivable', () => {
    expect(computeAdjustment(12, 10, { ...DEFAULT_CONFIG, max_amount: 5 })).toMatchObject({ amount: 2 });
    expect(computeAdjustment(10.5, 10, { ...DEFAULT_CONFIG, enabled: false })).toBeNull();
  });
});

describe('normalizeConfig', () => {
  test('valores inválidos vuelven al default y el tope se acota a 1000', () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({ max_amount: 'abc', enabled: 'x' })).toMatchObject({ max_amount: 1, enabled: false });
    expect(normalizeConfig({ max_amount: 99999 }).max_amount).toBe(1000);
    expect(normalizeConfig({ max_amount: -3 }).max_amount).toBe(1);
  });
});

describe('balanceWithAdjustment', () => {
  const lines = [
    { account_id: 'cxc', debit: 119000.4, credit: 0 },
    { account_id: 'ing', debit: 0, credit: 100000 },
    { account_id: 'iva', debit: 0, credit: 19000 },
  ];

  test('un asiento cuadrado no consulta configuración ni mapeos', async () => {
    const r = await balanceWithAdjustment('t1', [{ debit: 5, credit: 0 }, { debit: 0, credit: 5 }]);
    expect(r.adjustment).toBeNull();
    expect(mockTenantFind).not.toHaveBeenCalled();
  });

  test('agrega la línea a 429581 marcada como ajuste y deja el asiento cuadrado', async () => {
    const r = await balanceWithAdjustment('t1', lines);
    expect(r.lines).toHaveLength(4);
    expect(r.lines[3]).toMatchObject({ account_id: 'acc-429581', credit: 0.4, debit: 0, is_rounding_adjustment: true, description: 'Ajuste al peso' });
    const d = r.lines.reduce((s, l) => s + l.debit, 0);
    const c = r.lines.reduce((s, l) => s + l.credit, 0);
    expect(Math.abs(d - c)).toBeLessThan(1e-9);
  });

  test('en contra va a 529581 (o a la cuenta que el contador haya mapeado)', async () => {
    const r = await balanceWithAdjustment('t1', [{ debit: 100, credit: 0 }, { debit: 0, credit: 100.6 }]);
    expect(r.lines[2]).toMatchObject({ account_id: 'acc-529581', debit: 0.6, credit: 0 });
  });

  test('sin mapeo de la cuenta devuelve las líneas sin tocar (comportamiento anterior)', async () => {
    mockMappingFind.mockResolvedValue(null);
    const r = await balanceWithAdjustment('t1', lines);
    expect(r.lines).toBe(lines);
    expect(r.adjustment).toBeNull();
  });

  test('usa el tope configurado por la empresa', async () => {
    mockTenantFind.mockResolvedValue({ id: 't1', tax_config: { rounding_adjustment: { max_amount: 0.1 } } });
    const r = await balanceWithAdjustment('t1', lines);
    expect(r.adjustment).toBeNull();
  });
});

describe('createDraftEntry con ajuste al peso', () => {
  const base = { entryDate: '2026-11-11', sourceType: 'sale', sourceId: 's1', description: 'Venta' };

  test('guarda la línea de ajuste y totales iguales', async () => {
    await createDraftEntry('t1', { ...base, lines: [
      { account_id: 'cxc', debit: 1000.3, credit: 0 }, { account_id: 'ing', debit: 0, credit: 1000 },
    ] });
    const header = mockEntryCreate.mock.calls[0][0];
    expect(header.total_debit).toBeCloseTo(header.total_credit, 9);
    const saved = mockLinesBulkCreate.mock.calls[0][0];
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({ account_id: 'acc-429581', credit: 0.3, is_rounding_adjustment: true, line_order: 2 });
    expect(saved[0].is_rounding_adjustment).toBe(false);
  });

  test('descuadre mayor al tope sigue rechazándose', async () => {
    await expect(createDraftEntry('t1', { ...base, lines: [
      { account_id: 'a', debit: 1010, credit: 0 }, { account_id: 'b', debit: 0, credit: 1000 },
    ] })).rejects.toThrow(/no cuadra/);
    expect(mockEntryCreate).not.toHaveBeenCalled();
  });

  test('desactivado y sin mapeo conserva la tolerancia anterior de 1 centavo', async () => {
    mockTenantFind.mockResolvedValue({ id: 't1', tax_config: { rounding_adjustment: { enabled: false } } });
    await createDraftEntry('t1', { ...base, lines: [
      { account_id: 'a', debit: 10.01, credit: 0 }, { account_id: 'b', debit: 0, credit: 10 },
    ] });
    expect(mockLinesBulkCreate.mock.calls[0][0]).toHaveLength(2);
  });
});

describe('buildTaxRoundingLine (liquidación de impuestos, aproximación al mil)', () => {
  test('positivo = en contra → débito a 529581, sin tope', async () => {
    expect(await buildTaxRoundingLine('t1', 480)).toMatchObject({ account_id: 'acc-529581', debit: 480, credit: 0, is_rounding_adjustment: true });
  });
  test('negativo = a favor → crédito a 429581', async () => {
    expect(await buildTaxRoundingLine('t1', -350)).toMatchObject({ account_id: 'acc-429581', credit: 350, debit: 0 });
  });
  test('cero o sin mapeo → null', async () => {
    expect(await buildTaxRoundingLine('t1', 0)).toBeNull();
    mockMappingFind.mockResolvedValue(null);
    expect(await buildTaxRoundingLine('t1', 480)).toBeNull();
  });
});
