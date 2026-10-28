// backend/src/controllers/legal/consents.controller.js
//
// Autorizaciones del cliente (habeas data y acta de ingreso del vehículo).
// Lógica en services/legal/consent.service.js; aquí solo HTTP.
//
//   /api/consents/...            -- personal del taller (auth + tenant)
//   /api/public/consents/:token  -- el cliente, sin autenticación

const QRCode = require('qrcode');
const logger = require('../../config/logger');
const { Tenant, Customer, CustomerConsent, LegalDocumentVersion, WorkOrder } = require('../../models');
const svc = require('../../services/legal/consent.service');
const { generateConsentPdfBuffer } = require('../../services/legal/consentPdf.service');
const { VARIABLES } = require('../../data/legal/standardDocuments');
const { ALLOWED_MIMES, storeSignedDocument, resolveSignedDocument } = require('../../services/legal/consentDocumentStorage');

const TENANT_ATTRS = [
  'id', 'slug', 'company_name', 'business_name', 'tax_id', 'email', 'phone', 'address',
  'logo_url', 'primary_color', 'business_config', 'dian_config',
];

const loadTenant = (tenantId) => Tenant.findByPk(tenantId, { attributes: TENANT_ATTRS });

function handleError(res, error, fallback) {
  if (error.status) return res.status(error.status).json({ success: false, message: error.message });
  logger.error(`[Consents] ${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;

const actorFromReq = (req) => ({ by_user: req.user?.id || null });

async function serializeConsent(consent, { withQr = false } = {}) {
  const data = {
    id: consent.id,
    kind: consent.kind,
    status: consent.status,
    customer_id: consent.customer_id,
    work_order_id: consent.work_order_id,
    expires_at: consent.expires_at,
    document_version: consent.document_version
      ? { id: consent.document_version.id, version: consent.document_version.version, source: consent.document_version.source }
      : null,
    marketing_opt_in: consent.marketing_opt_in,
    intake_hash: consent.intake_hash,
    otp_channel: consent.otp_channel,
    otp_sent_at: consent.otp_sent_at,
    otp_expires_at: consent.otp_expires_at,
    accepted_at: consent.accepted_at,
    accepted_via: consent.accepted_via,
    verified_channel: consent.verified_channel,
    signer_name: consent.signer_name,
    physical_document: consent.physical_document
      ? { filename: consent.physical_document.filename, mime: consent.physical_document.mime, uploaded_at: consent.physical_document.uploaded_at }
      : null,
    rejected_at: consent.rejected_at,
    revoked_at: consent.revoked_at,
    revoke_reason: consent.revoke_reason,
    events: consent.events || [],
    created_at: consent.created_at,
    public_url: svc.publicUrl(consent),
  };
  if (withQr && consent.status === 'pending') {
    data.qr_data_url = await QRCode.toDataURL(data.public_url, { margin: 1, width: 280 });
  }
  return data;
}

async function findTenantConsent(req) {
  const consent = await CustomerConsent.findOne({
    where: { id: req.params.id, tenant_id: req.tenant_id },
    include: [{ model: LegalDocumentVersion, as: 'document_version' }],
  });
  if (!consent) throw svc.httpError(404, 'Solicitud no encontrada');
  if (svc.markExpiredIfNeeded(consent)) await consent.save();
  return consent;
}

// ─── Personal del taller ───────────────────────────────────────────────────

// GET /api/consents/preview?kind=habeas_data|vehicle_intake
// POST /api/consents/preview { kind, business_config } -- con la configuración
// que el admin está editando y aún no guardó (no se persiste nada).
const previewDocument = async (req, res) => {
  try {
    const rawKind = req.body?.kind || req.query.kind;
    const kind = rawKind === 'vehicle_intake' ? 'vehicle_intake' : 'habeas_data';
    const tenant = await loadTenant(req.tenant_id);
    const draft = req.body?.business_config;
    if (draft && typeof draft === 'object') {
      const merged = { ...(tenant.business_config || {}) };
      for (const key of ['habeas_data', 'vehicle_intake']) {
        if (draft[key] && typeof draft[key] === 'object') merged[key] = draft[key];
      }
      tenant.business_config = merged;
    }
    const { content, source, missing } = await svc.renderDocument(tenant, kind);
    res.json({ success: true, data: { kind, content, source, missing, variables: VARIABLES } });
  } catch (error) {
    handleError(res, error, 'Error generando la vista previa');
  }
};

// GET /api/consents/customer/:customerId
const getCustomerConsents = async (req, res) => {
  try {
    const tenant = await loadTenant(req.tenant_id);
    const customer = await Customer.findOne({ where: { id: req.params.customerId, tenant_id: req.tenant_id } });
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    const consents = await CustomerConsent.findAll({
      where: { customer_id: customer.id, tenant_id: req.tenant_id, kind: 'habeas_data' },
      include: [{ model: LegalDocumentVersion, as: 'document_version', attributes: ['id', 'version', 'source'] }],
      order: [['created_at', 'DESC']],
      limit: 20,
    });
    const settings = svc.getConsentSettings(tenant);
    res.json({
      success: true,
      data: {
        enabled: settings.habeas_data.enabled,
        habeas_data_status: customer.habeas_data_status,
        habeas_data_at: customer.habeas_data_at,
        marketing_opt_in: customer.marketing_opt_in,
        otp_channels: await svc.getOtpChannels(tenant.id, customer),
        consents: await Promise.all(consents.map((c) => serializeConsent(c))),
      },
    });
  } catch (error) {
    handleError(res, error, 'Error consultando autorizaciones');
  }
};

// GET /api/consents/work-order/:workOrderId
const getWorkOrderConsents = async (req, res) => {
  try {
    const tenant = await loadTenant(req.tenant_id);
    const order = await WorkOrder.findOne({ where: { id: req.params.workOrderId, tenant_id: req.tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    const customer = order.customer_id ? await Customer.findByPk(order.customer_id) : null;
    const consents = await CustomerConsent.findAll({
      where: { work_order_id: order.id, tenant_id: req.tenant_id, kind: 'vehicle_intake' },
      include: [{ model: LegalDocumentVersion, as: 'document_version', attributes: ['id', 'version', 'source'] }],
      order: [['created_at', 'DESC']],
      limit: 10,
    });
    for (const c of consents) {
      if (svc.markExpiredIfNeeded(c)) await c.save();
    }
    const settings = svc.getConsentSettings(tenant);
    res.json({
      success: true,
      data: {
        enabled: settings.vehicle_intake.enabled,
        habeas_enabled: settings.habeas_data.enabled,
        checklist_items: settings.vehicle_intake.checklist_items,
        customer: customer ? {
          id: customer.id,
          habeas_data_status: customer.habeas_data_status,
          marketing_opt_in: customer.marketing_opt_in,
        } : null,
        otp_channels: customer ? await svc.getOtpChannels(tenant.id, customer) : [],
        consents: await Promise.all(consents.map((c) => serializeConsent(c))),
      },
    });
  } catch (error) {
    handleError(res, error, 'Error consultando el acta de ingreso');
  }
};

// GET /api/consents/intake-checklist -- ítems configurados del inventario
const getIntakeChecklist = async (req, res) => {
  try {
    const tenant = await loadTenant(req.tenant_id);
    const settings = svc.getConsentSettings(tenant);
    res.json({ success: true, data: { items: settings.vehicle_intake.checklist_items, enabled: settings.vehicle_intake.enabled } });
  } catch (error) {
    handleError(res, error, 'Error consultando el inventario');
  }
};

// POST /api/consents  { kind, customer_id?, work_order_id? }
const createRequest = async (req, res) => {
  try {
    const { kind, customer_id, work_order_id } = req.body || {};
    const tenant = await loadTenant(req.tenant_id);
    const consent = await svc.createConsentRequest({
      tenant, kind, customerId: customer_id, workOrderId: work_order_id, userId: req.user?.id,
    });
    await consent.reload({ include: [{ model: LegalDocumentVersion, as: 'document_version' }] });
    res.status(201).json({ success: true, data: await serializeConsent(consent, { withQr: true }) });
  } catch (error) {
    handleError(res, error, 'Error creando la solicitud');
  }
};

// GET /api/consents/:id
const getRequest = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    res.json({ success: true, data: await serializeConsent(consent, { withQr: true }) });
  } catch (error) {
    handleError(res, error, 'Error consultando la solicitud');
  }
};

// POST /api/consents/:id/send-link  { channels: ['whatsapp','email'] }
const sendLink = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    if (consent.status !== 'pending') return res.status(409).json({ success: false, message: 'La solicitud ya no está pendiente' });
    const tenant = await loadTenant(req.tenant_id);
    const channels = Array.isArray(req.body?.channels) && req.body.channels.length ? req.body.channels : ['whatsapp'];
    const result = await svc.sendConsentLink({ tenant, consent, channels, userId: req.user?.id });
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, 'Error enviando el enlace');
  }
};

// POST /api/consents/:id/otp  { channel }   -- modo mostrador
const sendOtpCounter = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    const tenant = await loadTenant(req.tenant_id);
    const data = await svc.sendOtp({ tenant, consent, channel: req.body?.channel, actor: { ...actorFromReq(req), via: 'counter' } });
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'Error enviando el código');
  }
};

// POST /api/consents/:id/verify  { code, marketing_opt_in, accept_habeas }  -- modo mostrador
const verifyCounter = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    const tenant = await loadTenant(req.tenant_id);
    const { code, marketing_opt_in, accept_habeas, signer_name, signer_document } = req.body || {};

    // En mostrador el habeas pendiente se acepta junto al acta si el asesor
    // lo marca (el cliente lo leyó en la pantalla / impreso).
    let habeasToken = null;
    if (consent.kind === 'vehicle_intake' && accept_habeas) {
      const habeas = await CustomerConsent.findOne({
        where: { customer_id: consent.customer_id, kind: 'habeas_data', status: 'pending' },
        order: [['created_at', 'DESC']],
      });
      habeasToken = habeas?.token || null;
    }

    const result = await svc.verifyOtpAndAccept({
      tenant, consent, code, via: 'counter', ip: clientIp(req), userAgent: req.headers['user-agent'],
      marketingOptIn: marketing_opt_in === true, signerName: signer_name, signerDocument: signer_document,
      acceptHabeas: !!accept_habeas, habeasToken, actor: actorFromReq(req),
    });
    res.json({
      success: true,
      message: 'Autorización registrada',
      data: { consent: await serializeConsent(result.consent), habeas_accepted: !!result.habeas },
    });
  } catch (error) {
    handleError(res, error, 'Error verificando el código');
  }
};

// POST /api/consents/:id/physical  (multipart)
//   { marketing_opt_in, signer_name, signer_document, notes } + document (escaneo, opcional)
const registerPhysical = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    if (consent.status !== 'pending') return res.status(409).json({ success: false, message: 'La solicitud ya no está pendiente' });
    const { signer_name, signer_document, notes } = req.body || {};
    // Llega como texto en multipart.
    const marketing_opt_in = req.body?.marketing_opt_in === true || req.body?.marketing_opt_in === 'true';
    if (!signer_name?.trim()) return res.status(400).json({ success: false, message: 'Indica el nombre de quien firmó' });
    let physicalDocument = null;
    if (req.file) {
      if (!ALLOWED_MIMES.includes(req.file.mimetype)) {
        return res.status(400).json({ success: false, message: 'El documento firmado debe ser una imagen (JPG, PNG, WEBP) o un PDF' });
      }
      physicalDocument = await storeSignedDocument({ tenantId: req.tenant_id, consentId: consent.id, file: req.file });
    }
    await svc.acceptConsent(consent, {
      physicalDocument,
      via: 'physical',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      signerName: signer_name.trim(),
      signerDocument: signer_document?.trim() || null,
      marketingOptIn: marketing_opt_in === true,
      physicalNotes: notes?.trim() || null,
      actor: actorFromReq(req),
    });
    res.json({ success: true, message: 'Autorización física registrada', data: await serializeConsent(consent) });
  } catch (error) {
    handleError(res, error, 'Error registrando la autorización');
  }
};

// GET /api/consents/:id/physical-document -- enlace temporal (Cloudinary) o el archivo (local)
const getPhysicalDocument = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    const resolved = resolveSignedDocument(consent.physical_document);
    if (!resolved) return res.status(404).json({ success: false, message: 'Esta autorización no tiene documento firmado adjunto' });
    if (resolved.url) return res.json({ success: true, data: { url: resolved.url, expires_in: 600 } });
    res.set({
      'Content-Type': consent.physical_document.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(consent.physical_document.filename || 'documento')}"`,
      'Cache-Control': 'no-store',
    });
    return res.sendFile(resolved.localPath);
  } catch (error) {
    if (!res.headersSent) handleError(res, error, 'Error obteniendo el documento firmado');
  }
};

