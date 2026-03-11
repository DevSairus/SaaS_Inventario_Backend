// backend/src/services/dian/dianAutoTestService.js
const { buildInvoiceXml, getColombiaDateTime } = require('./dianXmlBuilder');
const dianApi = require('./dianApiService');
const dianSigner = require('./dianSignerService');
const logger = require('../../config/logger');

const TEST_BUYER = {
  nit: '13832081',
  schemeID: '13',
  name: 'COMPRADOR DE PRUEBA',
  address: 'Calle 1 # 1-1',
  city: 'Bogotá',
  cityCode: '11001',
  dept: 'Cundinamarca',
  email: 'prueba@test.com',
  phone: '3000000000',
  taxLevelCode: 'R-99-PN',
  regimeCode: '49',
};

// Dos variantes de factura: sin IVA y con IVA 19%
// Las notas crédito/débito NO se incluyen en el set de pruebas —
// se emiten manualmente cuando se tiene una factura aceptada como referencia.
const TEST_ITEMS_SET = [
  [{ id:'1', description:'Producto de prueba sin IVA', quantity:1, unit_price:100000, subtotal:100000, tax_amount:0, tax_rate:0, total:100000, unit_code:'EA' }],
  [{ id:'1', description:'Servicio de prueba con IVA 19%', quantity:1, unit_price:100000, subtotal:100000, tax_amount:19000, tax_rate:19, total:119000, unit_code:'EA' }],
];

