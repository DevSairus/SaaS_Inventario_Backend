jest.mock('../config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/whatsappCloud.service', () => ({
  getWhatsAppStatus: jest.fn(),
  sendTextFromTenant: jest.fn(),
  sendTemplateFromTenant: jest.fn(),
}));

const waCloud = require('../services/whatsappCloud.service');
const { deliverWhatsApp, waResponse, bodyParams, FALLBACK } = require('../services/whatsappDelivery');
const { normalizeWhatsAppPhone, getCustomerWhatsappNumber } = require('../utils/customerWhatsappPhone');

const LIVE = { operational: true, demo_mode: false };
const DEMO = { operational: true, demo_mode: true };
const OFF = { operational: false, demo_mode: false };
const errWithCode = (code) => Object.assign(new Error(code), { code });

beforeEach(() => jest.resetAllMocks());

describe('normalizeWhatsAppPhone', () => {
  test('antepone 57 a celulares de 10 dígitos', () => {
    expect(normalizeWhatsAppPhone('316 687 6163')).toBe('573166876163');
  });
  test('respeta números que ya traen indicativo', () => {
    expect(normalizeWhatsAppPhone('+57 316-687-6163')).toBe('573166876163');
    expect(normalizeWhatsAppPhone('+1 (305) 555-0100')).toBe('13055550100');
    expect(normalizeWhatsAppPhone('+501 600 1234')).toBe('5016001234');
  });
  test('vacío queda vacío', () => {
    expect(normalizeWhatsAppPhone(null)).toBe('');
  });
  test('el fijo sin celular también sale con indicativo', () => {
    expect(getCustomerWhatsappNumber({ phone: '3041234567' })).toBe('573041234567');
    expect(getCustomerWhatsappNumber({ mobile: '3041234567', mobile_country_code: '58' })).toBe('583041234567');
  });
});

describe('deliverWhatsApp', () => {
  test('con Pitbox operativo envía texto por Cloud API, amarrado al tenant y con el número normalizado', async () => {
    waCloud.getWhatsAppStatus.mockResolvedValue(LIVE);
    waCloud.sendTextFromTenant.mockResolvedValue({ conversation_id: 'c1' });

    const res = await deliverWhatsApp({ tenantId: 't1', to: '3166876163', body: 'hola', userId: 'u1' });

    expect(res).toEqual({ channel: 'cloud_api', conversation_id: 'c1', phone: '573166876163' });
    expect(waCloud.getWhatsAppStatus).toHaveBeenCalledWith('t1');
    expect(waCloud.sendTextFromTenant).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', to: '573166876163', body: 'hola', userId: 'u1' }),
    );
  });

  test('sin conexión devuelve wa.me con motivo not_connected y no llama a Meta', async () => {
    waCloud.getWhatsAppStatus.mockResolvedValue(OFF);
    const res = await deliverWhatsApp({ tenantId: 't1', to: '3166876163', body: 'hola' });
    expect(res.channel).toBe('wa_me');
    expect(res.reason).toBe(FALLBACK.NOT_CONNECTED);
    expect(res.waLink).toBe('https://wa.me/573166876163?text=hola');
    expect(waCloud.sendTextFromTenant).not.toHaveBeenCalled();
  });

  test('ventana de 24 h cerrada cae a wa.me con motivo window_closed', async () => {
    waCloud.getWhatsAppStatus.mockResolvedValue(LIVE);
    waCloud.sendTextFromTenant.mockRejectedValue(errWithCode('WA_WINDOW_CLOSED'));
    const res = await deliverWhatsApp({ tenantId: 't1', to: '573166876163', body: 'hola' });
    expect(res).toMatchObject({ channel: 'wa_me', reason: FALLBACK.WINDOW_CLOSED });
  });

  test('con plantilla y conexión real usa la plantilla', async () => {
    waCloud.getWhatsAppStatus.mockResolvedValue(LIVE);
    waCloud.sendTemplateFromTenant.mockResolvedValue({ conversation_id: 'c2' });
    const template = { name: 'aviso', language: 'es', components: [bodyParams(['Ana'])] };
    const res = await deliverWhatsApp({ tenantId: 't1', to: '573166876163', body: 'hola', template });
    expect(res.channel).toBe('cloud_api');
    expect(waCloud.sendTemplateFromTenant).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', templateName: 'aviso', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }],
    }));
    expect(waCloud.sendTextFromTenant).not.toHaveBeenCalled();
  });

  test('en demo ignora la plantilla y envía el texto', async () => {
    waCloud.getWhatsAppStatus.mockResolvedValue(DEMO);
    waCloud.sendTextFromTenant.mockResolvedValue({ conversation_id: 'c3' });
    await deliverWhatsApp({ tenantId: 't1', to: '573166876163', body: 'hola', template: { name: 'aviso' } });
    expect(waCloud.sendTemplateFromTenant).not.toHaveBeenCalled();
    expect(waCloud.sendTextFromTenant).toHaveBeenCalled();
  });

  test('allowWaLink=false lanza el error con su motivo en vez de armar wa.me', async () => {
    waCloud.getWhatsAppStatus.mockResolvedValue(LIVE);
    waCloud.sendTextFromTenant.mockRejectedValue(errWithCode('WA_WINDOW_CLOSED'));
    await expect(deliverWhatsApp({ tenantId: 't1', to: '573166876163', body: 'x', allowWaLink: false }))
      .rejects.toMatchObject({ fallbackReason: FALLBACK.WINDOW_CLOSED });

    waCloud.getWhatsAppStatus.mockResolvedValue(OFF);
    await expect(deliverWhatsApp({ tenantId: 't1', to: '573166876163', body: 'x', allowWaLink: false }))
      .rejects.toMatchObject({ fallbackReason: FALLBACK.NOT_CONNECTED });
  });

  test('si no se puede leer el estado de la conexión, cae a wa.me con motivo error', async () => {
    waCloud.getWhatsAppStatus.mockRejectedValue(new Error('db caída'));
    const res = await deliverWhatsApp({ tenantId: 't1', to: '573166876163', body: 'hola' });
    expect(res).toMatchObject({ channel: 'wa_me', reason: FALLBACK.ERROR });
    expect(waCloud.sendTextFromTenant).not.toHaveBeenCalled();
  });

  test('reutiliza el status recibido (cron) sin volver a consultarlo', async () => {
    waCloud.sendTextFromTenant.mockResolvedValue({ conversation_id: 'c4' });
    await deliverWhatsApp({ tenantId: 't1', to: '573166876163', body: 'x', status: LIVE });
    expect(waCloud.getWhatsAppStatus).not.toHaveBeenCalled();
  });

  test('exige tenant y número', async () => {
    await expect(deliverWhatsApp({ to: '573166876163', body: 'x' })).rejects.toThrow('tenantId');
    await expect(deliverWhatsApp({ tenantId: 't1', to: '', body: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('waResponse', () => {
  test('solo expone waLink y motivo cuando cayó a wa.me', () => {
    expect(waResponse({ channel: 'cloud_api', conversation_id: 'c1', phone: '57' }))
      .toEqual({ channel: 'cloud_api', conversation_id: 'c1' });
    expect(waResponse({ channel: 'wa_me', waLink: 'https://wa.me/57', reason: 'window_closed', phone: '57' }))
      .toEqual({ channel: 'wa_me', waLink: 'https://wa.me/57', fallback_reason: 'window_closed' });
  });
});
