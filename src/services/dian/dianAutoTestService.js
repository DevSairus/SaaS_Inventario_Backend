// backend/src/services/dian/dianAutoTestService.js
/**
 * Set completo de pruebas para habilitación DIAN — Software Propio
 *
 * Según documentación oficial DIAN:
 *   - 6 Facturas de venta
 *   - 2 Notas Crédito (referenciando facturas 1 y 2)
 *   - 2 Notas Débito  (referenciando facturas 3 y 4)
 *   Total: 10 documentos
 */

const { buildInvoiceXml, buildCreditNoteXml, buildDebitNoteXml, getColombiaDateTime } = require('./dianXmlBuilder');
const dianApi     = require('./dianApiService');
const dianSigner  = require('./dianSignerService');
const logger      = require('../../config/logger');

/* ── Comprador ficticio para documentos de prueba ─── */
const TEST_BUYER = {
  nit: '13832081', schemeID: '13',
  name: 'COMPRADOR DE PRUEBA',
  address: 'Calle 1 # 1-1', city: 'Bogotá', cityCode: '11001',
  dept: 'Cundinamarca', email: 'prueba@test.com', phone: '3000000000',
  taxLevelCode: 'R-99-PN', regimeCode: '49',
};

/* ── Variaciones de ítems para los 6 documentos ─── */
const TEST_ITEMS_INVOICE = [
  [{ id:'1', description:'Producto sin IVA',              quantity:1, unit_price:150000, subtotal:150000, tax_amount:0,     tax_rate:0,  total:150000, unit_code:'EA' }],
  [{ id:'1', description:'Servicio con IVA 19%',          quantity:2, unit_price:80000,  subtotal:160000, tax_amount:30400, tax_rate:19, total:190400, unit_code:'ZZ' }],
  [{ id:'1', description:'Repuesto con IVA 19%',          quantity:1, unit_price:200000, subtotal:200000, tax_amount:38000, tax_rate:19, total:238000, unit_code:'EA' },
   { id:'2', description:'Mano de obra sin IVA',          quantity:1, unit_price:50000,  subtotal:50000,  tax_amount:0,     tax_rate:0,  total:50000,  unit_code:'ZZ' }],
  [{ id:'1', description:'Consultoría sin IVA',           quantity:3, unit_price:70000,  subtotal:210000, tax_amount:0,     tax_rate:0,  total:210000, unit_code:'ZZ' }],
  [{ id:'1', description:'Equipo electrónico IVA 19%',    quantity:1, unit_price:450000, subtotal:450000, tax_amount:85500, tax_rate:19, total:535500, unit_code:'EA' }],
  [{ id:'1', description:'Material de construcción 0%',   quantity:5, unit_price:30000,  subtotal:150000, tax_amount:0,     tax_rate:0,  total:150000, unit_code:'EA' }],
];

/* ── Helper: firmar XML si hay certificado ─── */
async function signIfCert(xml, noteNumber, cfg) {
  const hasCert = cfg.certificate_p12_base64 &&
                  cfg.certificate_p12_base64 !== '[CONFIGURADO]' &&
                  cfg.certificate_password;
  if (!hasCert) {
    logger.warn(`[DIAN AutoTest] Sin certificado — ${noteNumber} sin firma`);
    return { xml, signed: false };
  }
  try {
    const signed = await dianSigner.signXml(xml, {
      p12Base64: cfg.certificate_p12_base64,
      password:  cfg.certificate_password,
      invoiceNumber: noteNumber,
    });
    return { xml: signed, signed: true };
  } catch (e) {
    logger.warn(`[DIAN AutoTest] Firma falló (${noteNumber}): ${e.message} — enviando sin firma`);
    return { xml, signed: false };
  }
}

