// backend/src/services/dian/dianAutoTestService.js
/**
 * Set completo de pruebas para habilitación DIAN — Software Propio
 * Migrado a dian-kit SDK
 */

const dianKit = require('./dianKitAdapter');
const logger = require('../../config/logger');

/* ── Comprador ficticio para documentos de prueba DIAN ─── */
const TEST_BUYER = {
  nit: '1036781830', schemeID: '31', dv: '9',
  name: 'EL ALTERNADOR',
  address: 'Calle 1 # 1-1', city: 'Bogota', cityCode: '11001',
  dept: 'Cundinamarca', email: 'prueba@test.com', phone: '3000000000',
  taxLevelCode: 'O-13', regimeCode: 'O-13',
};

/* ── Variaciones de ítems para los 6 documentos ─── */
const TEST_ITEMS_INVOICE = [
  [{ id:'1', description:'Servicio de consultoria IVA 19%',        quantity:1, unit_price:150000, subtotal:150000, tax_amount:28500, tax_rate:19, total:178500, unit_code:'EA' }],
  [{ id:'1', description:'Servicio con IVA 19%',                   quantity:2, unit_price:80000,  subtotal:160000, tax_amount:30400, tax_rate:19, total:190400, unit_code:'ZZ' }],
  [{ id:'1', description:'Repuesto con IVA 19%',                   quantity:1, unit_price:200000, subtotal:200000, tax_amount:38000, tax_rate:19, total:238000, unit_code:'EA' },
   { id:'2', description:'Servicio tecnico IVA 19%',               quantity:1, unit_price:50000,  subtotal:50000,  tax_amount:9500,  tax_rate:19, total:59500,  unit_code:'ZZ' }],
  [{ id:'1', description:'Consultoria IVA 19%',                    quantity:3, unit_price:70000,  subtotal:210000, tax_amount:39900, tax_rate:19, total:249900, unit_code:'ZZ' }],
  [{ id:'1', description:'Equipo electronico IVA 19%',             quantity:1, unit_price:450000, subtotal:450000, tax_amount:85500, tax_rate:19, total:535500, unit_code:'EA' }],
  [{ id:'1', description:'Material de construccion IVA 19%',       quantity:5, unit_price:30000,  subtotal:150000, tax_amount:28500, tax_rate:19, total:178500, unit_code:'EA' }],
];

/* ── Helper: enviar y registrar evento ─── */
async function sendAndLog({ signedXml, cufe, number, docType, cfg, tenant, DianEvent }) {
  logger.info(`[DIAN AutoTest] → ${docType} ${number}`);

  const dianResponse = await dianKit.sendToDian(tenant, {
    signedXml,
    invoiceNumber: number,
    cufe,
  });

  const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
  const status = accepted ? 'accepted' : (dianResponse.statusCode ? 'rejected' : 'error');

  logger.info(`[DIAN AutoTest] ← ${docType} ${number} → ${status.toUpperCase()} | code=${dianResponse.statusCode}`);

  await DianEvent.create({
    tenant_id: tenant.id, sale_id: null,
    event_type: 'SendTestSetAsync', document_type: docType,
    invoice_number: number, cufe,
    response_raw: dianResponse.raw, status,
    error_message: accepted ? null : (dianResponse.statusMessage || dianResponse.statusDescription),
    is_test: true,
  }).catch(e => logger.error('[DIAN AutoTest] Error guardando DianEvent:', e.message));

  return { accepted, dianResponse, status };
}

/* ─────────────────────────────────────────────────────────────
 * sendTestDocuments — envía facturas de prueba
 * ───────────────────────────────────────────────────────────── */