// POST /api/consents/:id/cancel
const cancelRequest = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    if (consent.status !== 'pending') return res.status(409).json({ success: false, message: 'La solicitud ya no está pendiente' });
    consent.status = 'cancelled';
    svc.pushEvent(consent, 'cancelled', actorFromReq(req));
    await consent.save();
    if (consent.kind === 'habeas_data') {
      const customer = await Customer.findByPk(consent.customer_id);
      const stillPending = await CustomerConsent.count({
        where: { customer_id: consent.customer_id, kind: 'habeas_data', status: 'pending' },
      });
      if (customer?.habeas_data_status === 'pending' && !stillPending) await customer.update({ habeas_data_status: null });
    }
    res.json({ success: true, data: await serializeConsent(consent) });
  } catch (error) {
    handleError(res, error, 'Error anulando la solicitud');
  }
};

// POST /api/consents/:id/revoke  { reason }
const revokeRequest = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    await svc.revokeConsent(consent, { userId: req.user?.id, reason: req.body?.reason });
    res.json({ success: true, data: await serializeConsent(consent) });
  } catch (error) {
    handleError(res, error, 'Error revocando la autorización');
  }
};

// POST /api/consents/customer/:customerId/marketing-opt-out  { reason }
const marketingOptOut = async (req, res) => {
  try {
    const tenant = await loadTenant(req.tenant_id);
    await svc.optOutMarketing({ tenant, customerId: req.params.customerId, userId: req.user?.id, reason: req.body?.reason || null });
    res.json({ success: true, message: 'El cliente ya no recibirá comunicaciones comerciales' });
  } catch (error) {
    handleError(res, error, 'Error actualizando la autorización de publicidad');
  }
};

