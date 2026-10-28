// backend/src/services/legal/consent.service.js
//
// Autorizaciones del cliente:
//   - 'habeas_data': tratamiento de datos personales (Ley 1581 de 2012).
//   - 'vehicle_intake': acta de ingreso del vehículo (inventario + condiciones).
//
// Flujo: el taller crea la solicitud (createConsentRequest) → el cliente abre
// /autorizacion/:token (o el asesor lo atiende en mostrador) → se le envía un
// OTP por email o WhatsApp (sendOtp) → al confirmarlo (verifyOtpAndAccept)
// queda la evidencia: versión exacta del texto, canal y destino verificados,
// IP, user agent, fecha, y para el acta, el hash del inventario aceptado.
//
// OTP: otplib en modo HOTP, con un secreto aleatorio por solicitud (cifrado
// con utils/metaTokenCrypto) y otp_counter como contador -- cada reenvío
// incrementa el contador, así el código anterior deja de ser válido. El
// vencimiento (10 min) y el tope de intentos se controlan aquí, no en otplib.
// otplib solo genera/valida el código: la entrega va por email (Brevo, ya
// usado por el sistema) o por WhatsApp Cloud API del tenant -- no hay SMS.
//
// La configuración vive en tenant.business_config.habeas_data /
// .vehicle_intake / .otp (ver getConsentSettings).

const crypto = require('crypto');
const { Op } = require('sequelize');
const { generateSecret, generateSync, verifySync } = require('otplib');
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const { runWithTenantSchema } = require('../../config/tenantContext');
const { encryptToken, decryptToken } = require('../../utils/metaTokenCrypto');
const { getCustomerWhatsappNumber } = require('../../utils/customerWhatsappPhone');
const { getEffectiveModulesForTenantId } = require('../moduleAccess');
const { habeasDataStandard, VEHICLE_INTAKE_STANDARD } = require('../../data/legal/standardDocuments');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_SENDS = 5;
const OTP_MAX_ATTEMPTS = 5;

// Ítems del inventario de ingreso -- los mismos que tenía fijos
// WorkOrderDetailPage/workshopPdfService antes de volverse configurables.
const DEFAULT_INTAKE_CHECKLIST = [
  { key: 'estado_general', label: 'Estado general' },
  { key: 'testigos',       label: 'Testigos' },
  { key: 'tanque',         label: 'Tanque combustible' },
  { key: 'espejos',        label: 'Espejos' },
  { key: 'sillin',         label: 'Sillín' },
  { key: 'luces',          label: 'Luces' },
  { key: 'carenaje',       label: 'Carenaje / plásticos' },
  { key: 'llantas',        label: 'Llantas' },
  { key: 'rele_encendido', label: 'Rele de encendido' },
];

const FUEL_LABELS = ['Vacío', '1/4', '1/2', '3/4', 'Lleno'];

const DEFAULT_SETTINGS = {
  habeas_data: {
    enabled: false,
    document_mode: 'standard',      // 'standard' | 'custom'
    custom_content: '',
    business_kind: 'auto',          // 'auto' | 'workshop' | 'store' | 'both'
    activity_description: '',
    policy_url: '',
    privacy_email: '',
    city: '',
    document_updated_at: '',
    link_validity_days: 15,
  },
  vehicle_intake: {
    enabled: false,
    terms_mode: 'standard',         // 'standard' | 'custom'
    custom_terms: '',
    // Aviso automático al crear la OT (notifyVehicleReception). Independiente
    // de `enabled`: se puede avisar sin pedir el acta. Apagado por defecto
    // para no empezar a escribirle a los clientes de nadie al desplegar.
    notify_on_reception: false,
    storage_days: 15,
    storage_fee: 'la tarifa diaria vigente informada por EL TALLER',
    max_amount_without_approval: 'el valor del presupuesto aprobado por el cliente',
    checklist_items: DEFAULT_INTAKE_CHECKLIST,
    // Plantilla de WhatsApp (Meta) para el aviso de ingreso fuera de la
    // ventana de 24h. Parámetros del cuerpo, en orden: {{1}} nombre del
    // cliente, {{2}} número de OT, {{3}} placa, {{4}} enlace.
    whatsapp_reception_template: '',
  },
  otp: {
    // Plantilla de autenticación de Meta (categoría AUTHENTICATION, con
    // botón "copiar código"). Sin ella, WhatsApp solo funciona si el cliente
    // escribió en las últimas 24h.
    whatsapp_template: '',
    whatsapp_language: 'es',
  },
};

const KINDS = ['habeas_data', 'vehicle_intake'];

// ─── Configuración ─────────────────────────────────────────────────────────

function getConsentSettings(tenant) {
  const bc = tenant?.business_config || {};
  const habeas = { ...DEFAULT_SETTINGS.habeas_data, ...(bc.habeas_data || {}) };
  const intake = { ...DEFAULT_SETTINGS.vehicle_intake, ...(bc.vehicle_intake || {}) };
  if (!Array.isArray(intake.checklist_items) || intake.checklist_items.length === 0) {
    intake.checklist_items = DEFAULT_INTAKE_CHECKLIST;
  }
  const otp = { ...DEFAULT_SETTINGS.otp, ...(bc.otp || {}) };
  return { habeas_data: habeas, vehicle_intake: intake, otp };
}

async function resolveBusinessKind(tenantId, configured) {
  if (configured && configured !== 'auto') return configured;
  const modules = await getEffectiveModulesForTenantId(tenantId).catch(() => []);
  return modules.includes('workshop') ? 'both' : 'store';
}

