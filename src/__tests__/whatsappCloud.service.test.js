// Tests del servicio WhatsApp Cloud. Se aísla de la base de datos y de la
// Graph API: lo que se verifica es la lógica de negocio que decide si un
// número se puede conectar, en qué schema se escribe y cómo se interpreta un
// mensaje entrante.
jest.mock('../models', () => ({
  TenantMetaConfig: {
    findOne: jest.fn(),
    findOrCreate: jest.fn(),
  },
  Tenant: { findByPk: jest.fn() },
  Customer: { findOne: jest.fn() },
  WaMessage: {
    update: jest.fn(), findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), destroy: jest.fn().mockResolvedValue(0),
  },
  WaConversation: {
    findOrCreate: jest.fn(), findByPk: jest.fn(), update: jest.fn(), increment: jest.fn(), destroy: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock('../config/tenantContext', () => ({
  runWithTenantSchema: jest.fn((schema, fn) => fn()),
}));

jest.mock('../services/meta/metaClient', () => ({
  GRAPH_VERSION: 'v21.0',
  getConfig: jest.fn(),
  debugToken: jest.fn(),
  listWabaPhoneNumbers: jest.fn(),
  requestCoexistenceSync: jest.fn(),
  getMediaUrl: jest.fn(),
  downloadMedia: jest.fn(),
}));

jest.mock('../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const metaClient = require('../services/meta/metaClient');
const { TenantMetaConfig, Tenant, WaMessage } = require('../models');
const { runWithTenantSchema } = require('../config/tenantContext');
const waCloud = require('../services/whatsappCloud.service');

const TENANT_ID = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const WABA_ID = '1446354543768537';
const PHONE_ID = '1261178347084956';

function mockConfigRow(overrides = {}) {
  return {
    tenant_id: TENANT_ID,
    provider_mode: 'own',
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  process.env.META_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
  metaClient.debugToken.mockResolvedValue({
    valid: true, never_expires: true, expires_at: null, error: null,
  });
  metaClient.listWabaPhoneNumbers.mockResolvedValue([
    { id: PHONE_ID, display_phone_number: '+1 555 669-3636', quality_rating: 'GREEN' },
  ]);
  metaClient.requestCoexistenceSync.mockResolvedValue({});
  TenantMetaConfig.findOne.mockResolvedValue(null);
});

describe('connectWithToken', () => {
  it('conecta con un token de System User y lo marca como permanente', async () => {
    const row = mockConfigRow();
    TenantMetaConfig.findOrCreate.mockResolvedValue([row]);
    Object.assign(row, {
      own_waba_id: WABA_ID,
      own_phone_number_id: PHONE_ID,
      own_display_phone: '+1 555 669-3636',
      own_token_is_permanent: true,
      own_token_source: 'system_user',
      wa_coexistence: true,
    });

    const result = await waCloud.connectWithToken({
      tenantId: TENANT_ID,
      accessToken: 'EAAG-token-permanente',
      wabaId: WABA_ID,
      phoneNumberId: PHONE_ID,
      tokenSource: 'system_user',
    });

    expect(result.own_token_is_permanent).toBe(true);
    expect(result.quality_rating).toBe('GREEN');

    const saved = row.update.mock.calls[0][0];
    expect(saved.own_token_is_permanent).toBe(true);
    expect(saved.own_token_expires_at).toBeNull();
    // El token nunca se guarda en claro
    expect(saved.own_access_token).toMatch(/^enc:v1:/);
    expect(saved.own_access_token).not.toContain('EAAG-token-permanente');
    // Conectar de verdad apaga el modo demo
    expect(saved.wa_demo_mode).toBe(false);
  });

  it('marca como NO permanente el token de un número de prueba', async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    metaClient.debugToken.mockResolvedValue({
      valid: true, never_expires: false, expires_at: expiresAt, error: null,
    });
    const row = mockConfigRow();
    TenantMetaConfig.findOrCreate.mockResolvedValue([row]);

    await waCloud.connectWithToken({
      tenantId: TENANT_ID,
      accessToken: 'token-de-prueba',
      wabaId: WABA_ID,
      phoneNumberId: PHONE_ID,
      tokenSource: 'test_number',
    });

    const saved = row.update.mock.calls[0][0];
    expect(saved.own_token_is_permanent).toBe(false);
    expect(saved.own_token_expires_at).toEqual(expiresAt);
  });

  it('borra las conversaciones/mensajes demo del tenant al conectar de verdad', async () => {
    const { WaMessage, WaConversation } = require('../models');
    const row = mockConfigRow();
    TenantMetaConfig.findOrCreate.mockResolvedValue([row]);
    Tenant.findByPk.mockResolvedValue({ id: TENANT_ID, schema_name: 'tenant_motos_estrada' });
    WaMessage.destroy.mockResolvedValue(31); // 31 mensajes demo borrados
    WaMessage.findAll.mockResolvedValue([]); // ninguna conversación con mensajes reales restantes

    await waCloud.connectWithToken({
      tenantId: TENANT_ID,
      accessToken: 'token-de-prueba',
      wabaId: WABA_ID,
      phoneNumberId: PHONE_ID,
      tokenSource: 'test_number',
    });

    expect(WaMessage.destroy).toHaveBeenCalledWith({ where: { tenant_id: TENANT_ID, source: 'demo' } });
    expect(WaConversation.destroy).toHaveBeenCalledWith({ where: { tenant_id: TENANT_ID } });
  });

  it('rechaza un token que Meta considera inválido', async () => {
    metaClient.debugToken.mockResolvedValue({
      valid: false, error: 'Session has expired',
    });

    await expect(waCloud.connectWithToken({
      tenantId: TENANT_ID,
      accessToken: 'token-vencido',
      wabaId: WABA_ID,
      phoneNumberId: PHONE_ID,
    })).rejects.toMatchObject({ status: 400 });

    expect(TenantMetaConfig.findOrCreate).not.toHaveBeenCalled();
  });

  it('rechaza un número que no pertenece al WABA del token', async () => {
    metaClient.listWabaPhoneNumbers.mockResolvedValue([{ id: 'otro-numero' }]);

    await expect(waCloud.connectWithToken({
      tenantId: TENANT_ID,
      accessToken: 'token',
      wabaId: WABA_ID,
      phoneNumberId: PHONE_ID,
    })).rejects.toMatchObject({ status: 403 });
  });

  it('impide robar un número ya conectado a otro tenant', async () => {
    TenantMetaConfig.findOne.mockResolvedValue({ tenant_id: OTHER_TENANT });

    await expect(waCloud.connectWithToken({
      tenantId: TENANT_ID,
      accessToken: 'token',
      wabaId: WABA_ID,
      phoneNumberId: PHONE_ID,
    })).rejects.toMatchObject({ status: 409 });

    expect(TenantMetaConfig.findOrCreate).not.toHaveBeenCalled();
  });

  it('exige token, waba_id y phone_number_id', async () => {
    await expect(waCloud.connectWithToken({
      tenantId: TENANT_ID,
      accessToken: 'token',
      wabaId: WABA_ID,
    })).rejects.toMatchObject({ status: 400 });
  });
});

describe('updateMessageStatus', () => {
  it('escribe el estado dentro del schema del tenant', async () => {
    Tenant.findByPk.mockResolvedValue({ id: TENANT_ID, schema_name: 'tenant_motos_estrada' });

    await waCloud.updateMessageStatus({
      metaMessageId: 'wamid.ABC',
      status: 'delivered',
      tenantId: TENANT_ID,
    });

    expect(runWithTenantSchema).toHaveBeenCalledWith('tenant_motos_estrada', expect.any(Function));
    expect(WaMessage.update).toHaveBeenCalledWith(
      { status: 'delivered' },
      { where: { meta_message_id: 'wamid.ABC' } }
    );
  });

  it('actualiza sin schema cuando el tenant vive en public', async () => {
    Tenant.findByPk.mockResolvedValue({ id: TENANT_ID, schema_name: null });

    await waCloud.updateMessageStatus({
      metaMessageId: 'wamid.XYZ',
      status: 'read',
      tenantId: TENANT_ID,
    });

    expect(runWithTenantSchema).not.toHaveBeenCalled();
    expect(WaMessage.update).toHaveBeenCalled();
  });

  it('ignora eventos incompletos', async () => {
    await waCloud.updateMessageStatus({ metaMessageId: null, status: 'read' });
    expect(WaMessage.update).not.toHaveBeenCalled();
  });
});

describe('extractInboundText', () => {
  it('lee texto plano', () => {
    expect(waCloud.extractInboundText({ type: 'text', text: { body: 'Hola' } }))
      .toMatchObject({ type: 'text', body: 'Hola', mediaId: null });
  });

  it('expone el media_id de una imagen para poder descargarla', () => {
    const result = waCloud.extractInboundText({
      type: 'image',
      image: { id: 'media-123', mime_type: 'image/jpeg', caption: 'Mi moto' },
    });

    expect(result).toMatchObject({
      type: 'image',
      body: 'Mi moto',
      mediaId: 'media-123',
      mimeType: 'image/jpeg',
    });
  });

  it('normaliza las notas de voz como audio', () => {
    const result = waCloud.extractInboundText({ type: 'voice', voice: { id: 'media-9' } });

    expect(result.type).toBe('audio');
    expect(result.mediaId).toBe('media-9');
  });

  it('usa el nombre del archivo como etiqueta de un documento', () => {
    const result = waCloud.extractInboundText({
      type: 'document',
      document: { id: 'media-7', filename: 'cotizacion.pdf' },
    });

    expect(result.body).toBe('cotizacion.pdf');
    expect(result.filename).toBe('cotizacion.pdf');
  });

  it('lee la respuesta de un botón interactivo', () => {
    const result = waCloud.extractInboundText({
      type: 'interactive',
      interactive: { button_reply: { title: 'Confirmar cita' } },
    });

    expect(result.body).toBe('Confirmar cita');
  });
});