async function sendConsentPdf(res, consent, tenant) {
  const customer = await Customer.findByPk(consent.customer_id);
  const buffer = await generateConsentPdfBuffer({ consent, customer, tenant });
  const name = consent.kind === 'habeas_data' ? 'autorizacion-datos' : `acta-ingreso-${consent.intake_snapshot?.order_number || ''}`;
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${name}.pdf"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.send(buffer);
}

// GET /api/consents/:id/pdf
const getPdf = async (req, res) => {
  try {
    const consent = await findTenantConsent(req);
    const tenant = await loadTenant(req.tenant_id);
    await sendConsentPdf(res, consent, tenant);
  } catch (error) {
    if (!res.headersSent) handleError(res, error, 'Error generando el PDF');
  }
};

// ─── Público (cliente) ─────────────────────────────────────────────────────

async function loadPublicConsent(consentId) {
  const consent = await CustomerConsent.findByPk(consentId, {
    include: [{ model: LegalDocumentVersion, as: 'document_version' }],
  });
  if (!consent) throw svc.httpError(404, 'Enlace inválido o vencido');
  if (svc.markExpiredIfNeeded(consent)) await consent.save();
  return consent;
}

// GET /api/public/consents/:token
const getPublicConsent = async (req, res) => {
  try {
    await svc.withConsentByToken(req.params.token, async (consentId) => {
      const consent = await loadPublicConsent(consentId);
      const tenant = await loadTenant(consent.tenant_id);
      const customer = await Customer.findByPk(consent.customer_id);

      // Acta de ingreso: si el cliente tiene habeas pendiente, se ofrece
      // aceptarlo en la misma página con el mismo código.
      let habeas = null;
      if (consent.kind === 'vehicle_intake' && consent.status === 'pending') {
        const pendingHabeas = await CustomerConsent.findOne({
          where: { customer_id: consent.customer_id, kind: 'habeas_data', status: 'pending' },
          include: [{ model: LegalDocumentVersion, as: 'document_version' }],
          order: [['created_at', 'DESC']],
        });
        if (pendingHabeas && !svc.markExpiredIfNeeded(pendingHabeas)) {
          habeas = {
            token: pendingHabeas.token,
            content: pendingHabeas.document_version?.content || '',
            version: pendingHabeas.document_version?.version || null,
          };
        }
      }

      res.json({
        success: true,
        data: {
          kind: consent.kind,
          status: consent.status,
          expires_at: consent.expires_at,
          tenant: {
            name: tenant.business_name || tenant.company_name,
            logo_url: tenant.logo_url,
            primary_color: tenant.primary_color,
            phone: tenant.phone,
            email: tenant.email,
          },
          customer_name: customer?.first_name || svc.customerDisplayName(customer),
          document: {
            content: consent.document_version?.content || '',
            version: consent.document_version?.version || null,
          },
          intake: consent.kind === 'vehicle_intake' ? { snapshot: consent.intake_snapshot, hash: consent.intake_hash } : null,
          habeas,
          otp_channels: consent.status === 'pending' ? await svc.getOtpChannels(tenant.id, customer) : [],
          otp: consent.status === 'pending' && consent.otp_expires_at && new Date(consent.otp_expires_at) > new Date()
            ? {
                channel: consent.otp_channel,
                destination: consent.otp_channel === 'email' ? svc.maskEmail(consent.otp_destination) : svc.maskPhone(consent.otp_destination),
                expires_at: consent.otp_expires_at,
              }
            : null,
          accepted_at: consent.accepted_at,
          marketing_opt_in: consent.marketing_opt_in,
        },
      });
    });
  } catch (error) {
    handleError(res, error, 'Error consultando la autorización');
  }
};

