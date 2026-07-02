// backend/src/services/dian/dianKitAdapter.js
/**
 * Adaptador dian-kit — envuelve el SDK @dian-kit/sdk-node
 * para integrarlo con la arquitectura existente de Pitbox.
 *
 * Maneja: inicialización del DOMParser, carga de certificados,
 * generación de XML UBL 2.1, firma XAdES-BES, y envío a DIAN.
 */
'use strict';

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { setNodeDependencies } = require('xadesjs');
const { DianKit } = require('@dian-kit/sdk-node');
const logger = require('../../config/logger');

// Inicializar dependencias de Node para xadesjs/xmldsigjs/xml-core
// IMPORTANTE: debe ejecutarse ANTES de cualquier uso de DianKit
let _initialized = false;
function initDeps() {
  if (_initialized) return;
  setNodeDependencies({ DOMParser, XMLSerializer });
  // xmldsigjs tiene su propia instancia de xml-core
  try {
    const path = require('path');
    const xmldsigXmlCorePath = require.resolve('xml-core', {
      paths: [path.join(process.cwd(), 'node_modules', 'xmldsigjs')],
    });
    require(xmldsigXmlCorePath).setNodeDependencies({ DOMParser, XMLSerializer });
  } catch (e) {
    logger.warn('[DIAN-Kit] No se pudo configurar xmldsigjs xml-core:', e.message);
  }
  _initialized = true;
}

// Caché de instancias DianKit por tenant
const _kitCache = new Map();

/**
 * Obtiene o crea una instancia de DianKit para un tenant.
 * Cachea la instancia para evitar recargar el certificado en cada llamada.
 */
function getKit(tenant) {
  const cacheKey = tenant.id;
  if (_kitCache.has(cacheKey)) return _kitCache.get(cacheKey);

  initDeps();

  const cfg = tenant.dian_config || {};
  if (!cfg.certificate_p12_base64 || cfg.certificate_p12_base64 === '[CONFIGURADO]') {
    throw new Error('Certificado digital no configurado para este tenant.');
  }
  if (!cfg.certificate_password) {
    throw new Error('Contraseña del certificado no configurada.');
  }

  const p12Buffer = Buffer.from(cfg.certificate_p12_base64, 'base64');
  const environment = cfg.environment === 'production' ? '1' : '2';

  const kit = new DianKit({
    certificate: p12Buffer,
    certificatePassword: cfg.certificate_password,
    environment,
    supplier: {
      name: cfg.company_name || tenant.company_name,
      identification: {
        number: cfg.nit,
        type: '31',
        dv: cfg.dv || '0',
      },
      personType: '1',
      fiscalResponsibilities: [cfg.tax_level_code || 'O-13'],
      taxInfo: {
        registrationName: cfg.company_name || tenant.company_name,
        companyId: { number: cfg.nit, type: '31', dv: cfg.dv || '0' },
        taxLevelCode: cfg.tax_level_code || 'O-13',
        taxScheme: { code: '01' },
        address: buildAddress(cfg, tenant),
      },
      address: buildAddress(cfg, tenant),
      email: cfg.email || tenant.email || 'facturacion@empresa.com',
    },
    software: {
      id: cfg.software_id,
      pin: cfg.software_pin,
      providerNit: cfg.software_provider_nit || cfg.nit,
      providerName: cfg.company_name || tenant.company_name,
    },
    numbering: {
      authorizationNumber: '18760000001', // Resolución estándar DIAN habilitación
      prefix: 'SETP',
      startNumber: 990000000,
      endNumber: 995000000,
      startDate: new Date(2019, 0, 19),
      endDate: new Date(2030, 0, 19),
      technicalKey: cfg.technical_key,
    },
    timeoutMs: 60000,
  });

  _kitCache.set(cacheKey, kit);
  return kit;
}

function buildAddress(cfg, tenant) {
  return {
    street: cfg.address || tenant.address || 'Sin direccion',
    cityCode: cfg.city_code || '11001',
    cityName: cfg.city || 'Bogota',
    departmentCode: cfg.city_code?.substring(0, 2) || '11',
    departmentName: cfg.dept || 'Cundinamarca',
    countryCode: 'CO',
    countryName: 'Colombia',
  };
}

/**
 * Parsea fecha YYYY-MM-DD a Date en mediodía UTC para evitar desfase por zona horaria.
 * Colombia es UTC-5, así que mediodía UTC = 7am Colombia (mismo día).
 */
function parseDateCol(dateStr) {
  if (!dateStr) return new Date();
  if (dateStr instanceof Date) return dateStr;
  const parts = String(dateStr).split('T')[0].split('-');
  if (parts.length === 3) {
    return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0));
  }
  return new Date(dateStr);
}

/**
 * Mapea códigos de régimen/taxLevel a fiscal responsibilities válidos para dian-kit.
 * Valores válidos: O-13, O-15, O-23, O-47, R-99-PN
 */