function formatCop(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toLocaleString('es-CO')}`;
}

// Variables {{nombre}} de los documentos (ver data/legal/standardDocuments.js).
function buildDocumentVars(tenant, settings) {
  const habeas = settings.habeas_data;
  const intake = settings.vehicle_intake;
  const dian = tenant.dian_config || {};
  const city = habeas.city || [dian.city, dian.dept].filter(Boolean).join(', ');
  return {
    razon_social: tenant.business_name || tenant.company_name || '',
    nit: tenant.tax_id || dian.nit || '',
    ciudad: city,
    direccion: tenant.address || '',
    correo: tenant.email || '',
    telefono: tenant.phone || '',
    correo_datos: habeas.privacy_email || tenant.email || '',
    actividad: habeas.activity_description || '',
    url_politica: habeas.policy_url || 'disponible a solicitud del titular a través de los canales indicados en la sección 5',
    fecha_actualizacion: habeas.document_updated_at || '',
    dias_bodegaje: String(intake.storage_days ?? ''),
    tarifa_bodegaje: formatCop(intake.storage_fee) || intake.storage_fee || '',
    tope_sin_aprobacion: formatCop(intake.max_amount_without_approval) || intake.max_amount_without_approval || '',
  };
}

// Datos sin los que el documento no debe presentarse a nadie.
const REQUIRED_VARS = {
  habeas_data: ['razon_social', 'nit', 'ciudad', 'direccion', 'telefono', 'correo_datos'],
  vehicle_intake: ['razon_social', 'nit'],
};

function fillVariables(template, vars) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key) => {
    if (!(key in vars)) return match;
    return vars[key] || '—';
  });
}

/**
 * Texto final (Markdown) del documento para este tenant + datos faltantes.
 */
async function renderDocument(tenant, kind) {
  const settings = getConsentSettings(tenant);
  const vars = buildDocumentVars(tenant, settings);
  let template;
  let source;
  if (kind === 'habeas_data') {
    const custom = settings.habeas_data.document_mode === 'custom' && settings.habeas_data.custom_content?.trim();
    source = custom ? 'custom' : 'standard';
    if (custom) {
      template = settings.habeas_data.custom_content;
    } else {
      const businessKind = await resolveBusinessKind(tenant.id, settings.habeas_data.business_kind);
      if (!vars.actividad) {
        vars.actividad = businessKind === 'store'
          ? 'la comercialización de productos, repuestos y accesorios'
          : 'el mantenimiento y reparación de vehículos y la comercialización de repuestos y accesorios';
      }
      template = habeasDataStandard(businessKind);
    }
  } else {
    const custom = settings.vehicle_intake.terms_mode === 'custom' && settings.vehicle_intake.custom_terms?.trim();
    source = custom ? 'custom' : 'standard';
    template = custom ? settings.vehicle_intake.custom_terms : VEHICLE_INTAKE_STANDARD;
  }
  const missing = REQUIRED_VARS[kind].filter((k) => !vars[k]);
  return { content: fillVariables(template, vars).trim() + '\n', source, missing, settings };
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// Busca la versión con este texto exacto o crea la siguiente.
async function ensureDocumentVersion({ tenantId, kind, content, source, transaction }) {
  const { LegalDocumentVersion } = require('../../models');
  const contentHash = sha256(content);
  const existing = await LegalDocumentVersion.findOne({
    where: { tenant_id: tenantId, kind, content_hash: contentHash },
    transaction,
  });
  if (existing) return existing;
  const last = await LegalDocumentVersion.max('version', { where: { tenant_id: tenantId, kind }, transaction });
  return LegalDocumentVersion.create({
    tenant_id: tenantId,
    kind,
    version: (last || 0) + 1,
    source,
    content,
    content_hash: contentHash,
  }, { transaction });
}

// ─── Utilidades ────────────────────────────────────────────────────────────

function pushEvent(consent, type, data = {}) {
  consent.events = [...(consent.events || []), { at: new Date().toISOString(), type, ...data }];
  consent.changed('events', true);
}

function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  const [dom, ...tld] = domain.split('.');
  const u = user.length <= 2 ? `${user[0] || ''}*` : `${user.slice(0, 2)}${'*'.repeat(Math.min(user.length - 2, 5))}`;
  const d = dom ? `${dom[0]}${'*'.repeat(Math.min(Math.max(dom.length - 1, 1), 5))}` : '*';
  return `${u}@${d}${tld.length ? `.${tld.join('.')}` : ''}`;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `•••• ${digits.slice(-4)}`;
}

function customerDisplayName(customer) {
  if (!customer) return '';
  return customer.business_name || [customer.first_name, customer.last_name].filter(Boolean).join(' ') || '';
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'https://tu-app.vercel.app').replace(/\/$/, '');
}

function publicUrl(consent) {
  return `${frontendUrl()}/autorizacion/${consent.token}`;
}

const isEmailDeliveryConfigured = () => Boolean(process.env.BREVO_API_KEY && process.env.EMAIL_FROM_ADDRESS);

/**
 * Canales por los que se le puede enviar el OTP a este cliente.
 */
async function getOtpChannels(tenantId, customer) {
  const channels = [];
  if (customer?.email && (isEmailDeliveryConfigured() || process.env.NODE_ENV !== 'production')) {
    channels.push({ channel: 'email', destination: maskEmail(customer.email) });
  }
  const phone = getCustomerWhatsappNumber(customer);
  if (phone) {
    try {
      const waCloud = require('../whatsappCloud.service');
      const status = await waCloud.getWhatsAppStatus(tenantId);
      if (status.operational) channels.push({ channel: 'whatsapp', destination: maskPhone(phone) });
    } catch (err) {
      logger.warn(`[Consent] No se pudo consultar WhatsApp Cloud: ${err.message}`);
    }
  }
  return channels;
}

// ─── Snapshot del acta de ingreso ──────────────────────────────────────────

async function loadChecklistIn(workOrderId) {
  const { getCurrentSchema } = require('../../config/tenantContext');
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT checklist_in FROM "${schema}"."work_orders" WHERE id = :id`,
    { replacements: { id: workOrderId }, type: sequelize.QueryTypes.SELECT }
  );
  return rows[0]?.checklist_in || {};
}

