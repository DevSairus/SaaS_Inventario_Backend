// backend/src/services/radian/radianService.js
/**
 * Orquesta la emisión de eventos RADIAN: valida secuencia → construye XML →
 * firma → envía a la DIAN → persiste. Fases 1–4 (ver
 * 00 - Documentación/RADIAN-Analisis-y-Plan.md §5.2, §6):
 *   - 030/032/031/033 — los emitimos como ADQUIRENTE sobre una Purchase.
 *   - 034 — lo emitimos como EMISOR sobre una Sale, solo tras vencer el
 *     plazo sin que el cliente responda con 033/031 (registrado a mano vía
 *     recordSaleReceivedEvent — ver nota ahí sobre por qué es manual).
 *   - 036/037-040/045-046 — requieren la factura ya inscrita (036 primero).
 *   - 043/044 (Mandato) — EXCEPCIÓN confirmada: no requieren inscripción
 *     previa (ver comentario en emitMandato043 más abajo).
 *   - 041/042 (Limitación de circulación) — el Responsable real es la
 *     autoridad judicial/administrativa, no un tenant normal (ver
 *     comentario en emitLimitacion041 más abajo) — confirmado contra el
 *     Anexo RADIAN v1.0 numeral 13.2.1.
 */
'use strict';

const logger = require('../../config/logger');
const { Purchase, Sale, Supplier, Customer, Tenant, RadianEvent, User } = require('../../models');
const { signXml } = require('../dian/dianSignerService');
const dianApiService = require('../dian/dianApiService');
const { buildEventXml } = require('./radianXmlBuilder');
const { addBusinessDays, isWithinBusinessDeadline } = require('./businessDays');

// Prefijo del consecutivo del ApplicationResponse — regla de numeración de
// eventos aún sin confirmar contra el Anexo (ver checklist §8 del plan:
// "Regla del consecutivo del evento. Sin resolver"). MEJOR ESFUERZO: prefijo
// "ARC" + código de evento + conteo del tenant + 1, sin depender de una
// resolución/numeración DIAN (los eventos no la requieren, a diferencia de
// factura).
const ID_PREFIX = 'ARC';

function assertDianConfig(cfg) {
  if (!cfg.nit) throw new Error('Configure el NIT de la empresa en Configuración DIAN antes de emitir eventos RADIAN.');
  if (!cfg.certificate_p12_base64 || cfg.certificate_p12_base64 === '[CONFIGURADO]') {
    throw new Error('Certificado digital no configurado.');
  }
  if (!cfg.certificate_password || cfg.certificate_password === '[CONFIGURADO]') {
    throw new Error('Contraseña del certificado no configurada.');
  }
  if (!cfg.software_pin) throw new Error('Configure el Software PIN en Configuración DIAN.');
}

/**
 * Núcleo de bajo nivel, compartido por Compras (030-033) y Ventas (034):
 * construye el ApplicationResponse → lo firma → lo envía a la DIAN →
 * persiste la fila en radian_events. NO valida secuencia/plazo ni actualiza
 * purchase/sale.radian_status — eso lo hace cada caller, que conoce su
 * propia máquina de estados.
 */
