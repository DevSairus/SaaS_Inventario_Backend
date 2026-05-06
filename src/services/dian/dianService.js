// backend/src/services/dian/dianService.js
/**
 * Servicio principal DIAN
 * Orquesta: construcción XML → firma XAdES → envío → persistencia
 */

const { buildInvoiceXml, getColombiaDateTime } = require('./dianXmlBuilder');
const dianApi = require('./dianApiService');
const dianSigner = require('./dianSignerService');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');

/* ──────────────────────────────────────────────────────────
 * Extrae configuración DIAN del tenant y valida campos
 * ────────────────────────────────────────────────────────── */
function extractDianConfig(tenant) {
  const cfg = tenant.dian_config || {};
  const required = [
    'nit', 'dv', 'company_name',
    'software_id', 'software_pin', 'software_provider_nit',
    'technical_key',
  ];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length) {
    throw new Error(`Configuración DIAN incompleta para tenant ${tenant.id}. Faltan: ${missing.join(', ')}`);
  }
  return cfg;
}

/* ──────────────────────────────────────────────────────────
 * Obtiene o incrementa el consecutivo de la resolución
 * ────────────────────────────────────────────────────────── */
async function getNextConsecutive(tenantId, isTest = false, transaction) {
  const { DianResolution } = require('../../models');

  const resolution = await DianResolution.findOne({
    where: { tenant_id: tenantId, is_active: true, is_test: isTest, document_type: 'invoice' },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });

  if (!resolution) {
    throw new Error(`No existe resolución DIAN ${isTest ? 'de pruebas ' : ''}activa para este tenant.`);
  }

  if (resolution.current_number > resolution.to_number) {
    throw new Error(`Se agotó el rango de numeración DIAN (hasta ${resolution.to_number}).`);
  }

  const today = new Date().toISOString().split('T')[0];
  if (today > resolution.valid_to) {
    throw new Error(`La resolución DIAN venció el ${resolution.valid_to}.`);
  }

  const consecutive = resolution.current_number;
  await resolution.increment('current_number', { transaction });

  return {
    consecutive,
    invoiceNumber: `${resolution.prefix}${consecutive}`,
    resolution,
  };
}

/* ──────────────────────────────────────────────────────────
 * Construye payload del XML a partir de una venta
 * ────────────────────────────────────────────────────────── */
function buildXmlPayload(sale, items, tenant, dianCfg, resolution, issueDate, issueTime, invoiceNumber) {
  // Método de pago
  const paymentMeansMap = {
    efectivo: { id: '1', code: '10' },
    transferencia: { id: '2', code: '42' },
    tarjeta_credito: { id: '2', code: '48' },
    tarjeta_debito: { id: '2', code: '47' },
    cheque: { id: '2', code: '20' },
    credito: { id: '2', code: '20' },
  };
  const pm = paymentMeansMap[(sale.payment_method || '').toLowerCase()] || { id: '1', code: '10' };

  // Determinar schemeID del comprador (31=NIT/Empresa, 13=CC, 22=Pasaporte, 12=Tarjeta extranjería)
  const buyerNit = sale.customer_tax_id || '';
  const buyerSchemeID = dianCfg.buyer_default_scheme_id || '13';

  return {
    invoiceNumber,
    issueDate,
    issueTime,
    invoiceTypeCode: '01',
    items,
    subtotal:        Number(sale.subtotal || 0),
    taxAmount:       Number(sale.tax_amount || 0),
    discountAmount:  Number(sale.discount_amount || 0),
    totalAmount:     Number(sale.total_amount || 0),
    paymentMeans:    pm.id,
    paymentMeansCode: pm.code,

    // Emisor
    supplierNit:          dianCfg.nit,
    supplierDv:           dianCfg.dv,
    supplierName:         dianCfg.company_name,
    supplierTradeName:    dianCfg.trade_name || dianCfg.company_name,
    supplierAddress:      dianCfg.address || tenant.address,
    supplierCity:         dianCfg.city || '',
    supplierCityCode:     dianCfg.city_code || '',
    supplierDept:         dianCfg.dept || '',
    supplierPhone:        dianCfg.phone || tenant.phone,
    supplierEmail:        dianCfg.email || tenant.email,
    supplierRegimeCode:   dianCfg.regime_code || '48',
    supplierTaxLevelCode: dianCfg.tax_level_code || 'R-99-PN',
    supplierSchemeID:     '31',

    // Adquiriente
    buyerNit:         buyerNit,
    buyerName:        sale.customer_name,
    buyerAddress:     sale.customer_address,
    buyerCity:        sale.customer_city || '',
    buyerCityCode:    sale.customer_city_code || '',
    buyerDept:        sale.customer_dept || '',
    buyerPhone:       sale.customer_phone,
    buyerEmail:       sale.customer_email,
    buyerSchemeID,
    buyerTaxLevelCode: dianCfg.buyer_tax_level_code || 'R-99-PN',
    buyerRegimeCode:   dianCfg.buyer_regime_code || '49',

    // Resolución / Software
    softwareId:           dianCfg.software_id,
    softwareProviderId:   dianCfg.software_provider_nit,
    softwarePin:          dianCfg.software_pin,
    technicalKey:         dianCfg.technical_key,
    resolutionNumber:     resolution.resolution_number,
    resolutionStartDate:  resolution.valid_from,
    resolutionEndDate:    resolution.valid_to,
    resolutionPrefix:     resolution.prefix,
    resolutionFrom:       resolution.from_number,
    resolutionTo:         resolution.to_number,
    environment:          dianCfg.environment || 'test',
    customizationID:      dianCfg.customization_id || '10',
  };
}