/**
 * Lo que el cliente ve y acepta del ingreso: vehículo, km, combustible,
 * estado de cada elemento, observaciones, problema reportado y fotos.
 */
async function buildIntakeSnapshot(order, settings) {
  const checklist = await loadChecklistIn(order.id);
  const items = settings.vehicle_intake.checklist_items.map(({ key, label }) => {
    const v = checklist[key];
    return { key, label, value: v === true ? 'ok' : v === false ? 'bad' : v === null ? 'na' : 'unset' };
  });
  const v = order.vehicle || {};
  const snapshot = {
    order_number: order.order_number,
    received_at: order.received_at,
    vehicle: { plate: v.plate || null, brand: v.brand || null, model: v.model || null, year: v.year || null, color: v.color || null },
    mileage_in: order.mileage_in ?? null,
    fuel_level: typeof checklist.fuel_level === 'number' ? checklist.fuel_level : null,
    fuel_label: typeof checklist.fuel_level === 'number' ? FUEL_LABELS[checklist.fuel_level] || null : null,
    items,
    observations: checklist.observations || null,
    belongings: checklist.belongings || null,
    problem_description: order.problem_description || null,
    photos: (order.photos_in || []).map((p) => ({ url: p.url, caption: p.caption || null })),
  };
  return { snapshot, hash: sha256(JSON.stringify(snapshot)) };
}

// ─── Solicitudes ───────────────────────────────────────────────────────────

/**
 * Crea (o reutiliza, si hay una pendiente vigente con el mismo texto) una
 * solicitud de autorización. Para 'vehicle_intake' además deja lista la de
 * habeas data si el tenant la tiene activa y el cliente aún no la otorgó --
 * la página pública ofrece aceptar ambas con un solo OTP.
 */
