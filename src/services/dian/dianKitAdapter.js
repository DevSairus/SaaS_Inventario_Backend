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
    supplier: buildSelfParty(cfg, tenant),
    software: {
      id: cfg.software_id,
      pin: cfg.software_pin,
      providerNit: cleanId(cfg.software_provider_nit) || cleanId(cfg.nit),
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

/**
 * Limpia espacios en blanco de números de identificación (NIT/cédula/DV).
 * Un espacio de más (ej. "222222222222 " capturado de un formulario) viaja
 * intacto al cálculo del CUFE, pero la DIAN normaliza espacios al parsear el
 * XML — el hash que ellos recalculan ya no coincide con el que enviamos, y
 * el documento se rechaza por "CUFE no calculado correctamente" (FAD06).
 */
function cleanId(value) {
  return value == null ? value : String(value).trim();
}

/**
 * Party (Party/PartyTaxInfo) de tu propia empresa, tal como la exige @dian-kit
 * para `DianKitConfig.supplier` — reutilizado también como `customer` al
 * generar un Documento Soporte, donde tú eres el adquirente, no el vendedor.
 */
function buildSelfParty(cfg, tenant) {
  return {
    name: cfg.company_name || tenant.company_name,
    identification: {
      number: cleanId(cfg.nit),
      type: '31',
      dv: cleanId(cfg.dv) || '0',
    },
    personType: '1',
    fiscalResponsibilities: [cfg.tax_level_code || 'O-13'],
    taxInfo: {
      registrationName: cfg.company_name || tenant.company_name,
      companyId: { number: cleanId(cfg.nit), type: '31', dv: cleanId(cfg.dv) || '0' },
      taxLevelCode: cfg.tax_level_code || 'O-13',
      taxScheme: { code: '01' },
      address: buildAddress(cfg, tenant),
    },
    address: buildAddress(cfg, tenant),
    email: cfg.email || tenant.email || 'facturacion@empresa.com',
  };
}

/**
 * Dígito de verificación de un NIT colombiano (algoritmo módulo 11 oficial
 * DIAN).
 */
function computeNitCheckDigit(nit) {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digits = String(nit).replace(/\D/g, '').split('').reverse();
  const sum = digits.reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  const mod = sum % 11;
  return mod < 2 ? mod : 11 - mod;
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
    description: item.description || item.name || item.product_name || 'Item',
    price: Number(item.unit_price || item.price || 0),
    lineExtensionAmount: Number(item.subtotal || item.lineExtensionAmount || 0),
    taxTotals: buildTaxTotalsForLine(item),
  }));
}

function buildTaxTotalsForLine(item) {
  const taxableAmount = Number(item.subtotal || item.lineExtensionAmount || 0);
  const totals = [];

  // IVA (01)
  const ivaAmount = Number(item.tax_amount || 0);
  const ivaRate = Number(item.tax_rate || item.tax_percentage || 0);
  totals.push({
    taxAmount: ivaAmount,
    subtotals: [{ taxableAmount, taxAmount: ivaAmount, percent: ivaRate, taxScheme: { code: '01' } }],
  });

  // INC (04) — impoconsumo
  const incAmount = Number(item.inc_amount || 0);
  const incRate = Number(item.inc_rate || 0);
  if (incAmount > 0) {
    totals.push({
      taxAmount: incAmount,
      subtotals: [{ taxableAmount, taxAmount: incAmount, percent: incRate, taxScheme: { code: '04' } }],
    });
  }

  // ICA (03)
  const icaAmount = Number(item.ica_amount || 0);
  const icaRate = Number(item.ica_rate || 0);
  if (icaAmount > 0) {
    totals.push({
      taxAmount: icaAmount,
      subtotals: [{ taxableAmount, taxAmount: icaAmount, percent: icaRate, taxScheme: { code: '03' } }],
    });
  }

  return totals;
}

/**
 * Construye los taxTotals a nivel documento.
 */
