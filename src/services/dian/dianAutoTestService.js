// backend/src/services/dian/dianAutoTestService.js
/**
 * Set completo de pruebas para habilitación DIAN — Software Propio
 * Migrado a dian-kit SDK
 */

const dianKit = require('./dianKitAdapter');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');

/* ── Mapeo document_type (Pitbox) → código DIAN / labels ───
   DIAN_EVENT_DOC_TYPE sigue la misma convención PascalCase que ya usa
   dianService.js al guardar DianEvent.document_type ('Invoice',
   'CreditNote', 'DebitNote') -- necesario para que getHabilitacionStatus
   pueda contar "documentos de prueba aceptados" por tipo de forma
   consistente con los envíos reales, no solo con los de auto-test. */
const DIAN_DOC_TYPE_CODE = { invoice: '01', support_document: '05' };
const DIAN_EVENT_DOC_TYPE = { invoice: 'Invoice', support_document: 'SupportDocument' };
const UI_TYPE_LABEL = { invoice: 'factura', support_document: 'documento_soporte' };

/* ── Comprador ficticio para pruebas de factura ─── */
const TEST_BUYER = {
  nit: '1036781830', schemeID: '31', dv: '9',
  name: 'EL ALTERNADOR',
  address: 'Calle 1 # 1-1', city: 'Bogota', cityCode: '11001',
  dept: 'Cundinamarca', email: 'prueba@test.com', phone: '3000000000',
  taxLevelCode: 'O-13', regimeCode: 'O-13',
};

/**
 * Dígito de verificación de un NIT colombiano (algoritmo módulo 11 oficial
 * DIAN). Necesario porque el DV de un NIT de prueba inventado a mano casi
 * nunca cuadra -- y la DIAN rechaza el documento por "DV no calculado
 * correctamente" (regla DSAB22b) antes de siquiera evaluar el resto.
 */
function computeNitCheckDigit(nit) {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digits = String(nit).split('').reverse();
  const sum = digits.reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  const mod = sum % 11;
  return mod < 2 ? mod : 11 - mod;
}

/* ── Vendedor ficticio para pruebas de Documento Soporte — va como
   AccountingSupplierParty. La DIAN rechaza (reglas DSAB23/DSAJ25a) si su
   tipo de identificación no es 31 (NIT), así que se usa NIT con DV real
   calculado, no cédula -- aunque en un caso real el vendedor no obligado a
   facturar suela identificarse con cédula, el set de pruebas de
   habilitación de la DIAN exige NIT. ─── */