async function createConsentRequest({ tenant, kind, customerId, workOrderId = null, userId = null }) {
  const { CustomerConsent, Customer, WorkOrder, Vehicle } = require('../../models');
  if (!KINDS.includes(kind)) throw httpError(400, 'Tipo de autorización inválido');

  const settings = getConsentSettings(tenant);
  if (!settings[kind].enabled) {
    throw httpError(400, kind === 'habeas_data'
      ? 'La autorización de tratamiento de datos no está habilitada en Configuración'
      : 'La autorización de ingreso de vehículos no está habilitada en Configuración');
  }

  let order = null;
  if (kind === 'vehicle_intake') {
    if (!workOrderId) throw httpError(400, 'La orden de trabajo es requerida');
    order = await WorkOrder.findOne({
      where: { id: workOrderId, tenant_id: tenant.id },
      include: [{ model: Vehicle, as: 'vehicle' }],
    });
    if (!order) throw httpError(404, 'Orden no encontrada');
    if (!order.customer_id) throw httpError(400, 'La orden no tiene cliente');
    customerId = order.customer_id;
    const alreadyAccepted = await CustomerConsent.count({
      where: { tenant_id: tenant.id, kind: 'vehicle_intake', work_order_id: order.id, status: 'accepted' },
    });
    if (alreadyAccepted) {
      throw httpError(409, 'El cliente ya aceptó el acta de ingreso de esta orden. Para pedirla de nuevo, anula primero la aceptada.');
    }
  }

  const customer = await Customer.findOne({ where: { id: customerId, tenant_id: tenant.id } });
  if (!customer) throw httpError(404, 'Cliente no encontrado');

  const { content, source, missing } = await renderDocument(tenant, kind);
  if (missing.length) {
    throw httpError(400, `Faltan datos de la empresa para el documento: ${missing.join(', ')}. Complétalos en Configuración.`);
  }

  const transaction = await sequelize.transaction();
  try {
    const version = await ensureDocumentVersion({ tenantId: tenant.id, kind, content, source, transaction });
    const intake = order ? await buildIntakeSnapshot(order, settings) : null;

    const pendingWhere = { tenant_id: tenant.id, kind, customer_id: customer.id, status: 'pending' };
    if (order) pendingWhere.work_order_id = order.id;
    const pending = await CustomerConsent.findAll({ where: pendingWhere, order: [['created_at', 'DESC']], transaction });

    let consent = pending.find((p) => p.document_version_id === version.id && (!p.expires_at || p.expires_at > new Date()));
    for (const p of pending) {
      if (p !== consent) {
        p.status = 'cancelled';
        pushEvent(p, 'superseded', { by_user: userId });
        await p.save({ transaction });
      }
    }

    const validityDays = Number(settings.habeas_data.link_validity_days) || 15;
    const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

    if (consent) {
      if (intake && consent.intake_hash !== intake.hash) {
        consent.intake_snapshot = intake.snapshot;
        consent.intake_hash = intake.hash;
        pushEvent(consent, 'intake_updated', { by_user: userId });
      }
      consent.expires_at = expiresAt;
      await consent.save({ transaction });
    } else {
      consent = CustomerConsent.build({
        tenant_id: tenant.id,
        kind,
        customer_id: customer.id,
        work_order_id: order?.id || null,
        document_version_id: version.id,
        status: 'pending',
        expires_at: expiresAt,
        intake_snapshot: intake?.snapshot || null,
        intake_hash: intake?.hash || null,
        requested_by: userId,
        events: [],
      });
      pushEvent(consent, 'created', { by_user: userId, document_version: version.version });
      await consent.save({ transaction });
    }

    if (kind === 'habeas_data' && customer.habeas_data_status !== 'accepted') {
      await customer.update({ habeas_data_status: 'pending' }, { transaction });
    }

    await transaction.commit();

    if (kind === 'vehicle_intake' && settings.habeas_data.enabled && customer.habeas_data_status !== 'accepted') {
      await createConsentRequest({ tenant, kind: 'habeas_data', customerId: customer.id, userId })
        .catch((err) => logger.warn(`[Consent] No se pudo preparar habeas data junto al acta: ${err.message}`));
    }

    return consent;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Vuelve a tomar el inventario de una solicitud de ingreso pendiente (el
 * taller editó el checklist después de pedir la autorización).
 */
async function refreshPendingIntake({ tenant, workOrderId }) {
  const { CustomerConsent, WorkOrder, Vehicle } = require('../../models');
  const pending = await CustomerConsent.findOne({
    where: { tenant_id: tenant.id, kind: 'vehicle_intake', work_order_id: workOrderId, status: 'pending' },
  });
  if (!pending) return null;
  const order = await WorkOrder.findOne({ where: { id: workOrderId }, include: [{ model: Vehicle, as: 'vehicle' }] });
  if (!order) return null;
  const { snapshot, hash } = await buildIntakeSnapshot(order, getConsentSettings(tenant));
  if (hash === pending.intake_hash) return pending;
  pending.intake_snapshot = snapshot;
  pending.intake_hash = hash;
  // El código enviado se calculó sobre el inventario anterior: se invalida.
  pending.otp_expires_at = null;
  pushEvent(pending, 'intake_updated');
  await pending.save();
  return pending;
}

function markExpiredIfNeeded(consent) {
  if (consent.status === 'pending' && consent.expires_at && new Date(consent.expires_at) < new Date()) {
    consent.status = 'expired';
    pushEvent(consent, 'expired');
    return true;
  }
  return false;
}

// ─── OTP ───────────────────────────────────────────────────────────────────

function otpEmailHtml({ tenantName, code, kindLabel }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2937">
      <h2 style="margin-bottom:4px">${escapeHtml(tenantName)}</h2>
      <p>Tu código para confirmar la <strong>${escapeHtml(kindLabel)}</strong> es:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:bold;background:#f3f4f6;padding:16px;text-align:center;border-radius:8px">${code}</p>
      <p>Vence en 10 minutos. Si no solicitaste esta autorización, ignora este mensaje.</p>
      <p style="color:#6b7280;font-size:12px">No compartas este código con nadie que no sea quien te está atendiendo.</p>
    </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const KIND_LABELS = {
  habeas_data: 'autorización de tratamiento de datos personales',
  vehicle_intake: 'acta de ingreso de tu vehículo',
};

async function deliverOtp({ tenant, customer, channel, code, kind }) {
  const tenantName = tenant.business_name || tenant.company_name || 'Pitbox';
  if (channel === 'email') {
    if (!customer.email) throw httpError(400, 'El cliente no tiene correo registrado');
    const { sendEmail } = require('../emailService');
    if (!isEmailDeliveryConfigured()) {
      // Solo fuera de producción (getOtpChannels no ofrece email sin Brevo en
      // producción): sin proveedor no hay forma de probar el flujo de otro modo.
      logger.warn(`[Consent] Email no configurado -- OTP para ${customer.email}: ${code}`);
    }
    await sendEmail({
      to: customer.email,
      subject: `${code} es tu código de autorización — ${tenantName}`,
      html: otpEmailHtml({ tenantName, code, kindLabel: KIND_LABELS[kind] }),
      text: `${tenantName}: tu código para confirmar la ${KIND_LABELS[kind]} es ${code}. Vence en 10 minutos.`,
      ...(tenant.email && { replyTo: { email: tenant.email, name: tenantName } }),
    });
    return { destination: customer.email };
  }

  if (channel === 'whatsapp') {
    const phone = getCustomerWhatsappNumber(customer);
    if (!phone) throw httpError(400, 'El cliente no tiene celular registrado');
    const waCloud = require('../whatsappCloud.service');
    const status = await waCloud.getWhatsAppStatus(tenant.id);
    if (!status.operational) throw httpError(400, 'WhatsApp Cloud API no está conectado');
    const { otp } = getConsentSettings(tenant);
    if (otp.whatsapp_template && !status.demo_mode) {
      await waCloud.sendTemplateFromTenant({
        tenantId: tenant.id,
        to: phone,
        templateName: otp.whatsapp_template,
        language: otp.whatsapp_language || 'es',
        // Plantillas de autenticación de Meta: el código va en el cuerpo y
        // en el botón "copiar código".
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
        source: 'api',
      });
    } else {
      try {
        await waCloud.sendTextFromTenant({
          tenantId: tenant.id,
          to: phone,
          body: `*${tenantName}*\nTu código para confirmar la ${KIND_LABELS[kind]} es: *${code}*\nVence en 10 minutos. No lo compartas.`,
          source: 'api',
        });
      } catch (err) {
        if (err.code === 'WA_WINDOW_CLOSED') {
          throw httpError(400, 'El cliente no ha escrito por WhatsApp en las últimas 24 h y no hay plantilla de código configurada. Usa el correo o configura la plantilla en Configuración → Datos personales.');
        }
        throw err;
      }
    }
    return { destination: phone };
  }

  throw httpError(400, 'Canal no soportado');
}

/**
 * Genera y envía un nuevo OTP. Invalida el anterior (otp_counter + 1).
 */
async function sendOtp({ tenant, consent, channel, actor = {} }) {
  const { Customer } = require('../../models');
  if (markExpiredIfNeeded(consent)) {
    await consent.save();
    throw httpError(410, 'La solicitud venció. Pide un nuevo enlace.');
  }
  if (consent.status !== 'pending') throw httpError(409, 'Esta solicitud ya no está pendiente');
  if (consent.otp_counter >= OTP_MAX_SENDS) {
    throw httpError(429, 'Se alcanzó el máximo de códigos para esta solicitud. Pide un nuevo enlace.');
  }
  if (consent.otp_sent_at && Date.now() - new Date(consent.otp_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw httpError(429, 'Espera un minuto antes de pedir otro código');
  }

  const customer = await Customer.findOne({ where: { id: consent.customer_id } });
  const available = await getOtpChannels(tenant.id, customer);
  if (!available.some((c) => c.channel === channel)) {
    throw httpError(400, channel === 'email'
      ? 'No hay correo disponible para enviar el código'
      : 'No hay WhatsApp disponible para enviar el código');
  }

  let secret = consent.otp_secret ? decryptToken(consent.otp_secret) : null;
  if (!secret) {
    secret = generateSecret();
    consent.otp_secret = encryptToken(secret);
  }
  const counter = consent.otp_counter + 1;
  const code = generateSync({ strategy: 'hotp', secret, counter });

  const { destination } = await deliverOtp({ tenant, customer, channel, code, kind: consent.kind });

  consent.otp_counter = counter;
  consent.otp_channel = channel;
  consent.otp_destination = destination;
  consent.otp_sent_at = new Date();
  consent.otp_expires_at = new Date(Date.now() + OTP_TTL_MS);
  consent.otp_attempts = 0;
  pushEvent(consent, 'otp_sent', { channel, destination: channel === 'email' ? maskEmail(destination) : maskPhone(destination), ...actor });
  await consent.save();

  return { channel, destination: channel === 'email' ? maskEmail(destination) : maskPhone(destination), expires_at: consent.otp_expires_at };
}

function checkOtp(consent, code) {
  if (!consent.otp_secret || !consent.otp_expires_at) {
    throw httpError(400, 'Primero solicita el código');
  }
  if (new Date(consent.otp_expires_at) < new Date()) throw httpError(400, 'El código venció. Solicita uno nuevo.');
  if (consent.otp_attempts >= OTP_MAX_ATTEMPTS) throw httpError(429, 'Demasiados intentos. Solicita un código nuevo.');
  const token = String(code || '').replace(/\D/g, '');
  // verifySync lanza si el código no tiene exactamente 6 dígitos: cuenta
  // como intento fallido igual que un código equivocado.
  if (token.length !== 6) return false;
  const secret = decryptToken(consent.otp_secret);
  const { valid } = verifySync({ strategy: 'hotp', secret, token, counter: consent.otp_counter });
  return valid;
}

/**
 * Valida el OTP y, si es correcto, registra la aceptación. Para el acta de
 * ingreso, acceptHabeas + habeasToken aceptan también el habeas data
 * pendiente del cliente con la misma evidencia.
 */
async function verifyOtpAndAccept({
  tenant, consent, code, via, ip, userAgent, marketingOptIn = null,
  signerName = null, signerDocument = null, intakeHash = null,
  acceptHabeas = false, habeasToken = null, actor = {},
}) {
  const { CustomerConsent } = require('../../models');
  if (markExpiredIfNeeded(consent)) {
    await consent.save();
    throw httpError(410, 'La solicitud venció. Pide un nuevo enlace.');
  }
  if (consent.status !== 'pending') throw httpError(409, 'Esta solicitud ya no está pendiente');
  if (consent.kind === 'vehicle_intake' && intakeHash && intakeHash !== consent.intake_hash) {
    throw httpError(409, 'El inventario de ingreso cambió mientras lo revisabas. Recarga la página para ver la versión actual.');
  }

  const valid = checkOtp(consent, code);
  if (!valid) {
    consent.otp_attempts += 1;
    pushEvent(consent, 'otp_failed', { via, ip, ...actor });
    await consent.save();
    const left = OTP_MAX_ATTEMPTS - consent.otp_attempts;
    throw httpError(400, left > 0 ? `Código incorrecto. Te quedan ${left} intentos.` : 'Código incorrecto. Solicita un código nuevo.');
  }

  const evidence = {
    via, ip, userAgent, verifiedChannel: consent.otp_channel, verifiedDestination: consent.otp_destination,
    signerName, signerDocument, actor,
  };
  await acceptConsent(consent, { ...evidence, marketingOptIn });

  let habeas = null;
  if (consent.kind === 'vehicle_intake' && acceptHabeas && habeasToken) {
    habeas = await CustomerConsent.findOne({
      where: { token: habeasToken, kind: 'habeas_data', customer_id: consent.customer_id, status: 'pending' },
    });
    if (habeas) {
      await acceptConsent(habeas, { ...evidence, marketingOptIn, alongWith: consent.id });
    }
  }
  return { consent, habeas };
}

async function acceptConsent(consent, {
  via, ip = null, userAgent = null, verifiedChannel = null, verifiedDestination = null,
  signerName = null, signerDocument = null, marketingOptIn = null, physicalNotes = null,
  physicalDocument = null, actor = {}, alongWith = null,
}) {
  const { Customer, CustomerConsent } = require('../../models');
  const transaction = await sequelize.transaction();
  try {
    const now = new Date();
    consent.status = 'accepted';
    consent.accepted_at = now;
    consent.accepted_via = via;
    consent.accepted_ip = ip ? String(ip).slice(0, 45) : null;
    consent.accepted_user_agent = userAgent || null;
    consent.verified_channel = verifiedChannel;
    consent.verified_destination = verifiedDestination;
    consent.signer_name = signerName || null;
    consent.signer_document = signerDocument || null;
    consent.physical_notes = physicalNotes || null;
    consent.physical_document = physicalDocument || null;
    consent.otp_secret = null; // ya no se necesita
    if (consent.kind === 'habeas_data') consent.marketing_opt_in = marketingOptIn === true;
    pushEvent(consent, 'accepted', {
      via, ip: consent.accepted_ip, channel: verifiedChannel,
      ...(consent.kind === 'habeas_data' && { marketing_opt_in: consent.marketing_opt_in }),
      ...(alongWith && { along_with: alongWith }),
      ...actor,
    });
    await consent.save({ transaction });

    if (consent.kind === 'habeas_data') {
      await Customer.update(
        { habeas_data_status: 'accepted', habeas_data_at: now, marketing_opt_in: consent.marketing_opt_in },
        { where: { id: consent.customer_id }, transaction }
      );
      // Otras solicitudes de habeas pendientes del mismo cliente ya sobran.
      const others = await CustomerConsent.findAll({
        where: { customer_id: consent.customer_id, kind: 'habeas_data', status: 'pending', id: { [Op.ne]: consent.id } },
        transaction,
      });
      for (const o of others) {
        o.status = 'cancelled';
        pushEvent(o, 'superseded', { by_consent: consent.id });
        await o.save({ transaction });
      }
    }
    await transaction.commit();
    return consent;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function rejectConsent(consent, { ip = null, actor = {} } = {}) {
  const { Customer } = require('../../models');
  if (consent.status !== 'pending') throw httpError(409, 'Esta solicitud ya no está pendiente');
  consent.status = 'rejected';
  consent.rejected_at = new Date();
  pushEvent(consent, 'rejected', { ip, ...actor });
  await consent.save();
  if (consent.kind === 'habeas_data') {
    const customer = await Customer.findByPk(consent.customer_id);
    if (customer && customer.habeas_data_status !== 'accepted') {
      await customer.update({ habeas_data_status: 'rejected', habeas_data_at: new Date(), marketing_opt_in: false });
    }
  }
  return consent;
}

/**
 * Revocación (habeas data, a pedido del titular) o anulación de un acta de
 * ingreso aceptada (p. ej. el inventario estaba mal y hay que repetirla).
 */
async function revokeConsent(consent, { userId, reason }) {
  const { Customer, CustomerConsent } = require('../../models');
  if (consent.status !== 'accepted') throw httpError(409, 'Solo se puede revocar una autorización aceptada');
  if (!reason?.trim()) throw httpError(400, 'Indica el motivo');
  consent.status = 'revoked';
  consent.revoked_at = new Date();
  consent.revoked_by = userId;
  consent.revoke_reason = reason.trim();
  pushEvent(consent, 'revoked', { by_user: userId, reason: consent.revoke_reason });
  await consent.save();

  if (consent.kind === 'habeas_data') {
    const stillAccepted = await CustomerConsent.count({
      where: { customer_id: consent.customer_id, kind: 'habeas_data', status: 'accepted' },
    });
    if (!stillAccepted) {
      await Customer.update(
        { habeas_data_status: 'revoked', habeas_data_at: new Date(), marketing_opt_in: false },
        { where: { id: consent.customer_id } }
      );
    }
  }
  return consent;
}

/**
 * El titular retira solo la autorización de publicidad. Retirarla no
 * requiere verificación (siempre se debe poder); otorgarla sí, por eso no
 * hay el camino inverso aquí.
 */
async function optOutMarketing({ tenant, customerId, userId, reason = null }) {
  const { Customer, CustomerConsent } = require('../../models');
  const customer = await Customer.findOne({ where: { id: customerId, tenant_id: tenant.id } });
  if (!customer) throw httpError(404, 'Cliente no encontrado');
  await customer.update({ marketing_opt_in: false });
  const current = await CustomerConsent.findOne({
    where: { customer_id: customerId, kind: 'habeas_data', status: 'accepted' },
    order: [['accepted_at', 'DESC']],
  });
  if (current) {
    current.marketing_opt_in = false;
    pushEvent(current, 'marketing_opt_out', { by_user: userId, reason });
    await current.save();
  }
  return customer;
}

// ─── Envío del enlace ──────────────────────────────────────────────────────

/**
 * Envía el enlace de la solicitud al cliente. WhatsApp: Cloud API si está
 * conectado (texto -- solo entra con la ventana de 24h abierta); si no, se
 * devuelve un enlace wa.me para que el asesor lo envíe desde su WhatsApp.
 * El enlace no necesita ser secreto frente al asesor: la aceptación exige el
 * OTP, que va directo al correo/WhatsApp del cliente.
 */
async function sendConsentLink({ tenant, consent, channels = ['whatsapp'], userId = null }) {
  const { Customer } = require('../../models');
  const customer = await Customer.findOne({ where: { id: consent.customer_id } });
  const tenantName = tenant.business_name || tenant.company_name || '';
  const url = publicUrl(consent);
  const name = customer?.first_name || customerDisplayName(customer) || '';
  const what = consent.kind === 'habeas_data'
    ? 'autorizar el tratamiento de tus datos personales'
    : `revisar y aceptar el acta de ingreso de tu vehículo${consent.intake_snapshot?.vehicle?.plate ? ` ${consent.intake_snapshot.vehicle.plate}` : ''} (orden ${consent.intake_snapshot?.order_number || ''})`;
  const message = `Hola${name ? ` ${name}` : ''}! En *${tenantName}* te pedimos ${what}.\nPuedes leer el documento y confirmarlo aquí:\n${url}`;

  const result = { url, whatsapp: null, email: null };

  if (channels.includes('whatsapp')) {
    const phone = getCustomerWhatsappNumber(customer);
    if (!phone) {
      result.whatsapp = { sent: false, error: 'El cliente no tiene celular registrado' };
    } else {
      let sentByCloud = false;
      try {
        const waCloud = require('../whatsappCloud.service');
        const status = await waCloud.getWhatsAppStatus(tenant.id);
        if (status.operational) {
          const sent = await waCloud.sendTextFromTenant({ tenantId: tenant.id, to: phone, body: message, userId, source: 'api' });
          sentByCloud = true;
          result.whatsapp = { sent: true, channel: 'cloud_api', conversation_id: sent.conversation_id };
        }
      } catch (err) {
        logger.warn(`[Consent] Cloud API no envió el enlace, se usa wa.me: ${err.message}`);
      }
      if (!sentByCloud) {
        const { buildWaLink } = require('../whatsappService');
        result.whatsapp = { sent: false, channel: 'wa_me', whatsapp_url: buildWaLink(phone, message) };
      }
    }
  }

  if (channels.includes('email')) {
    if (!customer?.email) {
      result.email = { sent: false, error: 'El cliente no tiene correo registrado' };
    } else {
      try {
        const { sendEmail } = require('../emailService');
        const title = consent.kind === 'habeas_data' ? 'Autorización de tratamiento de datos personales' : 'Acta de ingreso de tu vehículo';
        await sendEmail({
          to: customer.email,
          subject: `${title} — ${tenantName}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1f2937">
            <h2>${escapeHtml(tenantName)}</h2>
            <p>Hola${name ? ` ${escapeHtml(name)}` : ''}, te pedimos ${escapeHtml(what)}.</p>
            <p><a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Revisar y autorizar</a></p>
            <p style="color:#6b7280;font-size:12px">Para confirmar te enviaremos un código de verificación. Si no reconoces esta solicitud, ignora este mensaje.</p>
          </div>`,
          text: message.replace(/\*/g, ''),
          ...(tenant.email && { replyTo: { email: tenant.email, name: tenantName } }),
        });
        result.email = { sent: true };
      } catch (err) {
        result.email = { sent: false, error: 'No se pudo enviar el correo' };
      }
    }
  }

  pushEvent(consent, 'link_sent', {
    by_user: userId,
    whatsapp: result.whatsapp?.channel || null,
    email: result.email?.sent || false,
  });
  await consent.save();
  return result;
}

// ─── Aviso de recepción del vehículo ───────────────────────────────────────

/**
 * Aviso automático al cliente cuando se recibe el vehículo (al crear la OT):
 * enlace de seguimiento de la OT y, si está activa, la solicitud del acta de
 * ingreso. Email + WhatsApp Cloud (plantilla si está configurada; texto si
 * la ventana de 24h está abierta). Si ningún canal automático llegó, se
 * devuelve el wa.me para que el asesor lo envíe a mano.
 */
async function notifyVehicleReception({ tenant, order, userId = null }) {
  const { Customer, WorkOrder, Vehicle } = require('../../models');
  const settings = getConsentSettings(tenant);
  const result = { email: null, whatsapp: null, intake_consent_id: null };
  const customer = order.customer_id ? await Customer.findOne({ where: { id: order.customer_id } }) : null;
  if (!customer) return result;

  // Share token de la OT (mismo patrón que generateShareToken/sendWhatsApp).
  const wo = await WorkOrder.findOne({ where: { id: order.id }, include: [{ model: Vehicle, as: 'vehicle' }] });
  if (!wo.share_token) await wo.update({ share_token: crypto.randomUUID() });
  const trackingUrl = `${frontendUrl()}/ot/${wo.share_token}`;

  let intakeUrl = null;
  if (settings.vehicle_intake.enabled) {
    try {
      const consent = await createConsentRequest({ tenant, kind: 'vehicle_intake', workOrderId: wo.id, userId });
      intakeUrl = publicUrl(consent);
      result.intake_consent_id = consent.id;
    } catch (err) {
      logger.warn(`[Consent] No se pudo crear el acta de ingreso de ${wo.order_number}: ${err.message}`);
    }
  }

  const tenantName = tenant.business_name || tenant.company_name || '';
  const plate = wo.vehicle?.plate || '';
  const name = customer.first_name || customerDisplayName(customer);
  const lines = [
    `Hola${name ? ` ${name}` : ''}! En *${tenantName}* recibimos tu vehículo${plate ? ` *${plate}*` : ''}.`,
    `Orden de trabajo: *${wo.order_number}*.`,
    `Sigue el estado en tiempo real aquí:\n${trackingUrl}`,
  ];
  if (intakeUrl) lines.push(`Por favor revisa y acepta el acta de ingreso (inventario y condiciones del servicio):\n${intakeUrl}`);
  const message = lines.join('\n');

  if (customer.email) {
    try {
      const { sendEmail } = require('../emailService');
      await sendEmail({
        to: customer.email,
        subject: `Recibimos tu vehículo ${plate} — ${wo.order_number}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1f2937">
          <h2>${escapeHtml(tenantName)}</h2>
          <p>Hola${name ? ` ${escapeHtml(name)}` : ''}, recibimos tu vehículo <strong>${escapeHtml(plate)}</strong>. Orden de trabajo <strong>${escapeHtml(wo.order_number)}</strong>.</p>
          <p><a href="${trackingUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Ver estado de la orden</a></p>
          ${intakeUrl ? `<p>Por favor revisa y acepta el acta de ingreso (inventario y condiciones del servicio):</p>
          <p><a href="${intakeUrl}" style="display:inline-block;background:#059669;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Revisar acta de ingreso</a></p>` : ''}
        </div>`,
        text: message.replace(/\*/g, ''),
        ...(tenant.email && { replyTo: { email: tenant.email, name: tenantName } }),
      });
      result.email = { sent: true };
    } catch (err) {
      result.email = { sent: false };
    }
  }

  const phone = getCustomerWhatsappNumber(customer);
  if (phone) {
    let sent = false;
    try {
      const waCloud = require('../whatsappCloud.service');
      const status = await waCloud.getWhatsAppStatus(tenant.id);
      if (status.operational) {
        const template = settings.vehicle_intake.whatsapp_reception_template;
        if (template && !status.demo_mode) {
          await waCloud.sendTemplateFromTenant({
            tenantId: tenant.id,
            to: phone,
            templateName: template,
            language: settings.otp.whatsapp_language || 'es',
            components: [{
              type: 'body',
              parameters: [name || 'cliente', wo.order_number, plate || '-', intakeUrl || trackingUrl]
                .map((text) => ({ type: 'text', text: String(text) })),
            }],
            userId,
            source: 'api',
          });
        } else {
          await waCloud.sendTextFromTenant({ tenantId: tenant.id, to: phone, body: message, userId, source: 'api' });
        }
        sent = true;
        result.whatsapp = { sent: true, channel: 'cloud_api' };
      }
    } catch (err) {
      logger.info(`[Consent] Aviso de recepción ${wo.order_number} por Cloud API no salió (${err.code || err.message}); queda wa.me`);
    }
    if (!sent) {
      const { buildWaLink } = require('../whatsappService');
      result.whatsapp = { sent: false, channel: 'wa_me', whatsapp_url: buildWaLink(phone, message) };
    }
  }

  return result;
}

// ─── Resolución pública por token ──────────────────────────────────────────

// Mismo patrón que resolveWorkOrderSchemaByToken: la página pública no sabe
// de qué tenant es el token, así que se busca schema por schema.
async function resolveConsentSchemaByToken(token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) return null;
  const [tenants] = await sequelize.query(
    'SELECT schema_name FROM "public"."tenants" WHERE schema_name IS NOT NULL'
  );
  const schemas = [null, ...tenants.map((t) => t.schema_name)];
  for (const schema of schemas) {
    const table = schema ? `"${schema}"."customer_consents"` : '"public"."customer_consents"';
    try {
      const [rows] = await sequelize.query(
        `SELECT id FROM ${table} WHERE token = :token LIMIT 1`,
        { replacements: { token } }
      );
      if (rows[0]) return { consentId: rows[0].id, schemaName: schema };
    } catch {
      // Schema sin la migración todavía: se sigue con el siguiente.
    }
  }
  return null;
}

function withConsentByToken(token, fn) {
  return resolveConsentSchemaByToken(token).then((resolved) => {
    if (!resolved) throw httpError(404, 'Enlace inválido o vencido');
    return runWithTenantSchema(resolved.schemaName, () => fn(resolved.consentId));
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_INTAKE_CHECKLIST,
  FUEL_LABELS,
  KIND_LABELS,
  getConsentSettings,
  renderDocument,
  ensureDocumentVersion,
  getOtpChannels,
  createConsentRequest,
  refreshPendingIntake,
  markExpiredIfNeeded,
  sendOtp,
  verifyOtpAndAccept,
  acceptConsent,
  rejectConsent,
  revokeConsent,
  optOutMarketing,
  sendConsentLink,
  notifyVehicleReception,
  withConsentByToken,
  publicUrl,
  maskEmail,
  maskPhone,
  customerDisplayName,
  pushEvent,
  httpError,
};