async function sendTestDocuments({ tenant, cfg, resolution: resolutionParam, count = 1 }) {
  const { DianEvent, DianResolution } = require('../../models');
  const results = [];

  for (let i = 0; i < count; i++) {
    try {
      // Recargar resolución en cada iteración para obtener current_number actualizado
      const resolution = await DianResolution.findByPk(resolutionParam.id);
      if (!resolution || !resolution.is_active) throw new Error('La resolución de pruebas ya no está activa');

      const consecutive = Number(resolution.current_number);
      if (consecutive > Number(resolution.to_number)) throw new Error(`Rango agotado (hasta ${resolution.to_number})`);

      const invoiceNumber = `${resolution.prefix}${consecutive}`;
      logger.info(`[DIAN AutoTest] Doc ${i+1}/${count}: ${invoiceNumber} (current_number en BD: ${consecutive})`);

      // Reservar consecutivo ANTES de enviar
      await resolution.increment('current_number');

      const { date: issueDate, time: issueTime } = getColombiaDateTime();
      const items = TEST_ITEMS_SET[i % TEST_ITEMS_SET.length];
      const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
      const taxAmount = items.reduce((s, it) => s + it.tax_amount, 0);
      const totalAmount = subtotal + taxAmount;

      // Validar campos críticos
      const missing = [];
      if (!cfg.nit)              missing.push('NIT');
      if (!cfg.software_id)      missing.push('Software ID');
      if (!cfg.software_pin)     missing.push('PIN Software');
      if (!cfg.technical_key)    missing.push('Llave Técnica');
      if (!cfg.test_set_id)      missing.push('TestSetId');
      if (missing.length) throw new Error(`Configuración incompleta. Faltan: ${missing.join(', ')}`);

      const payload = {
        invoiceNumber, issueDate, issueTime,
        invoiceTypeCode: '01',
        items, subtotal, taxAmount, discountAmount: 0, totalAmount,
        paymentMeans: '1', paymentMeansCode: '10',
        // Emisor
        supplierNit:          cfg.nit,
        supplierDv:           cfg.dv || '0',
        supplierName:         cfg.company_name || tenant.company_name,
        supplierTradeName:    cfg.trade_name || cfg.company_name || tenant.company_name,
        supplierAddress:      cfg.address || tenant.address || 'Calle 1 # 1-1',
        supplierCity:         cfg.city || 'Bogotá',
        supplierCityCode:     cfg.city_code || '11001',
        supplierDept:         cfg.dept || 'Cundinamarca',
        supplierPhone:        cfg.phone || tenant.phone || '3000000000',
        supplierEmail:        cfg.email || tenant.email || 'facturacion@empresa.com',
        supplierRegimeCode:   cfg.regime_code || '48',
        supplierTaxLevelCode: cfg.tax_level_code || 'R-99-PN',
        supplierSchemeID:     '31',
        // Comprador ficticio
        buyerNit: TEST_BUYER.nit, buyerName: TEST_BUYER.name,
        buyerAddress: TEST_BUYER.address, buyerCity: TEST_BUYER.city,
        buyerCityCode: TEST_BUYER.cityCode, buyerDept: TEST_BUYER.dept,
        buyerPhone: TEST_BUYER.phone, buyerEmail: TEST_BUYER.email,
        buyerSchemeID: TEST_BUYER.schemeID,
        buyerTaxLevelCode: TEST_BUYER.taxLevelCode,
        buyerRegimeCode: TEST_BUYER.regimeCode,
        // Software / Resolución
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
        environment:         'test',
        customizationID:     cfg.customization_id || '10',
      };

      const { xml: unsignedXml, cufe } = buildInvoiceXml(payload);

      // Firmar si hay certificado
      let signedXml = unsignedXml;
      let signed = false;
      const hasCert = cfg.certificate_p12_base64 &&
                      cfg.certificate_p12_base64 !== '[CONFIGURADO]' &&
                      cfg.certificate_password;
      if (hasCert) {
        try {
          signedXml = await dianSigner.signXml(unsignedXml, {
            p12Base64: cfg.certificate_p12_base64,
            password: cfg.certificate_password,
            invoiceNumber,
          });
          signed = true;
          logger.info(`[DIAN AutoTest] Firmado: ${invoiceNumber}`);
        } catch (signErr) {
          logger.warn(`[DIAN AutoTest] Firma falló: ${signErr.message} — enviando sin firma`);
        }
      } else {
        logger.warn('[DIAN AutoTest] Sin certificado — XML sin firma');
      }

      logger.info(`[DIAN AutoTest] Enviando ${invoiceNumber} | testSetId=${cfg.test_set_id} | nit=${cfg.nit} | softwareId=${cfg.software_id}`);

      const dianResponse = await dianApi.sendTestSetAsync({
        xmlContent: signedXml,
        nit: cfg.nit,
        invoiceNumber,
        testSetId: cfg.test_set_id,
        environment: 'test',
        p12Base64: cfg.certificate_p12_base64,
        password:  cfg.certificate_password,
      });

      const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
      const status = accepted ? 'accepted' : (dianResponse.isFault ? 'error' : 'rejected');

      logger.info(`[DIAN AutoTest] ${invoiceNumber} → ${status.toUpperCase()} code=${dianResponse.statusCode} desc=${dianResponse.statusDescription}`);
      if (dianResponse.raw) logger.debug(`[DIAN AutoTest] Raw: ${dianResponse.raw.substring(0, 600)}`);

      await DianEvent.create({
        tenant_id: tenant.id, sale_id: null,
        event_type: 'SendTestSetAsync', document_type: 'Invoice',
        invoice_number: invoiceNumber, cufe,
        response_raw: dianResponse.raw,
        status,
        error_message: accepted ? null : (dianResponse.statusMessage || dianResponse.statusDescription),
        is_test: true,
      });

      results.push({
        index: i + 1, invoiceNumber, cufe, accepted, signed,
        statusCode:        dianResponse.statusCode,
        statusDescription: dianResponse.statusDescription,
        statusMessage:     dianResponse.statusMessage,
        isFault:           dianResponse.isFault || false,
        rawPreview:        dianResponse.raw ? dianResponse.raw.substring(0, 1500) : null,
      });

    } catch (err) {
      logger.error(`[DIAN AutoTest] Error doc ${i+1}:`, err.message);
      results.push({ index: i+1, invoiceNumber: null, accepted: false, signed: false, error: err.message, isFault: true });
    }
  }

  return results;
}

module.exports = { sendTestDocuments };