const TEST_SELLER_NIT = '19487318';
const TEST_SELLER = {
  nit: TEST_SELLER_NIT, schemeID: '31', dv: String(computeNitCheckDigit(TEST_SELLER_NIT)),
  name: 'Proveedor De Prueba SAS',
  address: 'Calle 2 # 2-2', city: 'Bogota', cityCode: '11001',
  dept: 'Cundinamarca', email: 'vendedor-prueba@test.com', phone: '3000000001',
  taxLevelCode: 'R-99-PN', regimeCode: 'R-99-PN',
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

/* ── Ítems de prueba para Documento Soporte — compra a un tercero no
   obligado a facturar, sin IVA discriminado (caso más común). ─── */
const TEST_ITEMS_SUPPORT_DOCUMENT = [
  [{ id:'1', description:'Compra de materiales a proveedor no obligado a facturar', quantity:1, unit_price:80000, subtotal:80000, tax_amount:0, tax_rate:0, total:80000, unit_code:'EA' }],
  [{ id:'1', description:'Servicio prestado por persona natural no obligada a facturar', quantity:1, unit_price:120000, subtotal:120000, tax_amount:0, tax_rate:0, total:120000, unit_code:'ZZ' }],
];

/* ── Helper: enviar y registrar evento ─── */
async function sendAndLog({ signedXml, cufe, number, docType, cfg, tenant, DianEvent, testSetId }) {
  logger.info(`[DIAN AutoTest] → ${docType} ${number}`);

  const dianResponse = await dianKit.sendToDian(tenant, {
    signedXml,
    invoiceNumber: number,
    cufe,
    testSetId,
  });

  const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
  const pending = dianResponse.statusCode === 'PENDING' || dianResponse.statusCode === '2';
  const status = accepted ? 'accepted' : (pending ? 'sent' : (dianResponse.statusCode ? 'rejected' : 'error'));

  logger.info(`[DIAN AutoTest] ← ${docType} ${number} → ${status.toUpperCase()} | code=${dianResponse.statusCode}`);

  await DianEvent.create({
    tenant_id: tenant.id, sale_id: null,
    event_type: 'SendTestSetAsync', document_type: docType,
    invoice_number: number, cufe,
    response_raw: dianResponse.raw, status,
    error_message: accepted ? null : (dianResponse.statusMessage || dianResponse.statusDescription),
    is_test: true,
  }).catch(e => logger.error('[DIAN AutoTest] Error guardando DianEvent:', e.message));

  return { accepted: accepted || pending, dianResponse, status };
}

/* ─────────────────────────────────────────────────────────────
 * sendTestDocuments — envía facturas de prueba
 * ───────────────────────────────────────────────────────────── */
async function sendTestDocuments({ tenant, cfg, resolution: resolutionParam, count = 1, documentType = 'invoice' }) {
  const { DianEvent, DianResolution } = require('../../models');
  const results = [];
  const docCode = DIAN_DOC_TYPE_CODE[documentType] || '01';
  const eventDocType = DIAN_EVENT_DOC_TYPE[documentType] || 'Invoice';
  const uiLabel = UI_TYPE_LABEL[documentType] || 'factura';

  for (let i = 0; i < count; i++) {
    const transaction = await sequelize.transaction();
    let invoiceNumber = null;
    try {
      const resolution = await DianResolution.findOne({
        where: { id: resolutionParam.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!resolution?.is_active) throw new Error('La resolución de pruebas ya no está activa');

      const consecutive = Number(resolution.current_number);
      if (consecutive > Number(resolution.to_number)) throw new Error(`Rango agotado (hasta ${resolution.to_number})`);

      invoiceNumber = `${resolution.prefix}${consecutive}`;
      const isSupportDocument = documentType === 'support_document';
      const items = isSupportDocument
        ? TEST_ITEMS_SUPPORT_DOCUMENT[i % TEST_ITEMS_SUPPORT_DOCUMENT.length]
        : TEST_ITEMS_INVOICE[i % TEST_ITEMS_INVOICE.length];

      // Generar y firmar el XML ANTES de consumir el consecutivo: si esto
      // falla (ej. error de validación del SDK) el número no se pierde —
      // el rollback de la transacción revierte el increment de abajo.
      // Documento Soporte NO pasa por createInvoice: sus roles de
      // comprador/vendedor van invertidos respecto a una factura — ver
      // dianKitAdapter.js#createSupportDocument.
      const { signedXml, cufe } = isSupportDocument
        ? await dianKit.createSupportDocument(tenant, {
            documentNumber: invoiceNumber,
            items,
            resolution,
            seller: TEST_SELLER,
          })
        : await dianKit.createInvoice(tenant, {
            invoiceNumber,
            items,
            resolution,
            customer: TEST_BUYER,
            documentType: docCode,
          });

      await resolution.increment('current_number', { transaction });
      await transaction.commit();

      const { accepted, dianResponse, status } = await sendAndLog({
        signedXml, cufe, number: invoiceNumber, docType: eventDocType,
        cfg, tenant, DianEvent, testSetId: resolution.test_set_id,
      });

      results.push({
        index: i + 1, type: uiLabel, invoiceNumber, cufe, accepted, signed: true, status,
        statusCode: dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage: dianResponse.statusMessage,
        // Detalle específico de qué campo(s) mandatorio(s) fallaron — el
        // statusDescription suele ser un mensaje genérico ("Validación
        // contiene errores en campos mandatorios"); este array trae el
        // código y la descripción puntual de cada error reportado por DIAN.
        errors: dianResponse.errors || [],
        isFault: !accepted,
        rawPreview: dianResponse.raw?.substring(0, 1500) || null,
      });
    } catch (err) {
      if (!transaction.finished) await transaction.rollback();
      logger.error(`[DIAN AutoTest] Error ${uiLabel} ${i + 1}:`, err.message);
      results.push({ index: i + 1, type: uiLabel, invoiceNumber, accepted: false, signed: false, error: err.message, isFault: true });
    }
  }

  return results;
}

/* ─────────────────────────────────────────────────────────────
 * sendFullHabilitacionSet
 * ───────────────────────────────────────────────────────────── */
async function sendFullHabilitacionSet({ tenant, cfg, resolution: resolutionParam, documentType = 'invoice' }) {
  if (documentType !== 'invoice') {
    throw new Error('El "Set Completo de Habilitación" solo está implementado para Factura Electrónica. Use "Prueba rápida" para Documento Soporte.');
  }
  const { DianEvent, DianResolution } = require('../../models');

  const results  = [];
  const invoices = [];

  const kit = dianKit.getKit(tenant);

  /* ── FASE 1: 2 facturas (mínimo para habilitación) ── */
  logger.info('[DIAN AutoTest] ═══ FASE 1: 2 Facturas ═══');
  for (let i = 0; i < 2; i++) {
    const transaction = await sequelize.transaction();
    let invoiceNumber = null;
    try {
      const resolution = await DianResolution.findOne({
        where: { id: resolutionParam.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!resolution?.is_active) throw new Error('Resolución de pruebas inactiva');
      const consecutive = Number(resolution.current_number);
      if (consecutive > Number(resolution.to_number)) throw new Error(`Rango agotado (hasta ${resolution.to_number})`);

      invoiceNumber = `${resolution.prefix}${consecutive}`;
      const items = TEST_ITEMS_INVOICE[i];

      // Ver nota en sendTestDocuments: el consecutivo solo se consume si la
      // generación del XML tiene éxito.
      const { signedXml, cufe } = await dianKit.createInvoice(tenant, {
        invoiceNumber,
        items,
        resolution,
        customer: TEST_BUYER,
        documentType: DIAN_DOC_TYPE_CODE[documentType] || '01',
      });

      await resolution.increment('current_number', { transaction });
      await transaction.commit();

      const { accepted, dianResponse, status } = await sendAndLog({
        signedXml, cufe, number: invoiceNumber, docType: DIAN_EVENT_DOC_TYPE[documentType] || 'Invoice',
        cfg, tenant, DianEvent, testSetId: resolution.test_set_id,
      });

      invoices.push({ invoiceNumber, cufe, accepted });
      results.push({
        index: i + 1, type: 'factura', label: `Factura ${i + 1}`,
        invoiceNumber, cufe, accepted, signed: true, status,
        statusCode: dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage: dianResponse.statusMessage,
        // Detalle específico de qué campo(s) mandatorio(s) fallaron — el
        // statusDescription suele ser un mensaje genérico ("Validación
        // contiene errores en campos mandatorios"); este array trae el
        // código y la descripción puntual de cada error reportado por DIAN.
        errors: dianResponse.errors || [],
        isFault: !accepted,
        rawPreview: dianResponse.raw?.substring(0, 1500) || null,
      });
    } catch (err) {
      if (!transaction.finished) await transaction.rollback();
      logger.error(`[DIAN AutoTest] Error factura ${i + 1}:`, err.message);
      invoices.push({ invoiceNumber: null, cufe: null, accepted: false });
      results.push({ index: i + 1, type: 'factura', label: `Factura ${i + 1}`, invoiceNumber, accepted: false, error: err.message, isFault: true });
    }
  }

  const accepted = results.filter(r => r.accepted).length;
  logger.info(`[DIAN AutoTest] Set completo finalizado: ${accepted}/${results.length} aceptados`);
  return results;
}

module.exports = { sendTestDocuments, sendFullHabilitacionSet };
