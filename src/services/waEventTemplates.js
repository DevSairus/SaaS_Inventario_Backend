// backend/src/services/waEventTemplates.js
//
// Plantilla de Meta (categoría Utilidad) que cada empresa asigna a un envío
// de Pitbox. Vive en tenants.business_config.whatsapp_templates[evento] y se
// valida contra las plantillas sincronizadas (wa_templates) al guardarla, no
// cuando el cliente ya debía recibir el mensaje.
//
// Convención de todos los eventos: variables posicionales en el cuerpo y un
// botón "Visitar sitio web" dinámico cuya URL termina en `{path}{{1}}`; el
// sistema pone el token del documento en ese {{1}}.

const EVENTS = Object.freeze({
  quote_ot: {
    label: 'Cotización de OT y su recordatorio',
    bodyVars: ['nombre del cliente', 'número de la orden', 'vehículo y placa'],
    path: '/ot/',
  },
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const bodyVarCount = (text) => new Set([...String(text || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1])).size;

/**
 * Revisa que una plantilla sincronizada sirva para el evento. Devuelve
 * `{ error }` o `{ buttonIndex }` (posición del botón URL entre los botones,
 * Meta la pide al enviar).
 */
function checkTemplate(event, template) {
  const spec = EVENTS[event];
  if (template.status !== 'APPROVED') return { error: 'La plantilla todavía no está aprobada por Meta.' };
  if (String(template.category || '').toUpperCase() !== 'UTILITY') return { error: 'La plantilla debe ser de categoría Utilidad.' };

  const components = template.components_schema || [];
  const body = components.find((c) => c.type === 'BODY');
  if (/\{\{\s*[a-z_]/i.test(body?.text || '')) {
    return { error: 'Usa variables numeradas ({{1}}, {{2}}…), no con nombre.' };
  }
  const vars = bodyVarCount(body?.text);
  if (vars !== spec.bodyVars.length) {
    return { error: `El cuerpo debe tener ${spec.bodyVars.length} variables (${spec.bodyVars.join(', ')}); tiene ${vars}.` };
  }

  const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons || [];
  const buttonIndex = buttons.findIndex((b) => b.type === 'URL' && String(b.url || '').includes(`${spec.path}{{1}}`));
  if (buttonIndex < 0) {
    return { error: `Falta el botón "Visitar sitio web" dinámico con la URL terminada en ${spec.path}{{1}}.` };
  }
  return { buttonIndex };
}

/** Plantilla asignada al evento o null. */
function getEventTemplate(tenant, event) {
  const saved = tenant?.business_config?.whatsapp_templates?.[event];
  return saved?.name ? saved : null;
}

/**
 * Componentes de envío para la plantilla del evento: variables del cuerpo en
 * orden + el token en el botón URL.
 */
function eventComponents(saved, values, token) {
  return [
    { type: 'body', parameters: values.map((text) => ({ type: 'text', text: String(text || '-') })) },
    { type: 'button', sub_type: 'url', index: String(saved.button_index || 0), parameters: [{ type: 'text', text: String(token) }] },
  ];
}

/** Estado para la pantalla: eventos, lo asignado y qué plantillas aprobadas sirven para cada uno. */
async function listEventTemplates(tenant) {
  const { WaTemplate } = require('../models');
  const templates = await WaTemplate.findAll({
    where: { tenant_id: tenant.id, status: 'APPROVED' },
    order: [['name', 'ASC']],
  });
  return Object.entries(EVENTS).map(([key, spec]) => ({
    key,
    label: spec.label,
    body_vars: spec.bodyVars,
    url_path: spec.path,
    selected: getEventTemplate(tenant, key),
    templates: templates.map((t) => ({ name: t.name, language: t.language, error: checkTemplate(key, t).error || null })),
  }));
}

/** Asigna (o quita con name vacío) la plantilla de un evento, validándola. */
async function setEventTemplate(tenant, event, { name, language } = {}) {
  if (!EVENTS[event]) throw httpError(400, 'Evento de WhatsApp desconocido.');
  const current = tenant.business_config?.whatsapp_templates || {};
  let value = null;
  if (name) {
    const { WaTemplate } = require('../models');
    const template = await WaTemplate.findOne({ where: { tenant_id: tenant.id, name, language: language || 'es' } });
    if (!template) throw httpError(404, 'No encontré esa plantilla. Sincroniza las plantillas de Meta e inténtalo de nuevo.');
    const { error, buttonIndex } = checkTemplate(event, template);
    if (error) throw httpError(400, error);
    value = { name: template.name, language: template.language, button_index: buttonIndex };
  }
  await tenant.update({
    business_config: { ...(tenant.business_config || {}), whatsapp_templates: { ...current, [event]: value } },
  });
  return value;
}

module.exports = { EVENTS, checkTemplate, getEventTemplate, eventComponents, listEventTemplates, setEventTemplate };