function mapFiscalResponsibility(code) {
  const valid = ['O-13', 'O-15', 'O-23', 'O-47', 'R-99-PN'];
  if (valid.includes(code)) return code;
  // Mapear códigos de régimen comunes
  const map = {
    '48': 'O-13',   // Responsable de IVA
    '49': 'R-99-PN', // No responsable
    'O-99': 'R-99-PN',
  };
  return map[code] || 'R-99-PN';
}

/**
 * Invalida la caché del kit para un tenant (cuando cambia la config).
 */
function invalidateKit(tenantId) {
  _kitCache.delete(tenantId);
}

/**
 * Mapea los items de venta al formato dian-kit.
 */
function mapLines(items) {
  return items.map((item, idx) => ({
    id: String(item.id || idx + 1),
    quantity: Number(item.quantity || 1),
    unitCode: item.unit_code || 'EA',
    description: item.description || item.name || 'Item',
    price: Number(item.unit_price || item.price || 0),
    lineExtensionAmount: Number(item.subtotal || item.lineExtensionAmount || 0),
    taxTotals: buildTaxTotalsForLine(item),
  }));
}

function buildTaxTotalsForLine(item) {
  const taxAmount = Number(item.tax_amount || 0);
  const taxableAmount = Number(item.subtotal || item.lineExtensionAmount || 0);
  const percent = Number(item.tax_rate || item.tax_percentage || 0);

  if (taxAmount === 0 && percent === 0) {
    return [{ taxAmount: 0, subtotals: [{ taxableAmount, taxAmount: 0, percent: 0, taxScheme: { code: '01' } }] }];
  }

  return [{
    taxAmount,
    subtotals: [{
      taxableAmount,
      taxAmount,
      percent,
      taxScheme: { code: '01' },
    }],
  }];
}

/**
 * Construye los taxTotals a nivel documento.
 */
function buildDocumentTaxTotals(items) {
  const groups = {};
  for (const item of items) {
    const pct = Number(item.tax_rate || item.tax_percentage || 0);
    const key = `01_${pct}`;
    if (!groups[key]) {
      groups[key] = { pct, taxableAmount: 0, taxAmount: 0 };
    }
    groups[key].taxableAmount += Number(item.subtotal || item.lineExtensionAmount || 0);
    groups[key].taxAmount += Number(item.tax_amount || 0);
  }

  return Object.values(groups).map(g => ({
    taxAmount: g.taxAmount,
    subtotals: [{
      taxableAmount: g.taxableAmount,
      taxAmount: g.taxAmount,
      percent: g.pct,
      taxScheme: { code: '01' },
    }],
  }));
}

/**
 * Crea y firma una factura usando dian-kit.
 * Retorna { xml, signedXml, cufe, documentNumber }.
 */
async function createInvoice(tenant, { invoiceNumber, items, resolution, customer, sale }) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};

  // Actualizar numbering con datos de la resolución
  kit.config.numbering = {
    authorizationNumber: resolution.resolution_number,
    prefix: resolution.prefix,
    startNumber: Number(resolution.from_number),
    endNumber: Number(resolution.to_number),
    startDate: parseDateCol(resolution.valid_from),
    endDate: parseDateCol(resolution.valid_to),
    technicalKey: cfg.technical_key,
  };

  const subtotal = items.reduce((s, it) => s + Number(it.subtotal || it.lineExtensionAmount || 0), 0);
  const taxAmount = items.reduce((s, it) => s + Number(it.tax_amount || 0), 0);
  const total = subtotal + taxAmount;

  const customerData = {
    name: customer?.name || sale?.customer_name || 'Consumidor Final',
    identification: {
      number: customer?.nit || sale?.customer_tax_id || '13832081',
      type: customer?.schemeID || sale?.buyerSchemeID || '31',
      dv: customer?.dv || '0',
    },
    personType: '1',
    fiscalResponsibilities: [mapFiscalResponsibility(customer?.regimeCode || customer?.taxLevelCode || 'R-99-PN')],
    taxInfo: {
      registrationName: customer?.name || sale?.customer_name || 'Consumidor Final',
      companyId: {
        number: customer?.nit || sale?.customer_tax_id || '13832081',
        type: customer?.schemeID || sale?.buyerSchemeID || '31',
        dv: customer?.dv || '0',
      },
      taxLevelCode: customer?.taxLevelCode || 'R-99-PN',
      taxScheme: { code: '01' },
      address: {
        street: customer?.address || sale?.customer_address || 'Sin direccion',
        cityCode: customer?.cityCode || '11001',
        cityName: customer?.city || 'Bogota',
        departmentCode: '11',
        departmentName: customer?.dept || 'Cundinamarca',
        countryCode: 'CO',
        countryName: 'Colombia',
      },
    },
    address: {
      street: customer?.address || sale?.customer_address || 'Sin direccion',
      cityCode: customer?.cityCode || '11001',
      cityName: customer?.city || 'Bogota',
      departmentCode: '11',
      departmentName: customer?.dept || 'Cundinamarca',
      countryCode: 'CO',
      countryName: 'Colombia',
    },
    email: customer?.email || sale?.customer_email || '',
  };

  const result = await kit.createInvoice({
    id: invoiceNumber,
    issueDate: new Date(),
    issueTime: new Date(),
    customer: customerData,
    lines: mapLines(items),
    taxTotals: buildDocumentTaxTotals(items),
    legalMonetaryTotal: {
      lineExtensionAmount: subtotal,
      taxExclusiveAmount: subtotal,
      taxInclusiveAmount: total,
      allowanceTotalAmount: 0,
      chargeTotalAmount: 0,
      prepaidAmount: 0,
      payableAmount: total,
    },
    paymentMeans: {
      paymentForm: '1',
      paymentMethod: '10',
    },
  });

  return {
    xml: result.xml,
    signedXml: result.signedXml,
    cufe: result.uuid,
    documentNumber: result.documentNumber,
  };
}