function buildDocumentTaxTotals(items) {
  const ivaGroups = {};
  let totalInc = 0, totalIncBase = 0;
  let totalIca = 0, totalIcaBase = 0;

  for (const item of items) {
    const base = Number(item.subtotal || item.lineExtensionAmount || 0);

    // IVA
    const ivaPct = Number(item.tax_rate || item.tax_percentage || 0);
    const ivaKey = `01_${ivaPct}`;
    if (!ivaGroups[ivaKey]) ivaGroups[ivaKey] = { pct: ivaPct, taxableAmount: 0, taxAmount: 0 };
    ivaGroups[ivaKey].taxableAmount += base;
    ivaGroups[ivaKey].taxAmount += Number(item.tax_amount || 0);

    // INC
    if (Number(item.inc_amount || 0) > 0) {
      totalInc += Number(item.inc_amount);
      totalIncBase += base;
    }

    // ICA
    if (Number(item.ica_amount || 0) > 0) {
      totalIca += Number(item.ica_amount);
      totalIcaBase += base;
    }
  }

  const result = Object.values(ivaGroups).map(g => ({
    taxAmount: g.taxAmount,
    subtotals: [{ taxableAmount: g.taxableAmount, taxAmount: g.taxAmount, percent: g.pct, taxScheme: { code: '01' } }],
  }));

  // INC (04)
  if (totalInc > 0) {
    result.push({
      taxAmount: totalInc,
      subtotals: [{ taxableAmount: totalIncBase, taxAmount: totalInc, percent: totalInc / totalIncBase * 100, taxScheme: { code: '04' } }],
    });
  }

  // ICA (03)
  if (totalIca > 0) {
    result.push({
      taxAmount: totalIca,
      subtotals: [{ taxableAmount: totalIcaBase, taxAmount: totalIca, percent: totalIca / totalIcaBase * 1000, taxScheme: { code: '03' } }],
    });
  }

  return result;
}

/**
 * Party de una contraparte externa (comprador de una factura, o vendedor de
 * un Documento Soporte) a partir de un `customer`/`seller` explícito (ej.
 * comprador sintético de dianAutoTestService), o de los campos customer_*
 * denormalizados en `sale` al momento de facturar (Customer.city_code/
 * document_type copiados en sales.controller.js), o "Consumidor Final"/
 * Bogotá como último recurso.
 */
function buildCounterpartyData(counterparty, sale) {
  const cityCode = counterparty?.cityCode || sale?.customer_city_code || '11001';
  const address = {
    street: counterparty?.address || sale?.customer_address || 'Sin direccion',
    cityCode,
    cityName: counterparty?.city || sale?.customer_city_name || 'Bogota',
    departmentCode: cityCode.substring(0, 2),
    departmentName: counterparty?.dept || sale?.customer_department_name || 'Cundinamarca',
    countryCode: 'CO',
    countryName: 'Colombia',
  };
  const schemeID = counterparty?.schemeID || sale?.customer_document_type || '31';

  return {
    name: counterparty?.name || sale?.customer_name || 'Consumidor Final',
    identification: {
      number: cleanId(counterparty?.nit || sale?.customer_tax_id) || '13832081',
      type: schemeID,
      dv: cleanId(counterparty?.dv) || '0',
    },
    personType: '1',
    fiscalResponsibilities: [mapFiscalResponsibility(counterparty?.regimeCode || counterparty?.taxLevelCode || 'R-99-PN')],
    taxInfo: {
      registrationName: counterparty?.name || sale?.customer_name || 'Consumidor Final',
      companyId: {
        number: cleanId(counterparty?.nit || sale?.customer_tax_id) || '13832081',
        type: schemeID,
        dv: cleanId(counterparty?.dv) || '0',
      },
      taxLevelCode: counterparty?.taxLevelCode || 'R-99-PN',
      taxScheme: { code: '01' },
      address,
    },
    address,
    // Sin valor por defecto: el schema de @dian-kit exige un email con
    // formato válido CUANDO el campo viene presente, pero lo acepta ausente
    // (`.email().optional()`) — un '' por defecto rompía la validación para
    // cualquier cliente/proveedor sin correo registrado.
    ...((counterparty?.email || sale?.customer_email) && { email: counterparty?.email || sale?.customer_email }),
  };
}