async function sendRadianEvent({
  eventCode, tenantId, userId,
  purchaseId, saleId,
  documentNumber, documentCufe,
  counterpartyNit, counterpartyName,
  claimReasonCode, claimReasonText, declarantType,
  extraNote, details,
}) {
  const user = userId ? await User.findByPk(userId, { attributes: ['id', 'first_name', 'last_name', 'cedula'] }) : null;
  const tenant = await Tenant.findByPk(tenantId);
  const cfg = tenant.dian_config || {};
  assertDianConfig(cfg);

  const priorCount = await RadianEvent.count({ where: { tenant_id: tenantId, event_code: eventCode, direction: 'emitted' } });
  const applicationResponseId = `${ID_PREFIX}${eventCode}${String(priorCount + 1).padStart(6, '0')}`;

  const { xml, cude, issueDate, issueTime } = buildEventXml({
    eventCode,
    applicationResponseId,
    invoiceNumber: documentNumber,
    invoiceCufe: documentCufe,
    // Espacios sin recortar en el NIT rompen el hash del CUDE igual que ya
    // rompían el del CUFE (ver dianKitAdapter.js#cleanId).
    ownNit: String(cfg.nit).trim(),
    ownName: cfg.company_name || tenant.company_name,
    counterpartyNit: String(counterpartyNit).trim(),
    counterpartyName,
    issuerFirstName: user?.first_name || 'N/A',
    issuerFamilyName: user?.last_name || 'N/A',
    claimReasonCode, claimReasonText, declarantType, extraNote,
    softwarePin: cfg.software_pin,
    environment: cfg.environment || 'test',
  });

  const eventRow = await RadianEvent.create({
    tenant_id: tenantId,
    direction: 'emitted',
    purchase_id: purchaseId || null,
    sale_id: saleId || null,
    document_cufe: documentCufe,
    document_number: documentNumber,
    counterparty_nit: counterpartyNit,
    event_code: eventCode,
    cude,
    issued_at: new Date(`${issueDate}T${(issueTime || '00:00:00').replace(/-05:00$/, '')}`),
    issuer_user_id: user?.id || null,
    issuer_snapshot: ['030', '032'].includes(eventCode)
      ? { first_name: user?.first_name, last_name: user?.last_name, cedula: user?.cedula }
      : null,
    claim_reason_code: eventCode === '031' ? (claimReasonCode || null) : null,
    details: details || null,
    request_xml: xml,
    dian_status: 'sending',
    is_test: cfg.environment !== 'production',
    created_by: user?.id || null,
  });

  try {
    const signedXml = await signXml(xml, {
      p12Base64: cfg.certificate_p12_base64,
      password: cfg.certificate_password,
      invoiceNumber: applicationResponseId,
    });

    const result = await dianApiService.sendEventUpdateStatus({
      signedXml,
      nit: cfg.nit,
      documentNumber: applicationResponseId,
      p12Base64: cfg.certificate_p12_base64,
      password: cfg.certificate_password,
      environment: cfg.environment || 'test',
    });

    const accepted = result.isValid || result.statusCode === '00';

    await eventRow.update({
      signed_xml: signedXml,
      track_id: result.xmlDocumentKey || null,
      dian_status: accepted ? 'accepted' : 'rejected',
      dian_response_raw: result.raw,
      error_message: accepted ? null : (result.statusMessage || result.statusDescription || 'Rechazado por la DIAN'),
    });

    return {
      accepted,
      statusCode: result.statusCode,
      trackId: result.xmlDocumentKey,
      message: result.statusMessage || result.statusDescription,
      eventId: eventRow.id,
      issuedAt: eventRow.issued_at,
    };
  } catch (err) {
    logger.error(`[RADIAN] Error emitiendo ${eventCode}:`, err.message);
    await eventRow.update({ dian_status: 'error', error_message: err.message });
    throw err;
  }
}

// ─── Compras (adquirente): 030, 032, 031, 033 ──────────────────────────────

// Máquina de estados: qué purchase.radian_status debe haber ANTES de poder
// emitir cada evento, y en qué queda DESPUÉS de aceptado. Ver §5.1/§5.4 del
// plan y el diagrama de secuencia comercial en §2.
const PURCHASE_EVENT_RULES = {
  '030': { requiresStatus: ['none'], setsStatus: '030', requiresDeadline: false },
  '032': { requiresStatus: ['030'], setsStatus: '032', requiresDeadline: false },
  '031': { requiresStatus: ['032'], setsStatus: '031', requiresDeadline: true },
  '033': { requiresStatus: ['032'], setsStatus: '033', requiresDeadline: true },
};

/**
 * Emite un evento del adquirente (030, 032, 031 o 033) sobre una compra
 * importada desde factura electrónica del proveedor.
 *
 * @param {'030'|'032'|'031'|'033'} eventCode
 * @param {string} purchaseId
 * @param {string} tenantId
 * @param {string} userId - quien ejecuta el evento (JWT solo trae id/email/role)
 * @param {{claimReasonCode?: string, claimReasonText?: string}} [extra] - solo 031
 */