/* ──────────────────────────────────────────────────────────
 * sendInvoiceToDian – Función principal
 * ────────────────────────────────────────────────────────── */
async function sendInvoiceToDian(sale, tenant) {
  const { Sale, DianEvent } = require('../../models');
  const transaction = await sequelize.transaction();

  try {
    // 1. Validar configuración
    const dianCfg = extractDianConfig(tenant);
    const isTest = dianCfg.environment !== 'production';

    // 2. Solo se envían FACTURAS
    if (sale.document_type !== 'factura') {
      logger.info(`[DIAN] Documento ${sale.sale_number} tipo ${sale.document_type} — NO se envía a DIAN`);
      await Sale.update({ dian_status: 'not_applicable' }, { where: { id: sale.id }, transaction });
      await transaction.commit();
      return { sent: false, reason: 'not_applicable' };
    }

    // 3. Obtener consecutivo de resolución DIAN
    const { consecutive, invoiceNumber, resolution } = await getNextConsecutive(
      tenant.id, isTest, transaction
    );

    // 4. Marcar como "enviando"
    await Sale.update(
      { dian_status: 'sending', dian_invoice_number: invoiceNumber },
      { where: { id: sale.id }, transaction }
    );

    // 5. Fecha/hora Colombia
    const { date: issueDate, time: issueTime } = getColombiaDateTime();

    // 6. Construir XML
    const items = sale.items || [];
    const payload = buildXmlPayload(sale, items, tenant, dianCfg, resolution, issueDate, issueTime, invoiceNumber);
    const { xml: unsignedXml, cufe, qrCode } = buildInvoiceXml(payload);

    // 7. Firmar XML con certificado digital (XAdES-BES)
    let signedXml = unsignedXml;
    if (dianCfg.certificate_p12_base64 && dianCfg.certificate_password) {
      try {
        signedXml = await dianSigner.signXml(unsignedXml, {
          p12Base64: dianCfg.certificate_p12_base64,
          password: dianCfg.certificate_password,
          invoiceNumber,
        });
      } catch (signErr) {
        logger.warn(`[DIAN] Firma digital falló: ${signErr.message}. Se enviará sin firma (solo pruebas).`);
      }
    }

    // 8. Enviar a DIAN
    let dianResponse;
    if (isTest && dianCfg.test_set_id) {
      dianResponse = await dianApi.sendTestSetAsync({
        xmlContent: signedXml,
        nit: dianCfg.nit,
        invoiceNumber,
        testSetId: dianCfg.test_set_id,
        environment: 'test',
        p12Base64: dianCfg.certificate_p12_base64,
        password:  dianCfg.certificate_password,
      });
    } else {
      dianResponse = await dianApi.sendBillSync({
        xmlContent: signedXml,
        nit: dianCfg.nit,
        invoiceNumber,
        cufe,
        environment: dianCfg.environment || 'test',
        p12Base64: dianCfg.certificate_p12_base64,
        password:  dianCfg.certificate_password,
      });
    }

    // 9. Persistir resultado
    const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    await Sale.update({
      dian_invoice_number: invoiceNumber,
      cufe,
      dian_status: dianStatus,
      dian_response: dianResponse,
      dian_qr_code: qrCode,
      dian_sent_at: new Date(),
      dian_accepted_at: accepted ? new Date() : null,
      dian_error_message: accepted ? null : (dianResponse.statusMessage || dianResponse.statusDescription),
    }, { where: { id: sale.id }, transaction });

    await DianEvent.create({
      tenant_id: tenant.id,
      sale_id: sale.id,
      event_type: isTest ? 'SendTestSetAsync' : 'SendBillSync',
      document_type: 'Invoice',
      invoice_number: invoiceNumber,
      cufe,
      response_raw: dianResponse.raw,
      status: dianStatus,
      error_message: accepted ? null : dianResponse.statusMessage,
      is_test: isTest,
    }, { transaction });

    await transaction.commit();

    logger.info(`[DIAN] Factura ${invoiceNumber} — Status: ${dianStatus} | CUFE: ${cufe.substring(0, 16)}...`);

    return {
      sent: true,
      accepted,
      invoiceNumber,
      cufe,
      qrCode,
      dianStatus,
      dianResponse,
    };

  } catch (error) {
    await transaction.rollback();
    logger.error(`[DIAN] Error enviando factura ${sale.sale_number}:`, error);

    // Marcar como error sin bloquear la venta
    try {
      const { Sale, DianEvent } = require('../../models');
      await Sale.update({
        dian_status: 'rejected',
        dian_error_message: error.message,
      }, { where: { id: sale.id } });

      await DianEvent.create({
        tenant_id: tenant.id,
        sale_id: sale.id,
        event_type: 'SendBillSync',
        document_type: 'Invoice',
        status: 'error',
        error_message: error.message,
        is_test: (tenant.dian_config?.environment || 'test') !== 'production',
      });
    } catch (e2) {
      logger.error('[DIAN] Error guardando evento de error:', e2);
    }

    throw error;
  }
}