function buildLegalMonetaryTotal(items) {
  const subtotal = items.reduce((s, it) => s + Number(it.subtotal || it.lineExtensionAmount || 0), 0);
  const taxAmount = items.reduce((s, it) => s + Number(it.tax_amount || 0), 0);
  const total = subtotal + taxAmount;
  return {
    lineExtensionAmount: subtotal,
    taxExclusiveAmount: subtotal,
    taxInclusiveAmount: total,
    allowanceTotalAmount: 0,
    chargeTotalAmount: 0,
    prepaidAmount: 0,
    payableAmount: total,
  };
}

/**
 * Crea y firma una factura usando dian-kit.
 * Retorna { xml, signedXml, cufe, documentNumber }.
 */
async function createInvoice(tenant, { invoiceNumber, items, resolution, customer, sale, documentType }) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};

  // Actualizar numbering con datos de la resolución.
  // La clave técnica prioriza la de LA RESOLUCIÓN (resolution.technical_key)
  // sobre la global del tenant (cfg.technical_key): la DIAN entrega una
  // habilitación — y por lo tanto una clave técnica — separada por tipo de
  // documento (factura vs. Documento Soporte, etc.), así que la que ya
  // funciona para facturación de venta no necesariamente sirve para otro
  // tipo de documento. Si la resolución no trae una propia (caso de todas
  // las resoluciones de factura ya creadas), se cae al valor global —
  // 100% retrocompatible.
  kit.config.numbering = {
    authorizationNumber: resolution.resolution_number,
    prefix: resolution.prefix,
    startNumber: Number(resolution.from_number),
    endNumber: Number(resolution.to_number),
    startDate: parseDateCol(resolution.valid_from),
    endDate: parseDateCol(resolution.valid_to),
    technicalKey: resolution.technical_key || cfg.technical_key,
  };

  const result = await kit.createInvoice({
    id: invoiceNumber,
    ...(documentType && { documentType }),
    issueDate: new Date(),
    issueTime: new Date(),
    customer: buildCounterpartyData(customer, sale),
    lines: mapLines(items),
    taxTotals: buildDocumentTaxTotals(items),
    legalMonetaryTotal: buildLegalMonetaryTotal(items),
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
 * Crea y firma un Documento Soporte (tipo 05 — adquisiciones a sujetos no
 * obligados a facturar).
 *
 * IMPORTANTE — esto NO usa `kit.createInvoice()`: @dian-kit v1.0.1 solo
 * documenta/soporta `documentType` "01" y "20" ahí (`assembleDocument` fija
 * `supplier` SIEMPRE a la config de TU empresa, sin forma de invertirlo por
 * llamada). Un Documento Soporte real necesita los roles al revés — el
 * vendedor (`AccountingSupplierParty`) es el tercero NO obligado a facturar
 * del que compraste, y el adquirente (`AccountingCustomerParty`) eres TÚ,
 * quien genera el documento — así que se arma el `DianDocument` a mano con
 * las funciones de bajo nivel que sí exporta @dian-kit/core, en vez de pasar
 * por el wrapper de factura.
 *
 * También corrige el nombre del esquema del UUID: @dian-kit solo distingue
 * CUFE (factura) de CUDE (todo lo demás, incluido Documento Soporte) y
 * etiqueta este hash como "CUDE-SHA384"; la DIAN exige "CUDS-SHA384" (Código
 * Único de Documento Soporte) para el tipo 05. El VALOR del hash es correcto
 * — usa la misma fórmula de concatenación que CUFE/CUDE — solo se corrige la
 * etiqueta del esquema en el XML sin firmar, antes de firmar (cambiarlo
 * después invalidaría la firma XAdES).
 *
 * Nota: esta implementación sigue la convención de roles documentada por
 * varios proveedores de facturación electrónica para Documento Soporte
 * (Anexo Técnico DIAN, Resolución 000167 de 2021), pero no fue verificada
 * contra un envío real aceptado por la DIAN. Trate el resultado de la
 * primera prueba en el set de habilitación como la validación definitiva de
 * esta estructura, no como un hecho ya confirmado.
 */
async function createSupportDocument(tenant, { documentNumber, items, resolution, seller, sale }) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};
  const {
    buildInvoiceXml, buildCufeInput, concatenateCufeFields, sha384,
    generateSoftwareSecurityCode, signXml, DianDocumentSchema, DocumentType,
  } = require('@dian-kit/core');

  // El Documento Soporte no tiene resolución/vigencia DIAN real (igual que
  // NC/ND — ver mismo fallback en dianService.js#sendCreditNoteRetry): estos
  // campos son opcionales en su resolución local, pero el schema de
  // @dian-kit igual exige un authorizationNumber no vacío y fechas válidas.
  // Se usan valores internos sin significado ante la DIAN (no los valida
  // para este tipo de documento).
  kit.config.numbering = {
    authorizationNumber: resolution.resolution_number || resolution.id,
    prefix: resolution.prefix,
    startNumber: Number(resolution.from_number),
    endNumber: Number(resolution.to_number),
    startDate: parseDateCol(resolution.valid_from || '2000-01-01'),
    endDate: parseDateCol(resolution.valid_to || '2100-01-01'),
    technicalKey: resolution.technical_key || cfg.technical_key,
  };

  const issueDate = new Date();
  const doc = DianDocumentSchema.parse({
    documentType: DocumentType.DOCUMENTO_SOPORTE,
    operationType: '10',
    environment: kit.config.environment,
    id: documentNumber,
    issueDate,
    issueTime: issueDate,
    currency: 'COP',
    supplier: buildCounterpartyData(seller, sale), // vendedor no obligado a facturar
    customer: buildSelfParty(cfg, tenant),          // tú, el adquirente que genera el documento
    lines: mapLines(items),
    taxTotals: buildDocumentTaxTotals(items),
    legalMonetaryTotal: buildLegalMonetaryTotal(items),
    paymentMeans: { paymentForm: '1', paymentMethod: '10' },
    // La DIAN exige el grupo InvoicePeriod en Documento Soporte (regla
    // DSFC01) -- se usa el mes calendario de la emisión, ya que no hay un
    // periodo de facturación real que declarar en este tipo de documento.
    period: {
      startDate: new Date(issueDate.getFullYear(), issueDate.getMonth(), 1),
      endDate: issueDate,
    },
    software: kit.config.software,
    numbering: kit.config.numbering,
  });

  // generateCufe(doc) de @dian-kit deriva nitOFE/numAdq de doc.supplier/doc.
  // customer TAL CUAL -- correcto para factura (donde supplier eres tú, el
  // Obligado a Facturar Electrónicamente), pero equivocado para Documento
  // Soporte: ahí supplier es el VENDEDOR (para que la DIAN vea los roles
  // correctos en el XML, reglas DSAB23/DSAJ25a), mientras que el CUDS debe
  // seguir calculándose con nitOFE = TÚ (quien genera el documento, el
  // verdadero obligado) y numAdq = el vendedor -- MEJOR ESFUERZO, no
  // verificado contra un envío aceptado por la DIAN (regla DSAD06).
  const cufeInput = {
    ...buildCufeInput(doc),
    nitOFE: doc.customer.identification.number,
    numAdq: doc.supplier.identification.number,
  };
  const uuid = sha384(concatenateCufeFields(cufeInput));
  const softwareSecurityCode = generateSoftwareSecurityCode(doc.software.id, doc.software.pin, doc.id);
  const providerDv = String(computeNitCheckDigit(doc.software.providerNit));
  let unsignedXml = buildInvoiceXml(doc, uuid, softwareSecurityCode)
    // addDianExtensions() de @dian-kit toma el DV del bloque SoftwareProvider
    // de doc.supplier.identification.dv -- correcto para factura (donde
    // supplier eres tú, normalmente el mismo NIT que el proveedor del
    // software), pero para Documento Soporte doc.supplier es el vendedor: el
    // DV que quedaba ahí era el del vendedor, no el del proveedor de
    // software real (regla DSAB22b -- "DV del NIT del Prestador de
    // Servicios no está correctamente calculado").
    .replace(
      /(<sts:ProviderID(?:\s+\w+="[^"]*")*?\s+schemeID=")[^"]*("(?:\s+\w+="[^"]*")*>)/,
      `$1${providerDv}$2`
    )
    .replace(/CUDE-SHA384/g, 'CUDS-SHA384')
    // @dian-kit no conoce el tipo 05: buildInvoiceXml cae al ProfileID
    // genérico de Factura Electrónica de Venta para cualquier documentType
    // que no reconoce (ver profileIdForDocumentType en su código fuente).
    // La DIAN exige el literal exacto de Documento Soporte (regla DSAD03).
    .replace(
      /<cbc:ProfileID>[^<]*<\/cbc:ProfileID>/,
      '<cbc:ProfileID>DIAN 2.1: documento soporte en adquisiciones efectuadas a no obligados a facturar.</cbc:ProfileID>'
    )
    // addLineNode() de @dian-kit no emite <cac:StandardItemIdentification>
    // en ningún tipo de documento -- la DIAN lo exige para Documento Soporte
    // (regla DSAZ09). Se usa el esquema "999" (numeración propia del
    // contribuyente), la convención estándar cuando no hay código UNSPSC
    // real -- MEJOR ESFUERZO, no verificado contra un envío aceptado.
    .replace(
      /<cbc:Description>[^<]*<\/cbc:Description>/g,
      m => `${m}<cac:StandardItemIdentification><cbc:ID schemeID="999" schemeName="Estándar de adopción del contribuyente">1</cbc:ID></cac:StandardItemIdentification>`
    );
  const { signedXml } = await signXml({
    xml: unsignedXml,
    certificate: kit.config.certificateData,
    signingTime: doc.issueDate,
  });

  return {
    xml: unsignedXml,
    signedXml,
    cufe: uuid,
    documentNumber: doc.id,
  };
}

/**
 * Envía un XML firmado a DIAN usando dian-kit.
 * Si hay test_set_id, usa SendTestSetAsync y hace polling con GetStatusZip.
 */
async function sendToDian(tenant, { signedXml, invoiceNumber, cufe, testSetId: testSetIdOverride }) {
  const cfg = tenant.dian_config || {};
  // Prioriza el test_set_id propio de la resolución (ej. una habilitación de
  // Documento Soporte separada de la de facturación) sobre el global — mismo
  // criterio que ya aplica a technical_key en createInvoice().
  const testSetId = testSetIdOverride || cfg.test_set_id;
  const isTest = cfg.environment !== 'production';

  // Si hay servicio DIAN remoto, usarlo
  const dianServiceUrl = process.env.DIAN_SERVICE_URL;
  if (dianServiceUrl) {
    return callRemoteDianService(dianServiceUrl, '/api/dian/send', {
      config: cfg,
      signedXml,
      invoiceNumber,
      cufe,
      method: isTest && testSetId ? 'SendTestSetAsync' : 'SendBillSync',
      testSetId,
    });
  }

  // Determinar método de envío
  const sendOptions = {};
  if (isTest && testSetId) {
    sendOptions.method = 'SendTestSetAsync';
    sendOptions.testSetId = testSetId;
  }

  const kit = getKit(tenant);
  const response = await kit.send({
    xml: signedXml,
    signedXml,
    uuid: cufe,
    documentNumber: invoiceNumber,
  }, sendOptions);

  // Para SendTestSetAsync, hacer polling con GetStatusZip hasta resultado final.
  if (isTest && testSetId && response.trackId) {
    logger.info(`[DIAN] ZipKey=${response.trackId} — haciendo polling GetStatusZip...`);

    // Esperar 10s antes del primer poll (DIAN necesita tiempo para procesar)
    await new Promise(r => setTimeout(r, 10000));

    for (let i = 0; i < 30; i++) {
      try {
        const statusResp = await kit.getStatusZip(response.trackId);
        const sc = statusResp.statusCode;
        const iv = statusResp.isValid;
        logger.info(`[DIAN] Poll ${i + 1}: statusCode=${sc} isValid=${iv}`);

        // statusCode 00 = éxito
        if (iv === true || iv === 'true' || sc === '00') {
          return {
            isValid: true,
            statusCode: sc || '00',
            statusDescription: statusResp.statusDescription || 'Aceptado',
            statusMessage: 'Documento aceptado por DIAN',
            trackId: response.trackId,
            errors: statusResp.errors || [],
            raw: JSON.stringify(statusResp),
          };
        }

        // Si statusCode es un código final (00, 66, etc.) — devolver
        if (sc && sc !== '99' && sc !== '0' && sc !== '') {
          return {
            isValid: iv === true || iv === 'true',
            statusCode: sc,
            statusDescription: statusResp.statusDescription || '',
            statusMessage: statusResp.statusDescription || '',
            trackId: response.trackId,
            errors: statusResp.errors || [],
            raw: JSON.stringify(statusResp),
          };
        }

        // Si rawResponse contiene IsValid>true, detectarlo
        const raw = statusResp.rawResponse || statusResp.raw || '';
        if (raw.includes('<b:IsValid>true</b:IsValid>') || raw.includes('<b:StatusCode>00</b:StatusCode>')) {
          return {
            isValid: true,
            statusCode: '00',
            statusDescription: 'Procesado Correctamente',
            statusMessage: 'Documento aceptado por DIAN',
            trackId: response.trackId,
            errors: [],
            raw: typeof statusResp.raw === 'string' ? statusResp.raw : JSON.stringify(statusResp),
          };
        }

      } catch (pollErr) {
        logger.warn(`[DIAN] Poll ${i + 1} error: ${pollErr.message}`);
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    // Timeout — devolver estado "en proceso" en vez de error
    logger.warn('[DIAN] Polling timeout — el documento fue enviado, verifique el portal DIAN');
    return {
      isValid: false,
      statusCode: 'PENDING',
      statusDescription: 'Documento enviado — verifique el portal DIAN para confirmar el estado',
      statusMessage: 'El documento fue enviado exitosamente a DIAN. El procesamiento puede tardar unos minutos.',
      trackId: response.trackId,
      errors: [],
      raw: JSON.stringify({ pending: true, trackId: response.trackId }),
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
    errors: response.errors || [],
    raw: JSON.stringify(response),
  };
}

/**
 * Parsea el XML crudo de GetNumberingRangeResponse.
 *
 * El parser de @dian-kit/core busca la etiqueta <NumberRange> con campos
 * AuthorizationNumber/StartDate/EndDate, pero la respuesta real de la DIAN
 * viene como <NumberRangeResponse> con ResolutionNumber/ValidDateFrom/
 * ValidDateTo/TechnicalKey — por eso `response.ranges` siempre salía vacío
 * aunque el XML crudo sí traía los datos. Se parsea acá directamente.
 */
function parseNumberingRanges(rawXml) {
  if (!rawXml) return [];
  try {
    const doc = new DOMParser().parseFromString(rawXml, 'text/xml');
    const nodes = doc.getElementsByTagNameNS('*', 'NumberRangeResponse');
    const ranges = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const field = (name) => {
        const el = node.getElementsByTagNameNS('*', name)[0];
        return el?.textContent?.trim() || '';
      };
      ranges.push({
        resolutionNumber: field('ResolutionNumber'),
        resolutionDate: field('ResolutionDate'),
        prefix: field('Prefix'),
        fromNumber: parseInt(field('FromNumber'), 10) || 0,
        toNumber: parseInt(field('ToNumber'), 10) || 0,
        validFrom: field('ValidDateFrom'),
        validTo: field('ValidDateTo'),
        technicalKey: field('TechnicalKey'),
      });
    }
    return ranges;
  } catch (e) {
    logger.warn('[DIAN] No se pudo parsear GetNumberingRangeResponse:', e.message);
    return [];
  }
}

/**
 * Consulta rangos de numeración autorizados en DIAN.
 * Usado para verificar conectividad y configuración.
 */
async function getNumberingRange(tenant) {
  const cfg = tenant.dian_config || {};

  // Si hay servicio DIAN remoto, usarlo (necesario porque la IP de Railway
  // no está en whitelist de la DIAN). OJO: el microservicio remoto reenvía
  // la respuesta cruda de la DIAN pero su propio `ranges` está
  // desactualizado (siempre vacío) y no trae `raw` -- se ignora su
  // `ranges`/forma de respuesta y se re-parsea `rawResponse` acá abajo con
  // la MISMA lógica que la ruta directa, en vez de confiar en ese campo.
  const dianServiceUrl = process.env.DIAN_SERVICE_URL;
  let response;
  if (dianServiceUrl) {
    const remote = await callRemoteDianService(dianServiceUrl, '/api/dian/get-numbering-range', {
      config: cfg,
    });
    response = { rawResponse: remote.rawResponse };
  } else {
    const kit = getKit(tenant);
    response = await kit.getNumberingRange();
  }

  // GetNumberingRange devuelve TODOS los rangos autorizados por la DIAN para
  // el NIT (factura, documento soporte, etc. — la respuesta no distingue el
  // tipo, solo trae prefijo/resolución), cada uno con su propia llave
  // técnica vigente. Hay que emparejar cada rango con SU resolución local
  // (por prefijo/número) para comparar y, si aplica, guardar la llave contra
  // el technical_key de ESA resolución — no siempre es el de facturación
  // global. Sin este cruce, "Usar esta llave técnica" en el rango de
  // Documento Soporte terminaría sobrescribiendo la llave de facturación.
  const { DianResolution } = require('../../models');
  const resolutions = await DianResolution.findAll({ where: { tenant_id: tenant.id } });
  const norm = (s) => (s == null ? '' : String(s).trim().toUpperCase());

  const ranges = parseNumberingRanges(response.rawResponse).map(r => {
    const matched = resolutions.find(res =>
      norm(res.prefix) === norm(r.prefix) &&
      (!res.resolution_number || norm(res.resolution_number) === norm(r.resolutionNumber))
    );
    const effectiveKey = matched?.technical_key || cfg.technical_key;
    return {
      ...r,
      matchedResolutionId: matched?.id || null,
      matchedDocumentType: matched?.document_type || null,
      technicalKeyMatches: !!effectiveKey && r.technicalKey === effectiveKey,
    };
  });

  return {
    isValid: response.isValid,
    statusCode: response.statusCode,
    statusDescription: response.statusDescription,
    statusMessage: response.statusDescription,
    isFault: !response.isValid && !!response.statusCode,
    raw: JSON.stringify(response),
    ranges,
  };
}

/**
 * Llama al servicio DIAN remoto (Hostinger)
 */
async function callRemoteDianService(baseUrl, path, body) {
  const apiKey = process.env.DIAN_API_KEY || 'pitbox-dian-2026';
  const url = `${baseUrl}${path}`;

  logger.info(`[DIAN Proxy] → ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DIAN Service error ${response.status}: ${err}`);
  }

  return response.json();
}

module.exports = {
  getKit,
  invalidateKit,
  createInvoice,
  createSupportDocument,
  sendToDian,
  getStatusByCufe,
  getNumberingRange,
  mapLines,
  buildDocumentTaxTotals,
  parseDateCol,
};