async function sendTestDocuments({ tenant, cfg, resolution: resolutionParam, count = 1 }) {
  const { DianEvent, DianResolution } = require('../../models');
  const results = [];

  for (let i = 0; i < count; i++) {
    try {
      const resolution = await DianResolution.findByPk(resolutionParam.id);
      if (!resolution?.is_active) throw new Error('La resolución de pruebas ya no está activa');

      const consecutive = Number(resolution.current_number);
      if (consecutive > Number(resolution.to_number)) throw new Error(`Rango agotado (hasta ${resolution.to_number})`);

      const invoiceNumber = `${resolution.prefix}${consecutive}`;
      await resolution.increment('current_number');

      const items = TEST_ITEMS_INVOICE[i % TEST_ITEMS_INVOICE.length];

      // Usar dian-kit para crear y firmar
      const { signedXml, cufe } = await dianKit.createInvoice(tenant, {
        invoiceNumber,
        items,
        resolution,
        customer: TEST_BUYER,
      });

      const { accepted, dianResponse, status } = await sendAndLog({
        signedXml, cufe, number: invoiceNumber, docType: 'Invoice',
        cfg, tenant, DianEvent,
      });

      results.push({
        index: i + 1, type: 'factura', invoiceNumber, cufe, accepted, signed: true, status,
        statusCode: dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage: dianResponse.statusMessage,
        isFault: !accepted,
        rawPreview: dianResponse.raw?.substring(0, 1500) || null,
      });
    } catch (err) {
      logger.error(`[DIAN AutoTest] Error factura ${i + 1}:`, err.message);
      results.push({ index: i + 1, type: 'factura', invoiceNumber: null, accepted: false, signed: false, error: err.message, isFault: true });
    }
  }

  return results;
}

/* ─────────────────────────────────────────────────────────────
 * sendFullHabilitacionSet
 * ───────────────────────────────────────────────────────────── */
async function sendFullHabilitacionSet({ tenant, cfg, resolution: resolutionParam }) {
  const { DianEvent, DianResolution } = require('../../models');

  const results  = [];
  const invoices = [];

  const kit = dianKit.getKit(tenant);

  /* ── FASE 1: 2 facturas (mínimo para habilitación) ── */
  logger.info('[DIAN AutoTest] ═══ FASE 1: 2 Facturas ═══');
  for (let i = 0; i < 2; i++) {
    try {
      const resolution = await DianResolution.findByPk(resolutionParam.id);
      if (!resolution?.is_active) throw new Error('Resolución de pruebas inactiva');
      const consecutive = Number(resolution.current_number);
      if (consecutive > Number(resolution.to_number)) throw new Error(`Rango agotado (hasta ${resolution.to_number})`);

      const invoiceNumber = `${resolution.prefix}${consecutive}`;
      await resolution.increment('current_number');

      const items = TEST_ITEMS_INVOICE[i];

      const { signedXml, cufe } = await dianKit.createInvoice(tenant, {
        invoiceNumber,
        items,
        resolution,
        customer: TEST_BUYER,
      });

      const { accepted, dianResponse, status } = await sendAndLog({
        signedXml, cufe, number: invoiceNumber, docType: 'Invoice',
        cfg, tenant, DianEvent,
      });

      invoices.push({ invoiceNumber, cufe, accepted });
      results.push({
        index: i + 1, type: 'factura', label: `Factura ${i + 1}`,
        invoiceNumber, cufe, accepted, signed: true, status,
        statusCode: dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage: dianResponse.statusMessage,
        isFault: !accepted,
        rawPreview: dianResponse.raw?.substring(0, 1500) || null,
      });
    } catch (err) {
      logger.error(`[DIAN AutoTest] Error factura ${i + 1}:`, err.message);
      invoices.push({ invoiceNumber: null, cufe: null, accepted: false });
      results.push({ index: i + 1, type: 'factura', label: `Factura ${i + 1}`, invoiceNumber: null, accepted: false, error: err.message, isFault: true });
    }
  }

  const accepted = results.filter(r => r.accepted).length;
  logger.info(`[DIAN AutoTest] Set completo finalizado: ${accepted}/${results.length} aceptados`);
  return results;
}

module.exports = { sendTestDocuments, sendFullHabilitacionSet };