/* ──────────────────────────────────────────────────────────
 * checkInvoiceStatus – Re-consulta estado en DIAN
 * ────────────────────────────────────────────────────────── */
async function checkInvoiceStatus(sale, tenant) {
  const { Sale, DianEvent } = require('../../models');
  const dianCfg = extractDianConfig(tenant);
  const environment = dianCfg.environment || 'test';

  if (!sale.cufe) {
    throw new Error('Esta factura no tiene CUFE registrado.');
  }

  const result = await dianApi.getStatus({
    cufe: sale.cufe,
    environment,
    p12Base64: dianCfg.certificate_p12_base64,
    password:  dianCfg.certificate_password,
  });

  const accepted = result.isValid || result.statusCode === '00';
  await Sale.update({
    dian_status: accepted ? 'accepted' : 'rejected',
    dian_response: result,
    dian_accepted_at: accepted ? new Date() : null,
    dian_error_message: accepted ? null : result.statusMessage,
  }, { where: { id: sale.id } });

  await DianEvent.create({
    tenant_id: tenant.id,
    sale_id: sale.id,
    event_type: 'GetStatus',
    document_type: 'Invoice',
    invoice_number: sale.dian_invoice_number,
    cufe: sale.cufe,
    response_raw: result.raw,
    status: accepted ? 'accepted' : 'rejected',
    error_message: accepted ? null : result.statusMessage,
    is_test: environment !== 'production',
  });

  return result;
}

/* ──────────────────────────────────────────────────────────
 * buildNotePayload — campos comunes para NC y ND
 * ────────────────────────────────────────────────────────── */