// POST /api/public/consents/:token/otp  { channel }
const sendPublicOtp = async (req, res) => {
  try {
    await svc.withConsentByToken(req.params.token, async (consentId) => {
      const consent = await loadPublicConsent(consentId);
      const tenant = await loadTenant(consent.tenant_id);
      const data = await svc.sendOtp({ tenant, consent, channel: req.body?.channel, actor: { via: 'public_link', ip: clientIp(req) } });
      res.json({ success: true, data });
    });
  } catch (error) {
    handleError(res, error, 'Error enviando el código');
  }
};

// POST /api/public/consents/:token/accept
//   { code, marketing_opt_in, signer_name, signer_document, intake_hash, accept_habeas, habeas_token }
const acceptPublic = async (req, res) => {
  try {
    await svc.withConsentByToken(req.params.token, async (consentId) => {
      const consent = await loadPublicConsent(consentId);
      const tenant = await loadTenant(consent.tenant_id);
      const body = req.body || {};
      const result = await svc.verifyOtpAndAccept({
        tenant, consent, code: body.code, via: 'public_link',
        ip: clientIp(req), userAgent: req.headers['user-agent'],
        marketingOptIn: body.marketing_opt_in === true,
        signerName: body.signer_name?.trim() || null,
        signerDocument: body.signer_document?.trim() || null,
        intakeHash: body.intake_hash || null,
        acceptHabeas: body.accept_habeas === true,
        habeasToken: body.habeas_token || null,
      });
      res.json({ success: true, message: 'Autorización registrada', data: { status: result.consent.status, habeas_accepted: !!result.habeas } });
    });
  } catch (error) {
    handleError(res, error, 'Error registrando la autorización');
  }
};

