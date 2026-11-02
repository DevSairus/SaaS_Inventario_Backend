// backend/src/services/waEventTemplates.js
//
// Plantilla de Meta (categoría Utilidad) que cada empresa asigna a un envío
// de Pitbox. Vive en tenants.business_config.whatsapp_templates[evento] y se
// valida contra las plantillas sincronizadas (wa_templates) al guardarla, no
// cuando el cliente ya debía recibir el mensaje.
//
// Variables posicionales en el cuerpo. Los eventos con `path` llevan un botón
// "Visitar sitio web" dinámico cuya URL termina en `{path}{{1}}`; el sistema
// pone el token del documento en ese {{1}}.

const APPOINTMENT_VARS = ['nombre del cliente', 'fecha y hora de la cita', 'placa'];

const EVENTS = Object.freeze({
  quote_ot: {
    group: 'Taller',
    label: 'Cotización de OT y su recordatorio',
    bodyVars: ['nombre del cliente', 'número de la orden', 'vehículo y placa'],
    path: '/ot/',
  },
  work_order_status: {
    group: 'Taller',
    label: 'Estado de la orden de trabajo',
    bodyVars: ['nombre del cliente', 'número de la orden'],
    path: '/ot/',
  },
  reception: {
    group: 'Taller',
    label: 'Recepción del vehículo',
    bodyVars: ['nombre del cliente', 'número de la orden', 'placa', 'enlace de seguimiento o acta'],
    path: null,
    // Antes se configuraba en Consentimientos; se respeta hasta que la empresa elija aquí.
    legacy: (bc) => bc.vehicle_intake?.whatsapp_reception_template && {
      name: bc.vehicle_intake.whatsapp_reception_template,
      language: bc.otp?.whatsapp_language || 'es',
      button_index: null,
    },
  },
  vehicle_portal: {
    group: 'Taller',
    label: 'Hoja de vida del vehículo',
    bodyVars: ['nombre del cliente', 'placa'],
    path: '/portal/vehiculo/',
  },
  sale_quote: {
    group: 'Ventas',
    label: 'Cotización de venta',
    bodyVars: ['nombre del cliente', 'número de la cotización', 'total'],
    path: '/cotizacion/',
  },
  sale_document: {
    group: 'Ventas',
    label: 'Factura o remisión',
    bodyVars: ['nombre del cliente', 'tipo de documento', 'número del documento', 'total'],
    path: '/documento/',
  },
  appointment_confirmacion: { group: 'Citas', label: 'Cita confirmada', bodyVars: APPOINTMENT_VARS, path: null },
  appointment_recordatorio: { group: 'Citas', label: 'Recordatorio de cita', bodyVars: APPOINTMENT_VARS, path: null },
  appointment_reagendamiento: { group: 'Citas', label: 'Cita reagendada', bodyVars: APPOINTMENT_VARS, path: null },
  appointment_cancelacion: { group: 'Citas', label: 'Cita cancelada', bodyVars: APPOINTMENT_VARS, path: null },
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
 * Meta la pide al enviar; null si el evento no lleva enlace).
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
  if (!spec.path) {
    if (buttons.some((b) => b.type === 'URL' && String(b.url || '').includes('{{'))) {
      return { error: 'Este mensaje no lleva enlace en botón: usa una plantilla sin botón de URL dinámica.' };
    }
    return { buttonIndex: null };
  }
  const buttonIndex = buttons.findIndex((b) => b.type === 'URL' && String(b.url || '').includes(`${spec.path}{{1}}`));
  if (buttonIndex < 0) {
    return { error: `Falta el botón "Visitar sitio web" dinámico con la URL terminada en ${spec.path}{{1}}.` };
  }
  return { buttonIndex };
}

/** Plantilla asignada al evento o null. */
function getEventTemplate(tenant, event) {
  const bc = tenant?.business_config || {};
  const assigned = bc.whatsapp_templates || {};
  if (event in assigned) return assigned[event]?.name ? assigned[event] : null;
  return EVENTS[event]?.legacy?.(bc) || null;
}

/**
 * Componentes de envío para la plantilla del evento: variables del cuerpo en
 * orden + el token en el botón URL cuando el evento lo lleva.
 */
function eventComponents(saved, values, token) {
  const components = [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text: String(text || '-') })) }];
  if (token && saved.button_index != null) {
    components.push({ type: 'button', sub_type: 'url', index: String(saved.button_index), parameters: [{ type: 'text', text: String(token) }] });
  }
  return components;
}

/** Nombre con el que se saluda al cliente en las plantillas. */
const greetingName = (customer) => customer?.first_name || customer?.trade_name || customer?.business_name || 'cliente';

/** Plantilla lista para deliverWhatsApp, o null si el evento no tiene una asignada. */
function eventTemplate(tenant, event, values, token = null) {
  const saved = getEventTemplate(tenant, event);
  return saved && { name: saved.name, language: saved.language, components: eventComponents(saved, values, token) };
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
    group: spec.group,
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

module.exports = {
  EVENTS, checkTemplate, getEventTemplate, eventComponents, eventTemplate, greetingName, listEventTemplates, setEventTemplate,
};