function buildNotePayload(note, tenant, dianCfg, resolution, noteNumber, issueDate, issueTime, refInvoiceNumber, refInvoiceCufe, refInvoiceDate, noteOpts = {}) {
  const { buildCreditNoteXml: _nc, buildDebitNoteXml: _nd, buildCreditNoteXml, buildDebitNoteXml } = require('./dianXmlBuilder');
  const items = note.items?.length ? note.items : [{
    description: noteOpts.defaultDesc || 'Ajuste',
    quantity: 1,
    unit_price: Number(note.total_amount || note.subtotal || 0),
    subtotal: Number(note.subtotal || note.total_amount || 0),
    tax_amount: Number(note.tax_amount || 0),
    tax_rate: 0,
    unit_code: 'EA',
  }];

  return {
    noteNumber,
    issueDate,
    issueTime,
    items,
    subtotal:        Number(note.subtotal || 0),
    taxAmount:       Number(note.tax_amount || 0),
    discountAmount:  Number(note.discount_amount || 0),
    totalAmount:     Number(note.total_amount || 0),
    paymentMeans: '1', paymentMeansCode: '10',

    supplierNit:          dianCfg.nit,
    supplierDv:           dianCfg.dv || '0',
    supplierName:         dianCfg.company_name,
    supplierTradeName:    dianCfg.trade_name || dianCfg.company_name,
    supplierAddress:      dianCfg.address || tenant.address || '',
    supplierCity:         dianCfg.city || '',
    supplierCityCode:     dianCfg.city_code || '',
    supplierDept:         dianCfg.dept || '',
    supplierPhone:        dianCfg.phone || tenant.phone || '',
    supplierEmail:        dianCfg.email || tenant.email || '',
    supplierRegimeCode:   dianCfg.regime_code || '48',
    supplierTaxLevelCode: dianCfg.tax_level_code || 'R-99-PN',
    supplierSchemeID:     '31',

    buyerNit:         note.customer_tax_id || '',
    buyerName:        note.customer_name || 'Consumidor Final',
    buyerAddress:     note.customer_address || '',
    buyerCity:        note.customer_city || '',
    buyerCityCode:    note.customer_city_code || '',
    buyerDept:        note.customer_dept || '',
    buyerPhone:       note.customer_phone || '',
    buyerEmail:       note.customer_email || '',
    buyerSchemeID:    dianCfg.buyer_default_scheme_id || '13',
    buyerTaxLevelCode: dianCfg.buyer_tax_level_code || 'R-99-PN',
    buyerRegimeCode:   dianCfg.buyer_regime_code || '49',

    softwareId:          dianCfg.software_id,
    softwareProviderId:  dianCfg.software_provider_nit || dianCfg.nit,
    softwarePin:         dianCfg.software_pin,
    technicalKey:        dianCfg.technical_key,
    resolutionNumber:    resolution.resolution_number,
    resolutionStartDate: resolution.valid_from,
    resolutionEndDate:   resolution.valid_to,
    resolutionPrefix:    resolution.prefix,
    resolutionFrom:      Number(resolution.from_number),
    resolutionTo:        Number(resolution.to_number),
    environment:         dianCfg.environment || 'test',
    customizationID:     '22',

    correctedInvoiceNumber: refInvoiceNumber,
    correctedInvoiceCufe:   refInvoiceCufe,
    correctedInvoiceDate:   refInvoiceDate,
    discrepancyCode:  noteOpts.discrepancyCode  || note.discrepancy_code  || '1',
    discrepancyDesc:  noteOpts.discrepancyDesc  || note.discrepancy_desc  || (noteOpts.isDebit ? 'Intereses' : 'Devolución parcial de los bienes'),
  };
}

/* ──────────────────────────────────────────────────────────
 * resolveNoteReference — obtiene número/CUFE de la factura corregida
 * Busca en orden:
 *   1. sale.reference_invoice_number / sale.reference_invoice_cufe
 *   2. Venta referenciada por sale.reference_sale_id en BD
 * ────────────────────────────────────────────────────────── */
async function resolveNoteReference(note) {
  const { Sale } = require('../../models');

  if (note.reference_invoice_number && note.reference_invoice_cufe) {
    return {
      number: note.reference_invoice_number,
      cufe:   note.reference_invoice_cufe,
      date:   note.reference_invoice_date || new Date().toISOString().split('T')[0],
    };
  }

  if (note.reference_sale_id) {
    const ref = await Sale.findByPk(note.reference_sale_id);
    if (!ref) throw new Error(`No se encontró la factura referenciada (ID ${note.reference_sale_id}).`);
    if (!ref.dian_invoice_number || !ref.cufe) {
      throw new Error(`La factura referenciada (${ref.sale_number}) no ha sido enviada a la DIAN o no tiene CUFE.`);
    }
    return {
      number: ref.dian_invoice_number,
      cufe:   ref.cufe,
      date:   ref.created_at?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0],
    };
  }

  throw new Error('Nota crédito/débito requiere reference_invoice_number+cufe o reference_sale_id con una factura DIAN aceptada.');
}

/* ──────────────────────────────────────────────────────────
 * _sendNoteToDian — función interna compartida por NC y ND
 * ────────────────────────────────────────────────────────── */