// POST /api/public/consents/:token/reject
const rejectPublic = async (req, res) => {
  try {
    await svc.withConsentByToken(req.params.token, async (consentId) => {
      const consent = await loadPublicConsent(consentId);
      await svc.rejectConsent(consent, { ip: clientIp(req) });
      res.json({ success: true, data: { status: consent.status } });
    });
  } catch (error) {
    handleError(res, error, 'Error registrando la respuesta');
  }
};

// GET /api/public/consents/:token/pdf -- constancia para el titular
const getPublicPdf = async (req, res) => {
  try {
    await svc.withConsentByToken(req.params.token, async (consentId) => {
      const consent = await loadPublicConsent(consentId);
      if (!['accepted', 'revoked'].includes(consent.status)) {
        return res.status(409).json({ success: false, message: 'La autorización aún no ha sido aceptada' });
      }
      const tenant = await loadTenant(consent.tenant_id);
      await sendConsentPdf(res, consent, tenant);
    });
  } catch (error) {
    if (!res.headersSent) handleError(res, error, 'Error generando el PDF');
  }
};

module.exports = {
  previewDocument,
  getCustomerConsents,
  getWorkOrderConsents,
  getIntakeChecklist,
  createRequest,
  getRequest,
  sendLink,
  sendOtpCounter,
  verifyCounter,
  registerPhysical,
  getPhysicalDocument,
  cancelRequest,
  revokeRequest,
  marketingOptOut,
  getPdf,
  getPublicConsent,
  sendPublicOtp,
  acceptPublic,
  rejectPublic,
  getPublicPdf,
};