/* ── Helper: enviar al TestSet y registrar evento ─── */
async function sendAndLog({ xmlContent, number, docType, cufe, cfg, tenant, DianEvent }) {
  logger.info(`[DIAN AutoTest] → ${docType} ${number} | testSetId=${cfg.test_set_id?.substring(0,8)}...`);

  const dianResponse = await dianApi.sendTestSetAsync({
    xmlContent, nit: cfg.nit, invoiceNumber: number,
    testSetId: cfg.test_set_id, environment: 'test',
    p12Base64: cfg.certificate_p12_base64, password: cfg.certificate_password,
  });

  const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
  const status   = accepted ? 'accepted' : (dianResponse.isFault ? 'error' : 'rejected');

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
 * sendTestDocuments — compatibilidad hacia atrás (solo facturas)
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

      const { date: issueDate, time: issueTime } = getColombiaDateTime();
      const items = TEST_ITEMS_INVOICE[i % TEST_ITEMS_INVOICE.length];
      const subtotal    = items.reduce((s, it) => s + it.subtotal, 0);
      const taxAmount   = items.reduce((s, it) => s + it.tax_amount, 0);
      const totalAmount = subtotal + taxAmount;

      _validateCfg(cfg);
      const payload = _buildInvoicePayload({ invoiceNumber, issueDate, issueTime, items, subtotal, taxAmount, totalAmount, cfg, tenant, resolution });
      const { xml: unsignedXml, cufe } = buildInvoiceXml(payload);
      const { xml: signedXml, signed } = await signIfCert(unsignedXml, invoiceNumber, cfg);

      const { accepted, dianResponse, status } = await sendAndLog({
        xmlContent: signedXml, number: invoiceNumber, docType: 'Invoice', cufe, cfg, tenant, DianEvent,
      });

      results.push({
        index: i + 1, type: 'factura', invoiceNumber, cufe, accepted, signed, status,
        statusCode:        dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage:     dianResponse.statusMessage,
        isFault:           dianResponse.isFault || false,
        rawPreview:        dianResponse.raw?.substring(0, 1500) || null,
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
 * Envía el set completo requerido por la DIAN para habilitación
 * como Software Propio: 6 facturas + 2 NC + 2 ND = 10 documentos
 * ───────────────────────────────────────────────────────────── */
async function sendFullHabilitacionSet({ tenant, cfg, resolution: resolutionParam }) {
  const { DianEvent, DianResolution } = require('../../models');
  _validateCfg(cfg, true);

  const results  = [];
  const invoices = []; // { invoiceNumber, cufe, issueDate } — referencia para NC/ND

  /* ── FASE 1: 6 facturas ── */
  logger.info('[DIAN AutoTest] ═══ FASE 1: 6 Facturas ═══');
  for (let i = 0; i < 6; i++) {
    try {
      const resolution = await DianResolution.findByPk(resolutionParam.id);
      if (!resolution?.is_active) throw new Error('Resolución de pruebas inactiva');
      const consecutive = Number(resolution.current_number);
      if (consecutive > Number(resolution.to_number)) throw new Error(`Rango agotado (hasta ${resolution.to_number})`);

      const invoiceNumber = `${resolution.prefix}${consecutive}`;
      await resolution.increment('current_number');

      const { date: issueDate, time: issueTime } = getColombiaDateTime();
      const items       = TEST_ITEMS_INVOICE[i];
      const subtotal    = items.reduce((s, it) => s + it.subtotal, 0);
      const taxAmount   = items.reduce((s, it) => s + it.tax_amount, 0);
      const totalAmount = subtotal + taxAmount;

      const payload = _buildInvoicePayload({ invoiceNumber, issueDate, issueTime, items, subtotal, taxAmount, totalAmount, cfg, tenant, resolution });
      const { xml: unsignedXml, cufe } = buildInvoiceXml(payload);
      const { xml: signedXml, signed } = await signIfCert(unsignedXml, invoiceNumber, cfg);

      const { accepted, dianResponse, status } = await sendAndLog({
        xmlContent: signedXml, number: invoiceNumber, docType: 'Invoice', cufe, cfg, tenant, DianEvent,
      });

      invoices.push({ invoiceNumber, cufe, issueDate, accepted });
      results.push({
        index: i + 1, type: 'factura', label: `Factura ${i + 1}`,
        invoiceNumber, cufe, accepted, signed, status,
        statusCode:        dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage:     dianResponse.statusMessage,
        isFault:           dianResponse.isFault || false,
        rawPreview:        dianResponse.raw?.substring(0, 1500) || null,
      });
    } catch (err) {
      logger.error(`[DIAN AutoTest] Error factura ${i + 1}:`, err.message);
      invoices.push({ invoiceNumber: null, cufe: null, issueDate: null, accepted: false });
      results.push({ index: i + 1, type: 'factura', label: `Factura ${i + 1}`, invoiceNumber: null, accepted: false, error: err.message, isFault: true });
    }
  }

  const resolution = await DianResolution.findByPk(resolutionParam.id);

  /* ── FASE 2: 2 Notas Crédito (ref. facturas 1 y 2) ── */
  logger.info('[DIAN AutoTest] ═══ FASE 2: 2 Notas Crédito ═══');
  const NC_DESCS = [
    { code: '1', desc: 'Devolución parcial de los bienes y/o servicios' },
    { code: '3', desc: 'Rebaja o descuento parcial del precio' },
  ];
  for (let i = 0; i < 2; i++) {
    try {
      const refInv = invoices[i];
      const noteNumber = `NC${resolution.prefix}TS${String(i + 1).padStart(4, '0')}`;
      const { date: issueDate, time: issueTime } = getColombiaDateTime();

      const items     = [{ id:'1', description:`Devolución — ${NC_DESCS[i].desc}`, quantity:1, unit_price:50000, subtotal:50000, tax_amount:0, tax_rate:0, unit_code:'EA' }];
      const subtotal    = 50000;
      const taxAmount   = 0;
      const totalAmount = 50000;

      const payload = {
        noteNumber, issueDate, issueTime,
        items, subtotal, taxAmount, discountAmount: 0, totalAmount,
        paymentMeans: '1', paymentMeansCode: '10',
        supplierNit:          cfg.nit, supplierDv: cfg.dv || '0',
        supplierName:         cfg.company_name || tenant.company_name,
        supplierTradeName:    cfg.trade_name   || cfg.company_name || tenant.company_name,
        supplierAddress:      cfg.address      || tenant.address   || 'Calle 1 # 1-1',
        supplierCity:         cfg.city         || 'Bogotá',
        supplierCityCode:     cfg.city_code    || '11001',
        supplierDept:         cfg.dept         || 'Cundinamarca',
        supplierPhone:        cfg.phone        || tenant.phone || '3000000000',
        supplierEmail:        cfg.email        || tenant.email || 'facturacion@empresa.com',
        supplierRegimeCode:   cfg.regime_code  || '48',
        supplierTaxLevelCode: cfg.tax_level_code || 'R-99-PN',
        supplierSchemeID: '31',
        buyerNit: TEST_BUYER.nit, buyerName: TEST_BUYER.name,
        buyerAddress: TEST_BUYER.address, buyerCity: TEST_BUYER.city,
        buyerCityCode: TEST_BUYER.cityCode, buyerDept: TEST_BUYER.dept,
        buyerPhone: TEST_BUYER.phone, buyerEmail: TEST_BUYER.email,
        buyerSchemeID: TEST_BUYER.schemeID,
        buyerTaxLevelCode: TEST_BUYER.taxLevelCode,
        buyerRegimeCode: TEST_BUYER.regimeCode,
        softwareId:          cfg.software_id,
        softwareProviderId:  cfg.software_provider_nit || cfg.nit,
        softwarePin:         cfg.software_pin,
        technicalKey:        cfg.technical_key,
        resolutionNumber:    resolution.resolution_number,
        resolutionStartDate: resolution.valid_from,
        resolutionEndDate:   resolution.valid_to,
        resolutionPrefix:    resolution.prefix,
        resolutionFrom:      Number(resolution.from_number),
        resolutionTo:        Number(resolution.to_number),
        environment: 'test', customizationID: '22',
        correctedInvoiceNumber: refInv?.invoiceNumber || `${resolution.prefix}990000001`,
        correctedInvoiceCufe:   refInv?.cufe          || '0'.repeat(96),
        correctedInvoiceDate:   refInv?.issueDate      || issueDate,
        discrepancyCode: NC_DESCS[i].code,
        discrepancyDesc: NC_DESCS[i].desc,
      };

      const { xml: unsignedXml, cude } = buildCreditNoteXml(payload);
      const { xml: signedXml, signed } = await signIfCert(unsignedXml, noteNumber, cfg);

      const { accepted, dianResponse, status } = await sendAndLog({
        xmlContent: signedXml, number: noteNumber, docType: 'CreditNote', cufe: cude, cfg, tenant, DianEvent,
      });

      results.push({
        index: 6 + i + 1, type: 'nota_credito', label: `Nota Crédito ${i + 1}`,
        invoiceNumber: noteNumber, cufe: cude, accepted, signed, status,
        refInvoice: refInv?.invoiceNumber || '—',
        statusCode:        dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage:     dianResponse.statusMessage,
        isFault:           dianResponse.isFault || false,
        rawPreview:        dianResponse.raw?.substring(0, 1500) || null,
      });
    } catch (err) {
      logger.error(`[DIAN AutoTest] Error NC ${i + 1}:`, err.message);
      results.push({ index: 6 + i + 1, type: 'nota_credito', label: `Nota Crédito ${i + 1}`, invoiceNumber: null, accepted: false, error: err.message, isFault: true });
    }
  }

  /* ── FASE 3: 2 Notas Débito (ref. facturas 3 y 4) ── */
  logger.info('[DIAN AutoTest] ═══ FASE 3: 2 Notas Débito ═══');
  const ND_DESCS = [
    { code: '1', desc: 'Intereses' },
    { code: '2', desc: 'Gastos por cobrar' },
  ];
  for (let i = 0; i < 2; i++) {
    try {
      const refInv = invoices[i + 2];
      const noteNumber = `ND${resolution.prefix}TS${String(i + 1).padStart(4, '0')}`;
      const { date: issueDate, time: issueTime } = getColombiaDateTime();

      const items     = [{ id:'1', description:`Cargo adicional — ${ND_DESCS[i].desc}`, quantity:1, unit_price:25000, subtotal:25000, tax_amount:0, tax_rate:0, unit_code:'ZZ' }];
      const subtotal    = 25000;
      const taxAmount   = 0;
      const totalAmount = 25000;

      const payload = {
        noteNumber, issueDate, issueTime,
        items, subtotal, taxAmount, discountAmount: 0, totalAmount,
        paymentMeans: '1', paymentMeansCode: '10',
        supplierNit:          cfg.nit, supplierDv: cfg.dv || '0',
        supplierName:         cfg.company_name || tenant.company_name,
        supplierTradeName:    cfg.trade_name   || cfg.company_name || tenant.company_name,
        supplierAddress:      cfg.address      || tenant.address   || 'Calle 1 # 1-1',
        supplierCity:         cfg.city         || 'Bogotá',
        supplierCityCode:     cfg.city_code    || '11001',
        supplierDept:         cfg.dept         || 'Cundinamarca',
        supplierPhone:        cfg.phone        || tenant.phone || '3000000000',
        supplierEmail:        cfg.email        || tenant.email || 'facturacion@empresa.com',
        supplierRegimeCode:   cfg.regime_code  || '48',
        supplierTaxLevelCode: cfg.tax_level_code || 'R-99-PN',
        supplierSchemeID: '31',
        buyerNit: TEST_BUYER.nit, buyerName: TEST_BUYER.name,
        buyerAddress: TEST_BUYER.address, buyerCity: TEST_BUYER.city,
        buyerCityCode: TEST_BUYER.cityCode, buyerDept: TEST_BUYER.dept,
        buyerPhone: TEST_BUYER.phone, buyerEmail: TEST_BUYER.email,
        buyerSchemeID: TEST_BUYER.schemeID,
        buyerTaxLevelCode: TEST_BUYER.taxLevelCode,
        buyerRegimeCode: TEST_BUYER.regimeCode,
        softwareId:          cfg.software_id,
        softwareProviderId:  cfg.software_provider_nit || cfg.nit,
        softwarePin:         cfg.software_pin,
        technicalKey:        cfg.technical_key,
        resolutionNumber:    resolution.resolution_number,
        resolutionStartDate: resolution.valid_from,
        resolutionEndDate:   resolution.valid_to,
        resolutionPrefix:    resolution.prefix,
        resolutionFrom:      Number(resolution.from_number),
        resolutionTo:        Number(resolution.to_number),
        environment: 'test', customizationID: '22',
        correctedInvoiceNumber: refInv?.invoiceNumber || `${resolution.prefix}990000003`,
        correctedInvoiceCufe:   refInv?.cufe          || '0'.repeat(96),
        correctedInvoiceDate:   refInv?.issueDate      || issueDate,
        discrepancyCode: ND_DESCS[i].code,
        discrepancyDesc: ND_DESCS[i].desc,
      };

      const { xml: unsignedXml, cude } = buildDebitNoteXml(payload);
      const { xml: signedXml, signed } = await signIfCert(unsignedXml, noteNumber, cfg);

      const { accepted, dianResponse, status } = await sendAndLog({
        xmlContent: signedXml, number: noteNumber, docType: 'DebitNote', cufe: cude, cfg, tenant, DianEvent,
      });

      results.push({
        index: 8 + i + 1, type: 'nota_debito', label: `Nota Débito ${i + 1}`,
        invoiceNumber: noteNumber, cufe: cude, accepted, signed, status,
        refInvoice: refInv?.invoiceNumber || '—',
        statusCode:        dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage:     dianResponse.statusMessage,
        isFault:           dianResponse.isFault || false,
        rawPreview:        dianResponse.raw?.substring(0, 1500) || null,
      });
    } catch (err) {
      logger.error(`[DIAN AutoTest] Error ND ${i + 1}:`, err.message);
      results.push({ index: 8 + i + 1, type: 'nota_debito', label: `Nota Débito ${i + 1}`, invoiceNumber: null, accepted: false, error: err.message, isFault: true });
    }
  }

  const accepted = results.filter(r => r.accepted).length;
  logger.info(`[DIAN AutoTest] Set completo finalizado: ${accepted}/${results.length} aceptados`);
  return results;
}

/* ── helpers privados ─────────────────────────────────────── */
function _validateCfg(cfg, full = false) {
  const missing = [];
  if (!cfg.nit)           missing.push('NIT');
  if (!cfg.software_id)   missing.push('Software ID');
  if (!cfg.software_pin)  missing.push('PIN Software');
  if (!cfg.technical_key) missing.push('Llave Técnica');
  if (!cfg.test_set_id)   missing.push('TestSetId');
  if (full) {
    if (!cfg.certificate_p12_base64 || cfg.certificate_p12_base64 === '[CONFIGURADO]') missing.push('Certificado P12');
    if (!cfg.certificate_password)  missing.push('Contraseña del certificado');
  }
  if (missing.length) throw new Error(`Configuración incompleta. Faltan: ${missing.join(', ')}`);
}

function _buildInvoicePayload({ invoiceNumber, issueDate, issueTime, items, subtotal, taxAmount, totalAmount, cfg, tenant, resolution }) {
  return {
    invoiceNumber, issueDate, issueTime, invoiceTypeCode: '01',
    items, subtotal, taxAmount, discountAmount: 0, totalAmount,
    paymentMeans: '1', paymentMeansCode: '10',
    supplierNit:          cfg.nit,
    supplierDv:           cfg.dv || '0',
    supplierName:         cfg.company_name || tenant.company_name,
    supplierTradeName:    cfg.trade_name   || cfg.company_name || tenant.company_name,
    supplierAddress:      cfg.address      || tenant.address   || 'Calle 1 # 1-1',
    supplierCity:         cfg.city         || 'Bogotá',
    supplierCityCode:     cfg.city_code    || '11001',
    supplierDept:         cfg.dept         || 'Cundinamarca',
    supplierPhone:        cfg.phone        || tenant.phone || '3000000000',
    supplierEmail:        cfg.email        || tenant.email || 'facturacion@empresa.com',
    supplierRegimeCode:   cfg.regime_code  || '48',
    supplierTaxLevelCode: cfg.tax_level_code || 'R-99-PN',
    supplierSchemeID: '31',
    buyerNit: TEST_BUYER.nit, buyerName: TEST_BUYER.name,
    buyerAddress: TEST_BUYER.address, buyerCity: TEST_BUYER.city,
    buyerCityCode: TEST_BUYER.cityCode, buyerDept: TEST_BUYER.dept,
    buyerPhone: TEST_BUYER.phone, buyerEmail: TEST_BUYER.email,
    buyerSchemeID: TEST_BUYER.schemeID,
    buyerTaxLevelCode: TEST_BUYER.taxLevelCode,
    buyerRegimeCode: TEST_BUYER.regimeCode,
    softwareId:          cfg.software_id,
    softwareProviderId:  cfg.software_provider_nit || cfg.nit,
    softwarePin:         cfg.software_pin,
    technicalKey:        cfg.technical_key,
    resolutionNumber:    resolution.resolution_number,
    resolutionStartDate: resolution.valid_from,
    resolutionEndDate:   resolution.valid_to,
    resolutionPrefix:    resolution.prefix,
    resolutionFrom:      Number(resolution.from_number),
    resolutionTo:        Number(resolution.to_number),
    environment: 'test',
    customizationID: cfg.customization_id || '10',
  };
}

module.exports = { sendTestDocuments, sendFullHabilitacionSet };