/**
 * Envía un XML firmado a DIAN usando dian-kit.
 * Si hay test_set_id, usa SendTestSetAsync y hace polling con GetStatusZip.
 */
async function sendToDian(tenant, { signedXml, invoiceNumber, cufe }) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};
  const testSetId = cfg.test_set_id;
  const isTest = cfg.environment !== 'production';

  // Determinar método de envío
  const sendOptions = {};
  if (isTest && testSetId) {
    sendOptions.method = 'SendTestSetAsync';
    sendOptions.testSetId = testSetId;
  }

  const response = await kit.send({
    xml: signedXml,
    signedXml,
    uuid: cufe,
    documentNumber: invoiceNumber,
  }, sendOptions);

  // Para SendTestSetAsync, hacer polling con GetStatusZip hasta resultado final.
  if (isTest && testSetId && response.trackId) {
    logger.info(`[DIAN] ZipKey=${response.trackId} — haciendo polling GetStatusZip...`);

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));

      try {
        const statusResp = await kit.getStatusZip(response.trackId);
        logger.info(`[DIAN] Poll ${i + 1}: statusCode=${statusResp.statusCode} isValid=${statusResp.isValid}`);

        if (statusResp.isValid === true) {
          return {
            isValid: true,
            statusCode: statusResp.statusCode || '00',
            statusDescription: statusResp.statusDescription || 'Aceptado',
            statusMessage: statusResp.statusDescription || 'Aceptado',
            trackId: response.trackId,
            errors: statusResp.errors,
            raw: JSON.stringify(statusResp),
          };
        }

        const isProcessing = !statusResp.statusCode || 
                             statusResp.statusCode === '99' || 
                             statusResp.statusCode === '0' ||
                             statusResp.statusCode === '';
        
        if (!isProcessing) {
          return {
            isValid: statusResp.isValid,
            statusCode: statusResp.statusCode,
            statusDescription: statusResp.statusDescription,
            statusMessage: statusResp.statusDescription,
            trackId: response.trackId,
            errors: statusResp.errors,
            raw: JSON.stringify(statusResp),
          };
        }
      } catch (pollErr) {
        logger.warn(`[DIAN] Poll ${i + 1} error: ${pollErr.message}`);
      }
    }

    logger.warn('[DIAN] Polling timeout después de 60 intentos (5 min)');
    return {
      isValid: false,
      statusCode: '99',
      statusDescription: 'En proceso de validación — consulte el portal DIAN',
      statusMessage: 'DIAN tardó más de 5 minutos. Consulte el portal.',
      trackId: response.trackId,
      errors: [],
      raw: JSON.stringify({ timeout: true, trackId: response.trackId }),
    };
  }

  return {
    isValid: response.isValid,
    statusCode: response.statusCode,
    statusDescription: response.statusDescription,
    statusMessage: response.statusDescription,
    trackId: response.trackId,
    errors: response.errors,
    raw: JSON.stringify(response),
  };
}

/**
 * Consulta el estado de un documento por CUFE.
 */
async function getStatusByCufe(tenant, cufe) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};

  const response = await kit.getStatus(cufe);

  return {
    isValid: response.isValid,
    statusCode: response.statusCode,
    statusDescription: response.statusDescription,
    statusMessage: response.statusDescription,
    raw: JSON.stringify(response),
  };
}

/**
 * Consulta rangos de numeración autorizados en DIAN.
 * Usado para verificar conectividad y configuración.
 */
async function getNumberingRange(tenant) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};

  const response = await kit.getNumberingRange();

  return {
    isValid: response.isValid,
    statusCode: response.statusCode,
    statusDescription: response.statusDescription,
    statusMessage: response.statusDescription,
    isFault: !response.isValid && !!response.statusCode,
    raw: JSON.stringify(response),
    ranges: response.ranges || [],
  };
}

module.exports = {
  getKit,
  invalidateKit,
  createInvoice,
  sendToDian,
  getStatusByCufe,
  getNumberingRange,
  mapLines,
  buildDocumentTaxTotals,
};