async function _sendNoteToDian(note, tenant, isDebit = false) {
  const { buildCreditNoteXml, buildDebitNoteXml, getColombiaDateTime } = require('./dianXmlBuilder');
  const { Sale, DianEvent, DianResolution } = require('../../models');
  const transaction = await sequelize.transaction();
  const docLabel = isDebit ? 'ND' : 'NC';

  try {
    const dianCfg = extractDianConfig(tenant);
    const isTest = dianCfg.environment !== 'production';

    const ref = await resolveNoteReference(note);

    const resolution = await DianResolution.findOne({
      where: { tenant_id: tenant.id, is_active: true, is_test: isTest },
      order: [['created_at', 'DESC']],
      transaction,
    });
    if (!resolution) throw new Error(`No hay resolución DIAN ${isTest ? 'de pruebas ' : ''}activa.`);

    // Generar número único para la nota (no consume rango de facturas)
    const ts = Date.now().toString().slice(-8);
    const noteNumber = `${docLabel}${resolution.prefix}${ts}`;

    if (note.id) {
      await Sale.update(
        { dian_status: 'sending', dian_invoice_number: noteNumber },
        { where: { id: note.id }, transaction }
      );
    }

    const { date: issueDate, time: issueTime } = getColombiaDateTime();
    const payload = buildNotePayload(note, tenant, dianCfg, resolution, noteNumber, issueDate, issueTime, ref.number, ref.cufe, ref.date, { isDebit });

    const { xml: unsignedXml, cude, qrCode } = isDebit
      ? buildDebitNoteXml(payload)
      : buildCreditNoteXml(payload);

    let signedXml = unsignedXml;
    if (dianCfg.certificate_p12_base64 && dianCfg.certificate_password) {
      try {
        signedXml = await dianSigner.signXml(unsignedXml, {
          p12Base64: dianCfg.certificate_p12_base64,
          password:  dianCfg.certificate_password,
          invoiceNumber: noteNumber,
        });
      } catch (signErr) {
        logger.warn(`[DIAN ${docLabel}] Firma falló: ${signErr.message}. Enviando sin firma.`);
      }
    }

    let dianResponse;
    if (isTest && dianCfg.test_set_id) {
      dianResponse = await dianApi.sendTestSetAsync({
        xmlContent: signedXml, nit: dianCfg.nit, invoiceNumber: noteNumber,
        testSetId: dianCfg.test_set_id, environment: 'test',
        p12Base64: dianCfg.certificate_p12_base64, password: dianCfg.certificate_password,
      });
    } else {
      dianResponse = await dianApi.sendBillSync({
        xmlContent: signedXml, nit: dianCfg.nit, invoiceNumber: noteNumber,
        cufe: cude, environment: dianCfg.environment || 'test',
        p12Base64: dianCfg.certificate_p12_base64, password: dianCfg.certificate_password,
      });
    }

    const accepted = dianResponse.isValid || dianResponse.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    if (note.id) {
      await Sale.update({
        dian_invoice_number: noteNumber,
        cufe: cude,
        dian_status: dianStatus,
        dian_response: dianResponse,
        dian_qr_code: qrCode,
        dian_sent_at: new Date(),
        dian_accepted_at: accepted ? new Date() : null,
        dian_error_message: accepted ? null : (dianResponse.statusMessage || dianResponse.statusDescription),
      }, { where: { id: note.id }, transaction });
    }

    await DianEvent.create({
      tenant_id: tenant.id,
      sale_id:   note.id || null,
      event_type: isTest ? 'SendTestSetAsync' : 'SendBillSync',
      document_type: isDebit ? 'DebitNote' : 'CreditNote',
      invoice_number: noteNumber,
      cufe: cude,
      response_raw: dianResponse.raw,
      status: dianStatus,
      error_message: accepted ? null : dianResponse.statusMessage,
      is_test: isTest,
    }, { transaction });

    await transaction.commit();

    logger.info(`[DIAN ${docLabel}] ${noteNumber} → ${dianStatus} | CUDE: ${cude?.substring(0, 16)}...`);
    return { sent: true, accepted, noteNumber, cude, qrCode, dianStatus, dianResponse };

  } catch (error) {
    await transaction.rollback();
    logger.error(`[DIAN ${docLabel}] Error:`, error.message);
    if (note.id) {
      try {
        await Sale.update({ dian_status: 'rejected', dian_error_message: error.message }, { where: { id: note.id } });
        await DianEvent.create({
          tenant_id: tenant.id, sale_id: note.id,
          event_type: 'SendBillSync', document_type: isDebit ? 'DebitNote' : 'CreditNote',
          status: 'error', error_message: error.message,
          is_test: (tenant.dian_config?.environment || 'test') !== 'production',
        });
      } catch (_) { /* no bloquear */ }
    }
    throw error;
  }
}

async function sendCreditNoteToDian(sale, tenant) {
  return _sendNoteToDian(sale, tenant, false);
}

async function sendDebitNoteToDian(sale, tenant) {
  return _sendNoteToDian(sale, tenant, true);
}

module.exports = {
  sendInvoiceToDian,
  checkInvoiceStatus,
  getNextConsecutive,
  extractDianConfig,
  sendCreditNoteToDian,
  sendDebitNoteToDian,
};