async function emitPurchaseEvent(eventCode, purchaseId, tenantId, userId, extra = {}) {
  const rules = PURCHASE_EVENT_RULES[eventCode];
  if (!rules) throw new Error(`Código de evento RADIAN no soportado para Compras: ${eventCode}`);

  const purchase = await Purchase.findOne({
    where: { id: purchaseId, tenant_id: tenantId },
    include: [{ model: Supplier, as: 'supplier' }],
  });
  if (!purchase) throw new Error('Compra no encontrada');

  if (!purchase.cufe) {
    throw new Error('Esta compra no tiene CUFE — solo se pueden emitir eventos RADIAN sobre una factura electrónica importada con XML válido.');
  }
  if (!purchase.dian_issue_date) {
    throw new Error('Falta la fecha de emisión de la factura del proveedor.');
  }
  if (!rules.requiresStatus.includes(purchase.radian_status)) {
    throw new Error(`No se puede emitir el evento ${eventCode} — la compra debe estar en estado "${rules.requiresStatus.join('/')}" (estado actual: "${purchase.radian_status}").`);
  }
  if (rules.requiresDeadline) {
    if (!purchase.radian_deadline_at) {
      throw new Error('Falta el vencimiento del plazo de 3 días hábiles (debería haberse fijado al aceptar el 032) — no se puede validar el plazo.');
    }
    if (!isWithinBusinessDeadline(new Date(), purchase.radian_deadline_at)) {
      throw new Error(`El plazo de 3 días hábiles desde el recibo del bien/servicio (032) ya venció el ${new Date(purchase.radian_deadline_at).toLocaleDateString('es-CO')} — este evento ya no se puede emitir.`);
    }
  }
  if (eventCode === '031' && !extra.claimReasonText) {
    throw new Error('El motivo del reclamo es obligatorio.');
  }

  const supplier = purchase.supplier;
  if (!supplier?.tax_id) {
    throw new Error('El proveedor de esta compra no tiene NIT registrado.');
  }

  const result = await sendRadianEvent({
    eventCode, tenantId, userId,
    purchaseId: purchase.id,
    documentNumber: purchase.invoice_number,
    documentCufe: purchase.cufe,
    counterpartyNit: supplier.tax_id,
    counterpartyName: supplier.business_name || supplier.name,
    claimReasonCode: extra.claimReasonCode,
    claimReasonText: extra.claimReasonText,
  });

  if (result.accepted) {
    const purchaseUpdates = { radian_status: rules.setsStatus };
    // El 032 fija el plazo de 3 días hábiles para que el adquirente emita
    // 031 o 033 (ver §2 y §5.1 del plan) — se cuenta desde la fecha del
    // propio evento 032, no desde "ahora" si por algún motivo se
    // reintentara más tarde.
    if (eventCode === '032') {
      purchaseUpdates.radian_deadline_at = addBusinessDays(result.issuedAt, 3);
    }
    await purchase.update(purchaseUpdates);
  }

  return {
    ...result,
    radianStatus: result.accepted ? rules.setsStatus : purchase.radian_status,
    deadlineAt: eventCode === '032' && result.accepted ? purchase.radian_deadline_at : undefined,
  };
}

const emitAcuse030 = (purchaseId, tenantId, userId) => emitPurchaseEvent('030', purchaseId, tenantId, userId);
const emitRecibo032 = (purchaseId, tenantId, userId) => emitPurchaseEvent('032', purchaseId, tenantId, userId);
const emitAceptacion033 = (purchaseId, tenantId, userId) => emitPurchaseEvent('033', purchaseId, tenantId, userId);
const emitReclamo031 = (purchaseId, tenantId, userId, { claimReasonCode, claimReasonText }) =>
  emitPurchaseEvent('031', purchaseId, tenantId, userId, { claimReasonCode, claimReasonText });

// ─── Ventas (emisor): registrar eventos del cliente + 034 propio ─────────

const SALE_RECEIVED_STATUS = { '032': '032_received', '033': '033_received', '031': '031_received' };

/**
 * Registra que el CLIENTE nos envió un evento (032, 033 o 031) sobre
 * nuestra factura — no llama a la DIAN, solo deja constancia y (si es 032)
 * fija el plazo de 3 días hábiles para el 034.
 *
 * MANUAL a propósito: el Anexo no confirma un método de consulta (polling)
 * verificado para eventos de terceros sobre nuestras propias facturas —
 * "GetStatusEvent" aparece en el índice del Anexo FE 1.9 pero su contenido
 * no se pudo extraer (ver checklist §8 y radian-poll-events en §5.5 del
 * plan). En la práctica estos eventos suelen llegar por correo del
 * comprador (AttachedDocument con el Request/Response) — se registran a
 * mano hasta que se confirme y construya el polling real.
 *
 * @param {'032'|'033'|'031'} eventCode
 * @param {string} saleId
 * @param {string} tenantId
 * @param {string} userId
 * @param {{ note?: string }} [extra]
 */
