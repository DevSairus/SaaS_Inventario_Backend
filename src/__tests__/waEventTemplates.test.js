jest.mock('../models', () => ({ WaTemplate: { findOne: jest.fn(), findAll: jest.fn() } }));

const { WaTemplate } = require('../models');
const { checkTemplate, eventComponents, getEventTemplate, setEventTemplate } = require('../services/waEventTemplates');

const quoteTemplate = (overrides = {}) => ({
  name: 'cotizacion_ot',
  language: 'es',
  status: 'APPROVED',
  category: 'UTILITY',
  components_schema: [
    { type: 'BODY', text: 'Hola {{1}}, la orden {{2}} de tu {{3}} tiene una cotización pendiente.' },
    { type: 'BUTTONS', buttons: [
      { type: 'QUICK_REPLY', text: 'Llamar' },
      { type: 'URL', text: 'Ver y aprobar', url: 'https://pitbox.esc-datacore.com/ot/{{1}}' },
    ] },
  ],
  ...overrides,
});

describe('checkTemplate (cotización de OT)', () => {
  test('acepta utilidad aprobada con 3 variables y botón URL dinámico, y ubica el botón', () => {
    expect(checkTemplate('quote_ot', quoteTemplate())).toEqual({ buttonIndex: 1 });
  });
  test('rechaza si no está aprobada o no es de utilidad', () => {
    expect(checkTemplate('quote_ot', quoteTemplate({ status: 'PENDING' })).error).toMatch(/aprobada/);
    expect(checkTemplate('quote_ot', quoteTemplate({ category: 'MARKETING' })).error).toMatch(/Utilidad/);
  });
  test('rechaza un número distinto de variables o variables con nombre', () => {
    const body = (text) => quoteTemplate({ components_schema: [{ type: 'BODY', text }, quoteTemplate().components_schema[1]] });
    expect(checkTemplate('quote_ot', body('Hola {{1}}')).error).toMatch(/3 variables/);
    expect(checkTemplate('quote_ot', body('Hola {{nombre}}')).error).toMatch(/numeradas/);
  });
  test('rechaza sin botón URL hacia /ot/{{1}}', () => {
    const t = quoteTemplate({ components_schema: [quoteTemplate().components_schema[0], { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quick Reply' }] }] });
    expect(checkTemplate('quote_ot', t).error).toMatch(/Visitar sitio web/);
  });
});

describe('eventComponents', () => {
  test('arma las variables del cuerpo y el token en el botón guardado', () => {
    expect(eventComponents({ button_index: 1 }, ['Ana', 'OT-1', ''], 'tok')).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: 'OT-1' }, { type: 'text', text: '-' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'tok' }] },
    ]);
  });
});

describe('setEventTemplate', () => {
  const tenant = (config = {}) => ({ id: 't1', business_config: config, update: jest.fn() });

  test('guarda la plantilla validada sin tocar el resto de business_config', async () => {
    WaTemplate.findOne.mockResolvedValue(quoteTemplate());
    const t = tenant({ margin_method: 'markup' });
    await setEventTemplate(t, 'quote_ot', { name: 'cotizacion_ot', language: 'es' });
    expect(WaTemplate.findOne).toHaveBeenCalledWith({ where: { tenant_id: 't1', name: 'cotizacion_ot', language: 'es' } });
    expect(t.update).toHaveBeenCalledWith({ business_config: {
      margin_method: 'markup',
      whatsapp_templates: { quote_ot: { name: 'cotizacion_ot', language: 'es', button_index: 1 } },
    } });
  });
  test('no guarda una plantilla que no cumple', async () => {
    WaTemplate.findOne.mockResolvedValue(quoteTemplate({ category: 'MARKETING' }));
    const t = tenant();
    await expect(setEventTemplate(t, 'quote_ot', { name: 'cotizacion_ot' })).rejects.toMatchObject({ status: 400 });
    expect(t.update).not.toHaveBeenCalled();
  });
  test('nombre vacío quita la plantilla; evento desconocido es 400', async () => {
    const t = tenant({ whatsapp_templates: { quote_ot: { name: 'x' } } });
    await setEventTemplate(t, 'quote_ot', { name: '' });
    expect(t.update).toHaveBeenCalledWith({ business_config: { whatsapp_templates: { quote_ot: null } } });
    expect(getEventTemplate({ business_config: { whatsapp_templates: { quote_ot: null } } }, 'quote_ot')).toBeNull();
    await expect(setEventTemplate(t, 'otro', {})).rejects.toMatchObject({ status: 400 });
  });
});
