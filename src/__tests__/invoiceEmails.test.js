// 4.1 — Factura a múltiples correos: lista de destinatarios y envío por destinatario.
const { normalizeEmailList, validateEmailList, resolveInvoiceRecipients } = require('../utils/emailRecipients');

describe('emailRecipients', () => {
  test('acepta texto con comas, punto y coma y espacios; quita duplicados sin distinguir mayúsculas', () => {
    const { emails, invalid } = normalizeEmailList('a@x.com, B@y.co; a@X.com  c@z.org\n');
    expect(emails).toEqual(['a@x.com', 'B@y.co', 'c@z.org']);
    expect(invalid).toEqual([]);
  });

  test('reporta los correos con formato inválido', () => {
    const { emails, invalid } = normalizeEmailList(['ok@x.com', 'sin-arroba', 'raro@', '@x.com']);
    expect(emails).toEqual(['ok@x.com']);
    expect(invalid).toEqual(['sin-arroba', 'raro@', '@x.com']);
    expect(validateEmailList(['sin-arroba'])).toMatch(/no válido/);
  });

  test('valida el máximo de correos adicionales', () => {
    const muchos = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`);
    expect(validateEmailList(muchos)).toMatch(/Máximo 10/);
    expect(validateEmailList(muchos.slice(0, 10))).toBeNull();
    expect(validateEmailList('')).toBeNull();
  });

  test('la lista propia de la factura reemplaza la del cliente (incluso vacía)', () => {
    const base = { primary: 'principal@x.com', customerAdditional: ['cli1@x.com', 'cli2@x.com'] };
    expect(resolveInvoiceRecipients({ ...base, saleOverride: null })).toEqual(['principal@x.com', 'cli1@x.com', 'cli2@x.com']);
    expect(resolveInvoiceRecipients({ ...base, saleOverride: ['solo@x.com'] })).toEqual(['principal@x.com', 'solo@x.com']);
    expect(resolveInvoiceRecipients({ ...base, saleOverride: [] })).toEqual(['principal@x.com']);
  });

  test('el principal no se repite si también está en la lista adicional', () => {
    expect(resolveInvoiceRecipients({ primary: 'P@x.com', saleOverride: ['p@x.com', 'otro@x.com'] })).toEqual(['P@x.com', 'otro@x.com']);
  });

  test('sin ningún correo no hay destinatarios', () => {
    expect(resolveInvoiceRecipients({ primary: '  ', saleOverride: null, customerAdditional: [] })).toEqual([]);
  });
});

describe('dianEmailService.sendElectronicInvoiceEmail', () => {
  const mockSendEmail = jest.fn();
  const mockSaleUpdate = jest.fn().mockResolvedValue([1]);

  beforeEach(() => {
    jest.resetModules();
    mockSendEmail.mockReset();
    mockSaleUpdate.mockClear();
    jest.doMock('../services/emailService', () => ({ sendEmail: mockSendEmail }));
    jest.doMock('../services/pdfService', () => ({ generateSalePDFBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')) }));
    jest.doMock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../models', () => ({
      Sale: { update: mockSaleUpdate },
      Customer: { findByPk: jest.fn().mockResolvedValue({ additional_emails: ['conta@cliente.com', 'compras@cliente.com'] }) },
    }));
  });

  const sale = {
    id: 's1', customer_id: 'c1', customer_name: 'ACME', customer_email: 'principal@cliente.com',
    dian_invoice_number: 'FE1', sale_number: 'V-1', cufe: 'abc', document_type: 'factura', additional_emails_override: null,
  };
  const tenant = { company_name: 'Taller' };

  test('envía un correo por destinatario y guarda el registro de entregas', async () => {
    mockSendEmail.mockResolvedValue({ success: true });
    const { sendElectronicInvoiceEmail } = require('../services/dian/dianEmailService');
    const result = await sendElectronicInvoiceEmail(sale, tenant, '<xml/>');

    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    expect(mockSendEmail.mock.calls.map((c) => c[0].to)).toEqual(['principal@cliente.com', 'conta@cliente.com', 'compras@cliente.com']);
    expect(result.sent).toBe(true);
    expect(result.recipients.every((r) => r.status === 'sent')).toBe(true);
    expect(mockSaleUpdate).toHaveBeenCalledTimes(1);
    expect(mockSaleUpdate.mock.calls[0][0].email_delivery.recipients).toHaveLength(3);
  });

  test('un fallo en un destinatario no impide enviar a los demás y queda registrado', async () => {
    mockSendEmail
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('buzón inexistente'))
      .mockResolvedValueOnce({ success: true });
    const { sendElectronicInvoiceEmail } = require('../services/dian/dianEmailService');
    const result = await sendElectronicInvoiceEmail(sale, tenant, '<xml/>');

    expect(result.sent).toBe(true);
    expect(result.recipients.map((r) => r.status)).toEqual(['sent', 'failed', 'sent']);
    expect(result.recipients[1].error).toMatch(/buzón inexistente/);
  });

  test('usa la lista propia de la factura y no consulta al cliente', async () => {
    mockSendEmail.mockResolvedValue({ success: true });
    const { sendElectronicInvoiceEmail } = require('../services/dian/dianEmailService');
    const { Customer } = require('../models');
    const result = await sendElectronicInvoiceEmail({ ...sale, additional_emails_override: ['unico@cliente.com'] }, tenant, '<xml/>');

    expect(Customer.findByPk).not.toHaveBeenCalled();
    expect(result.recipients.map((r) => r.email)).toEqual(['principal@cliente.com', 'unico@cliente.com']);
  });

  test('sin correo principal ni adicionales no envía nada', async () => {
    const { sendElectronicInvoiceEmail } = require('../services/dian/dianEmailService');
    const result = await sendElectronicInvoiceEmail({ ...sale, customer_email: '', customer_id: null, additional_emails_override: [] }, tenant, '<xml/>');
    expect(result).toMatchObject({ sent: false, reason: 'no_customer_email' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('servicio de correo sin configurar queda como "skipped", no como enviado', async () => {
    mockSendEmail.mockResolvedValue({ success: true, mode: 'log' });
    const { sendElectronicInvoiceEmail } = require('../services/dian/dianEmailService');
    const result = await sendElectronicInvoiceEmail({ ...sale, additional_emails_override: [] }, tenant, '<xml/>');
    expect(result.sent).toBe(false);
    expect(result.recipients[0].status).toBe('skipped');
  });
});