async function recordSaleReceivedEvent(eventCode, saleId, tenantId, userId, extra = {}) {
  if (!SALE_RECEIVED_STATUS[eventCode]) {
    throw new Error(`Código de evento no válido para registrar como recibido: ${eventCode}`);
  }

  const sale = await Sale.findOne({
    where: { id: saleId, tenant_id: tenantId },
    include: [{ model: Customer, as: 'customer' }],
  });
  if (!sale) throw new Error('Venta no encontrada');
  if (!sale.cufe) throw new Error('Esta venta no tiene CUFE — no se puede registrar un evento sobre ella.');

  if (eventCode === '032' && sale.radian_status !== 'none') {
    throw new Error(`Ya hay un evento registrado sobre esta venta (estado actual: "${sale.radian_status}").`);
  }
  if (['033', '031'].includes(eventCode) && sale.radian_status !== '032_received') {
    throw new Error(`Solo se puede registrar ${eventCode} después de un 032 recibido (estado actual: "${sale.radian_status}").`);
  }

  const user = userId ? await User.findByPk(userId, { attributes: ['id', 'first_name', 'last_name', 'cedula'] }) : null;

  const eventRow = await RadianEvent.create({
    tenant_id: tenantId,
    direction: 'received',
    sale_id: sale.id,
    document_cufe: sale.cufe,
    document_number: sale.dian_invoice_number || null,
    counterparty_nit: sale.customer?.tax_id || null,
    event_code: eventCode,
    issued_at: new Date(),
    issuer_user_id: user?.id || null,
    request_xml: extra.note || null,
    dian_status: 'accepted',
    is_test: false,
    created_by: user?.id || null,
  });

  const updates = { radian_status: SALE_RECEIVED_STATUS[eventCode] };
  if (eventCode === '032') {
    updates.radian_deadline_at = addBusinessDays(eventRow.issued_at, 3);
  }
  await sale.update(updates);

  return { eventId: eventRow.id, radianStatus: sale.radian_status, deadlineAt: sale.radian_deadline_at };
}

/**
 * Emite el evento 034 (Aceptación tácita) sobre una venta a crédito: solo
 * cuando hubo un 032 recibido del cliente y venció el plazo de 3 días
 * hábiles sin que llegara 033 ni 031 (ver §2 y §5.7 del plan — siempre
 * requiere acción explícita del usuario, nunca se auto-emite).
 *
 * @param {'direct'|'mandatario'|'mandato_persona_natural'} [declarantType]
 *   Ver DECLARATION_NOTE_TEMPLATES en radianXmlBuilder.js — el texto de la
 *   declaración jurada sigue MARCADO COMO PENDIENTE DE VERIFICAR, no usar
 *   en producción sin revisión legal/contra el Anexo FE 1.9 §6.5.5.7.
 */
async function emitAceptacionTacita034(saleId, tenantId, userId, declarantType = 'direct') {
  const sale = await Sale.findOne({
    where: { id: saleId, tenant_id: tenantId },
    include: [{ model: Customer, as: 'customer' }],
  });
  if (!sale) throw new Error('Venta no encontrada');
  if (!sale.cufe) throw new Error('Esta venta no tiene CUFE.');
  if (sale.radian_status !== '032_received') {
    throw new Error(`No se puede emitir el 034 — se requiere un 032 recibido del cliente sin 033/031 posterior (estado actual: "${sale.radian_status}").`);
  }
  if (!sale.radian_deadline_at) {
    throw new Error('Falta el vencimiento del plazo de 3 días hábiles.');
  }
  if (isWithinBusinessDeadline(new Date(), sale.radian_deadline_at)) {
    throw new Error(`El plazo de 3 días hábiles aún no vence (${new Date(sale.radian_deadline_at).toLocaleDateString('es-CO')}) — el 034 no se puede emitir antes de que venza.`);
  }

  const customer = sale.customer;
  if (!customer?.tax_id) {
    throw new Error('El cliente de esta venta no tiene NIT/documento registrado.');
  }

  const result = await sendRadianEvent({
    eventCode: '034', tenantId, userId,
    saleId: sale.id,
    documentNumber: sale.dian_invoice_number,
    documentCufe: sale.cufe,
    counterpartyNit: customer.tax_id,
    counterpartyName: customer.business_name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    declarantType,
  });

  if (result.accepted) {
    await sale.update({ radian_status: '034' });
  }

  return { ...result, radianStatus: result.accepted ? '034' : sale.radian_status };
}

