// 3.2 — Aviso a contabilidad por alta de cliente/proveedor.
const mockUserFindAll = jest.fn();
const mockSendEmail = jest.fn();
const mockSupplierFindOne = jest.fn();

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models', () => ({
  User: { findAll: (...a) => mockUserFindAll(...a) },
  Supplier: { findOne: (...a) => mockSupplierFindOne(...a) },
  Customer: { findOne: jest.fn() },
}));
jest.mock('../services/emailService', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const svc = require('../services/accounting/thirdPartySetup.service');

beforeEach(() => { jest.clearAllMocks(); mockSendEmail.mockResolvedValue({ success: true }); });

describe('notifyNewThirdParty', () => {
  test('envía un solo correo a los contadores activos, sin repetidos ni vacíos', async () => {
    mockUserFindAll.mockResolvedValue([{ email: 'Ana@x.co' }, { email: 'ana@x.co ' }, { email: null }, { email: 'luis@x.co' }]);
    const r = await svc.notifyNewThirdParty('t1', 'supplier', { name: 'Aceros SAS', tax_id: '900123' }, { creatorName: 'Sergio' });
    expect(r.notified).toBe(2);
    expect(mockUserFindAll.mock.calls[0][0].where).toEqual({ tenant_id: 't1', role: 'accountant', is_active: true });
    const mail = mockSendEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['ana@x.co', 'luis@x.co']);
    expect(mail.subject).toBe('Nuevo proveedor por configurar: Aceros SAS');
  });

  test('sin contadores no envía nada', async () => {
    mockUserFindAll.mockResolvedValue([]);
    expect(await svc.notifyNewThirdParty('t1', 'customer', { first_name: 'A' })).toEqual({ notified: 0 });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('si el correo falla no lanza (el alta no se afecta)', async () => {
    mockUserFindAll.mockResolvedValue([{ email: 'a@x.co' }]);
    mockSendEmail.mockRejectedValue(new Error('Brevo caído'));
    await expect(svc.notifyNewThirdParty('t1', 'customer', { name: 'X' })).resolves.toEqual({ notified: 0 });
  });

  test('escapa HTML del nombre', () => {
    const { html } = svc.buildEmail('customer', { business_name: '<script>x</script>', tax_id: '1' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('estado pendiente', () => {
  test('el alta fuerza pending en el servidor', () => {
    expect(svc.pendingFields()).toMatchObject({ accounting_setup_status: 'pending' });
  });
  test('markConfigured valida el tipo y que exista', async () => {
    await expect(svc.markConfigured('t1', 'banco', 'id1', 'u1')).rejects.toMatchObject({ statusCode: 400 });
    mockSupplierFindOne.mockResolvedValue(null);
    await expect(svc.markConfigured('t1', 'supplier', 'id1', 'u1')).rejects.toMatchObject({ statusCode: 404 });
    const update = jest.fn();
    mockSupplierFindOne.mockResolvedValue({ update });
    await svc.markConfigured('t1', 'supplier', 'id1', 'u1');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ accounting_setup_status: 'configured', accounting_setup_by: 'u1' }));
  });
});