// ─── Fase 4: inscripción, endosos, limitación, mandato, pago ─────────────
// Todo esto lo emitimos como EMISOR/tenedor legítimo de nuestra propia
// factura (mismo `role: 'issuer'` que 034 — ver radianXmlBuilder.js). El
// 035 (Aval) no tiene función acá: lo emite el AVALISTA con su propio
// software, no algo que el emisor de la factura controle.

function customerDisplayName(customer) {
  return customer?.business_name || `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim();
}

async function loadInscribableSale(saleId, tenantId) {
  const sale = await Sale.findOne({
    where: { id: saleId, tenant_id: tenantId },
    include: [{ model: Customer, as: 'customer' }],
  });
  if (!sale) throw new Error('Venta no encontrada');
  if (!sale.cufe) throw new Error('Esta venta no tiene CUFE.');
  if (!sale.customer?.tax_id) throw new Error('El cliente de esta venta no tiene NIT/documento registrado.');
  return sale;
}

function assertInscribed(sale) {
  if (!sale.radian_circulation?.inscribed_at) {
    throw new Error('Esta factura no está inscrita en RADIAN como título valor — emita primero el 036 (Inscripción).');
  }
}

/**
 * Emite el 036 (Inscripción como título valor) — prerrequisito de
 * endosos/limitación/mandato/pago. Solo aplica a facturas a crédito ya
 * aceptadas (033 recibido o 034 emitido) — ver tabla §4 del plan.
 *
 * ⚠️ El propio Anexo RADIAN v1.0 tiene una contradicción interna sin
 * resolver sobre si el evento de inscripción es el 036 o el 030 (nota al
 * pie de la pág. 40 vs. la tabla de esa misma página — ver §4 del plan).
 * Se usa 036 porque es lo que dice la tabla y coincide con el resto de
 * fuentes consultadas para este plan, pero NO está confirmado contra la
 * v1.1 vigente — validar antes del primer envío real.
 */
async function emitInscripcion036(saleId, tenantId, userId) {
  const sale = await loadInscribableSale(saleId, tenantId);
  if (sale.radian_circulation?.inscribed_at) {
    throw new Error('Esta factura ya está inscrita en RADIAN.');
  }
  if (!['033_received', '034'].includes(sale.radian_status)) {
    throw new Error(`Solo se puede inscribir una factura ya aceptada (033 recibido o 034 emitido) — estado actual: "${sale.radian_status}".`);
  }
  if (!(sale.credit_days > 0)) {
    throw new Error('Solo las facturas a crédito se inscriben como título valor.');
  }

  const result = await sendRadianEvent({
    eventCode: '036', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: sale.customer.tax_id, counterpartyName: customerDisplayName(sale.customer),
  });

  if (result.accepted) {
    await sale.update({ radian_circulation: { ...sale.radian_circulation, inscribed_at: result.issuedAt } });
  }
  return { ...result, inscribedAt: result.accepted ? result.issuedAt : undefined };
}

const ENDORSEMENT_EVENT_CODES = { propiedad: '037', garantia: '038', procuracion: '039' };

/**
 * Emite un endoso (037 propiedad, 038 garantía o 039 procuración) — solo
 * sobre una factura ya inscrita, sin limitación de circulación activa, y
 * sin un endoso previo sin cancelar.
 */
async function emitEndoso(tipo, saleId, tenantId, userId, { holderNit, holderName, terms } = {}) {
  const eventCode = ENDORSEMENT_EVENT_CODES[tipo];
  if (!eventCode) throw new Error(`Tipo de endoso no válido: ${tipo} (use propiedad, garantia o procuracion)`);
  if (!holderNit || !holderName) throw new Error('Debe indicar el NIT y el nombre del endosatario (tenedor legítimo).');

  const sale = await loadInscribableSale(saleId, tenantId);
  assertInscribed(sale);
  if (sale.radian_circulation?.circulation_restricted) {
    throw new Error('Esta factura tiene una limitación de circulación activa — no se puede endosar.');
  }
  if (sale.radian_circulation?.holder_nit) {
    throw new Error(`Esta factura ya está endosada a ${sale.radian_circulation.holder_name} (NIT ${sale.radian_circulation.holder_nit}) — cancele el endoso (040) antes de endosarla de nuevo.`);
  }

  const result = await sendRadianEvent({
    eventCode, tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: holderNit, counterpartyName: holderName,
    extraNote: `Endoso en ${tipo} a favor de ${holderName} (NIT ${holderNit})${terms ? ' — ' + terms : ''}`,
    details: { tipo, holder_nit: holderNit, holder_name: holderName, terms: terms || null },
  });

  if (result.accepted) {
    await sale.update({ radian_circulation: { ...sale.radian_circulation, holder_nit: holderNit, holder_name: holderName } });
  }
  return result;
}

/** Emite el 040 (Cancelación del endoso) — devuelve la tenencia al emisor. */
async function emitCancelacionEndoso040(saleId, tenantId, userId, { reason } = {}) {
  const sale = await loadInscribableSale(saleId, tenantId);
  assertInscribed(sale);
  const holderNit = sale.radian_circulation?.holder_nit;
  if (!holderNit) throw new Error('Esta factura no tiene un endoso activo para cancelar.');
  const holderName = sale.radian_circulation?.holder_name;

  const result = await sendRadianEvent({
    eventCode: '040', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: holderNit, counterpartyName: holderName,
    extraNote: `Cancelación del endoso a favor de ${holderName} (NIT ${holderNit})${reason ? ' — ' + reason : ''}`,
    details: { reason: reason || null },
  });

  if (result.accepted) {
    const { holder_nit, holder_name, ...rest } = sale.radian_circulation;
    await sale.update({ radian_circulation: rest });
  }
  return result;
}

/**
 * Emite el 041 (Limitación de circulación) — bloquea endosos posteriores.
 *
 * ⚠️ CONFIRMADO contra el Anexo RADIAN v1.0, numeral 13.2.1 (pág. 357): el
 * Responsable de este evento es la "Autoridad judicial o administrativa",
 * NO el emisor/tenedor legítimo (a diferencia de 037-040/043-046, que sí
 * lo son). Es el equivalente a un embargo/medida cautelar sobre la
 * factura como título valor — un tenant normal de Pitbox (taller,
 * comercio) casi nunca es una autoridad judicial o administrativa. Por
 * eso el frontend NO expone botones para 041/042 (ver
 * SaleCirculationPanel.jsx) — esta función queda disponible solo por API
 * para el caso atípico de un tenant que sí lo sea.
 */
async function emitLimitacion041(saleId, tenantId, userId, { reason } = {}) {
  if (!reason) throw new Error('El motivo de la limitación es obligatorio.');

  const sale = await loadInscribableSale(saleId, tenantId);
  assertInscribed(sale);
  if (sale.radian_circulation?.circulation_restricted) {
    throw new Error('Ya existe una limitación de circulación activa sobre esta factura.');
  }

  const result = await sendRadianEvent({
    eventCode: '041', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: sale.customer.tax_id, counterpartyName: customerDisplayName(sale.customer),
    extraNote: `Limitación de circulación — ${reason}`,
    details: { reason },
  });

  if (result.accepted) {
    await sale.update({ radian_circulation: { ...sale.radian_circulation, circulation_restricted: true } });
  }
  return result;
}

/** Emite el 042 (Terminación de la limitación de circulación) — mismo Responsable que el 041, ver comentario ahí. */
async function emitTerminacionLimitacion042(saleId, tenantId, userId) {
  const sale = await loadInscribableSale(saleId, tenantId);
  assertInscribed(sale);
  if (!sale.radian_circulation?.circulation_restricted) {
    throw new Error('Esta factura no tiene una limitación de circulación activa.');
  }

  const result = await sendRadianEvent({
    eventCode: '042', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: sale.customer.tax_id, counterpartyName: customerDisplayName(sale.customer),
    extraNote: 'Terminación de la limitación de circulación',
  });

  if (result.accepted) {
    await sale.update({ radian_circulation: { ...sale.radian_circulation, circulation_restricted: false } });
  }
  return result;
}

/**
 * Emite el 043 (Mandato) — designa a alguien para actuar sobre esta factura.
 *
 * A diferencia de 037-042/045-046, el Mandato NO requiere que la factura
 * ya esté inscrita en RADIAN (036) — CONFIRMADO contra la Nota 1 del
 * Anexo RADIAN v1.0 §6.2.3 (pág. 40): "El primer evento que se debe
 * inscribir en el RADIAN debe ser el [036] – inscripción... a excepción
 * del evento 043 – Mandato." Es la única excepción explícita del Anexo.
 */
async function emitMandato043(saleId, tenantId, userId, { mandatarioNit, mandatarioName } = {}) {
  if (!mandatarioNit || !mandatarioName) throw new Error('Debe indicar el NIT y el nombre del mandatario.');

  const sale = await loadInscribableSale(saleId, tenantId);
  if (sale.radian_circulation?.mandate_nit) {
    throw new Error(`Ya hay un mandato activo a favor de ${sale.radian_circulation.mandate_name} — termínelo (044) antes de asignar uno nuevo.`);
  }

  const result = await sendRadianEvent({
    eventCode: '043', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: mandatarioNit, counterpartyName: mandatarioName,
    extraNote: `Mandato a favor de ${mandatarioName} (NIT ${mandatarioNit})`,
    details: { mandatario_nit: mandatarioNit, mandatario_name: mandatarioName },
  });

  if (result.accepted) {
    await sale.update({ radian_circulation: { ...sale.radian_circulation, mandate_nit: mandatarioNit, mandate_name: mandatarioName } });
  }
  return result;
}

/** Emite el 044 (Terminación del mandato) — misma excepción de inscripción que el 043, ver comentario ahí. */
async function emitTerminacionMandato044(saleId, tenantId, userId) {
  const sale = await loadInscribableSale(saleId, tenantId);
  const mandateNit = sale.radian_circulation?.mandate_nit;
  if (!mandateNit) throw new Error('Esta factura no tiene un mandato activo para terminar.');
  const mandateName = sale.radian_circulation?.mandate_name;

  const result = await sendRadianEvent({
    eventCode: '044', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: mandateNit, counterpartyName: mandateName,
    extraNote: `Terminación del mandato a favor de ${mandateName} (NIT ${mandateNit})`,
  });

  if (result.accepted) {
    const { mandate_nit, mandate_name, ...rest } = sale.radian_circulation;
    await sale.update({ radian_circulation: rest });
  }
  return result;
}

/**
 * Emite el 045 (Pago de la factura) — informativo ante la DIAN, NO
 * reemplaza el registro de pago propio de Pitbox (Sale.payment_history) —
 * ese sigue siendo la fuente de verdad interna, esto solo declara el pago
 * ante RADIAN para que conste en la trazabilidad del título valor.
 */
async function emitPago045(saleId, tenantId, userId, { amount, paymentDate, paymentMethod } = {}) {
  if (!amount || Number(amount) <= 0) throw new Error('El monto pagado es obligatorio.');

  const sale = await loadInscribableSale(saleId, tenantId);
  assertInscribed(sale);

  // Quien cobra es el tenedor legítimo si hay un endoso en propiedad
  // activo; si no, el emisor mismo — MEJOR ESFUERZO, el Anexo no detalla
  // este caso con el mismo nivel de precisión que el resto.
  const payeeNit = sale.radian_circulation?.holder_nit || null;
  const payDate = paymentDate || new Date().toISOString().slice(0, 10);

  const result = await sendRadianEvent({
    eventCode: '045', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: sale.customer.tax_id, counterpartyName: customerDisplayName(sale.customer),
    extraNote: `Pago de ${amount} el ${payDate}${paymentMethod ? ' vía ' + paymentMethod : ''}`,
    details: { amount, payment_date: payDate, payment_method: paymentMethod || null, payee_nit: payeeNit },
  });

  return result;
}

/** Emite el 046 (Informe para el pago) — reporte informativo, sin efecto en el estado de circulación. */
async function emitInformePago046(saleId, tenantId, userId, { note } = {}) {
  const sale = await loadInscribableSale(saleId, tenantId);
  assertInscribed(sale);

  const result = await sendRadianEvent({
    eventCode: '046', tenantId, userId, saleId: sale.id,
    documentNumber: sale.dian_invoice_number, documentCufe: sale.cufe,
    counterpartyNit: sale.customer.tax_id, counterpartyName: customerDisplayName(sale.customer),
    extraNote: note || 'Informe para el pago',
    details: { note: note || null },
  });

  return result;
}

module.exports = {
  emitPurchaseEvent, emitAcuse030, emitRecibo032, emitAceptacion033, emitReclamo031,
  recordSaleReceivedEvent, emitAceptacionTacita034,
  emitInscripcion036, emitEndoso, emitCancelacionEndoso040,
  emitLimitacion041, emitTerminacionLimitacion042,
  emitMandato043, emitTerminacionMandato044,
  emitPago045, emitInformePago046,
};
