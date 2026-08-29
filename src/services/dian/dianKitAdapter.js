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
// Divide un nombre completo en FirstName/FamilyName para el grupo cac:Person
// que la DIAN exige para personas naturales (confirmado contra el ejemplo
// oficial "Ejemplificacion Muestras Gratis.xml" de la Caja de Herramientas
// FE: <cac:Person><cbc:FirstName>...</cbc:FirstName></cac:Person>, además
// del <cbc:AdditionalAccountID>2</cbc:AdditionalAccountID> -- ver más abajo).
// Heurística simple (sin captura de nombre/apellido por separado en el
// modelo actual de Supplier/Customer): la última palabra es el apellido, el
// resto el nombre. Si no hay más de una palabra, se repite -- @dian-kit
// exige ambos campos no vacíos.
function splitPersonName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'N/A', familyName: 'N/A' };
  if (parts.length === 1) return { firstName: parts[0], familyName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), familyName: parts[parts.length - 1] };
}

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
    // La regla DSAJ08a exige, entre otros, el elemento PostalZone dentro de
    // cac:PhysicalLocation/cac:Address del vendedor de un Documento Soporte
    // -- @dian-kit solo lo emite si `address.postalZone` viene informado
    // (antes nunca se pasaba, así que el grupo quedaba incompleto). No hay
    // tabla de códigos postales reales en el sistema (Supplier/Customer no
    // capturan ese dato) -- MEJOR ESFUERZO: se deriva del código DIVIPOLA de
    // 5 dígitos con un dígito de relleno para cumplir la estructura de 6
    // dígitos que exige el código postal colombiano (la regla solo valida
    // "estructura", no que corresponda a una tabla real de códigos postales).
    postalZone: counterparty?.postalZone || sale?.customer_postal_code || `${cityCode}0`,
  };
  const schemeID = counterparty?.schemeID || sale?.customer_document_type || '31';
  const name = counterparty?.name || sale?.customer_name || 'Consumidor Final';
  // DocumentType.NIT ("31") es el único tipo de identificación exclusivo de
  // persona jurídica en la tabla 13.2.1 de la DIAN -- cualquier otro (13
  // cédula, 22 cédula extranjería, 41 pasaporte, etc.) es persona natural.
  // AdditionalAccountID (tabla 13.2.3) y el grupo cac:Person dependen de
  // esto -- antes quedaba fijo en personType '1' (jurídica) sin importar el
  // tipo real, lo que la DIAN rechaza para un vendedor persona natural
  // (reglas DSAJ08a/DSFC03: "conjunto de elementos" y "código" incorrectos
  // según la procedencia del vendedor).
  const isNatural = schemeID !== '31';
  const personType = isNatural ? '2' : '1';

  return {
    name,
    identification: {
      number: cleanId(counterparty?.nit || sale?.customer_tax_id) || '13832081',
      type: schemeID,
      dv: cleanId(counterparty?.dv) || '0',
    },
    personType,
    ...(isNatural && { person: splitPersonName(name) }),
    fiscalResponsibilities: [mapFiscalResponsibility(counterparty?.regimeCode || counterparty?.taxLevelCode || 'R-99-PN')],
    taxInfo: {
      registrationName: name,
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

/**
 * Reduce el <cac:AccountingSupplierParty> (vendedor) generado por
 * @dian-kit -- pensado para un Party de factura estándar (PartyIdentification
 * + PartyName + PartyTaxScheme + PartyLegalEntity + Contact/Person) -- a la
 * estructura MÍNIMA que exige la DIAN para el vendedor de un Documento
 * Soporte: solo AdditionalAccountID, PhysicalLocation y PartyTaxScheme
 * (RegistrationName/CompanyID/TaxLevelCode/TaxScheme). Confirmado contra los
 * ejemplos oficiales "DocumentoSoporte-OperacionConResidente.xml" y
 * "NotaDeAjuste.xml" de la Caja de Herramientas Documento Soporte -- ningún
 * PartyIdentification/PartyName/PartyLegalEntity/Contact/Person aparece ahí
 * (regla DSAJ08a: "no fue informado el conjunto de elementos correctos de
 * acuerdo a la procedencia del vendedor" -- @dian-kit informa DE MÁS, no de
 * menos). El TaxScheme también se fuerza a ZZ/"No aplica" -- el vendedor no
 * obligado a facturar no tiene por qué estar registrado bajo el régimen de
 * IVA (01) que sí usamos para el propio OFE.
 */
function simplifySupplierParty(xml) {
  const block = xml.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/);
  if (!block) return xml;
  const src = block[0];
  const additionalAccountId = (src.match(/<cbc:AdditionalAccountID>([^<]*)<\/cbc:AdditionalAccountID>/) || [])[1] || '1';
  const physicalLocation = (src.match(/<cac:PhysicalLocation>[\s\S]*?<\/cac:PhysicalLocation>/) || [])[0] || '';
  const registrationName = (src.match(/<cbc:RegistrationName>([^<]*)<\/cbc:RegistrationName>/) || [])[0] || '';
  // La regla DSAJ25a exige que @schemeName sea SIEMPRE literal "31" en este
  // campo específico para Documento Soporte, sin importar el tipo de
  // documento real del vendedor (persona natural incluida) -- confirmado
  // contra el ejemplo oficial "DocumentoSoporte-OperacionConResidente.xml",
  // que lo deja fijo en "31". @dian-kit arma schemeName con el tipo real
  // (buildCounterpartyData -> party.identification.type, p.ej. "13" para
  // cédula) porque asume el Party genérico de factura -- se fuerza acá,
  // mismo patrón que ya se usa para <sts:ProviderID> más abajo.
  const companyIdMatch = (src.match(/<cbc:CompanyID[^>]*>[^<]*<\/cbc:CompanyID>/) || [])[0] || '';
  const companyId = companyIdMatch.replace(/schemeName="[^"]*"/, 'schemeName="31"');
  const taxLevelCode = (src.match(/<cbc:TaxLevelCode[^>]*>[^<]*<\/cbc:TaxLevelCode>/) || [])[0] || '';

  const rebuilt = `<cac:AccountingSupplierParty>` +
    `<cbc:AdditionalAccountID>${additionalAccountId}</cbc:AdditionalAccountID>` +
    `<cac:Party>${physicalLocation}` +
    `<cac:PartyTaxScheme>${registrationName}${companyId}${taxLevelCode}` +
    `<cac:TaxScheme><cbc:ID>ZZ</cbc:ID><cbc:Name>No aplica</cbc:Name></cac:TaxScheme>` +
    `</cac:PartyTaxScheme>` +
    `</cac:Party></cac:AccountingSupplierParty>`;

  return xml.replace(src, rebuilt);
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
 * Construye el fragmento XML de `cac:WithholdingTaxTotal` para las
 * retenciones (ReteFuente/ReteIVA/ReteICA) de un Documento Soporte.
 *
 * @dian-kit/core v1.0.1 no tiene NINGÚN soporte para WithholdingTaxTotal
 * (no aparece en su schema ni en su builder de XML) — a diferencia del CUDS
 * o el ProfileID, esto no es un bug puntual de la librería sino una
 * ausencia total, ni siquiera para factura (Sale ya tiene las columnas
 * retefuente_rate/amount desde Fase C pero nunca se envían a la DIAN). Se
 * inyecta como fragmento de texto en el XML sin firmar, mismo mecanismo que
 * ya usa createSupportDocument() para CUDS/ProfileID/StandardItemIdentification.
 *
 * Reutiliza la MISMA estructura (TaxSubtotal > TaxableAmount, TaxAmount,
 * TaxCategory > Percent, TaxScheme > ID, Name) que @dian-kit ya genera para
 * cac:TaxTotal — WithholdingTaxTotal es el mismo tipo UBL, solo cambia el
 * nombre del contenedor. IDs/Name de TaxScheme tomados literal del propio
 * TaxCodeName que exporta @dian-kit ('05' ReteIVA, '06' ReteRenta/ReteFuente,
 * '07' ReteICA).
 *
 * Base gravable: ReteFuente y ReteICA se calculan sobre la base gravable del
 * documento (subtotal); ReteIVA se calcula sobre el IVA generado, no sobre
 * el subtotal (regla estándar colombiana) -- MEJOR ESFUERZO, no verificado
 * contra un envío aceptado por la DIAN, igual que el resto de esta
 * implementación. Validar en habilitación con un caso que sí tenga
 * retención antes de dar esto por cerrado.
 *
 * `payableAmount` en LegalMonetaryTotal NO se reduce por la retención: se
 * deja el total bruto (mismo criterio que un Invoice UBL estándar, donde
 * WithholdingTaxTotal es informativo/declarativo y no altera el valor legal
 * del documento) -- también sin verificar contra un envío real.
 */
function buildWithholdingTaxTotals({ subtotal, taxAmount, retefuente_rate, retefuente_amount, reteiva_rate, reteiva_amount, reteica_rate, reteica_amount } = {}) {
  const { formatAmount, formatPercent, TaxCodeName } = require('@dian-kit/core');

  const rows = [
    { code: '06', base: Number(subtotal || 0), rate: Number(retefuente_rate || 0), amount: Number(retefuente_amount || 0) },
    { code: '05', base: Number(taxAmount || 0), rate: Number(reteiva_rate || 0), amount: Number(reteiva_amount || 0) },
    { code: '07', base: Number(subtotal || 0), rate: Number(reteica_rate || 0), amount: Number(reteica_amount || 0) },
  ].filter(r => r.amount > 0);

  if (rows.length === 0) return '';

  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  const subtotalsXml = rows.map(r => `<cac:TaxSubtotal>` +
    `<cbc:TaxableAmount currencyID="COP">${formatAmount(r.base)}</cbc:TaxableAmount>` +
    `<cbc:TaxAmount currencyID="COP">${formatAmount(r.amount)}</cbc:TaxAmount>` +
    `<cac:TaxCategory>` +
    `<cbc:Percent>${formatPercent(r.rate)}</cbc:Percent>` +
    `<cac:TaxScheme>` +
    `<cbc:ID>${r.code}</cbc:ID>` +
    `<cbc:Name>${TaxCodeName[r.code]}</cbc:Name>` +
    `</cac:TaxScheme>` +
    `</cac:TaxCategory>` +
    `</cac:TaxSubtotal>`
  ).join('');

  return `<cac:WithholdingTaxTotal>` +
    `<cbc:TaxAmount currencyID="COP">${formatAmount(totalAmount)}</cbc:TaxAmount>` +
    subtotalsXml +
    `</cac:WithholdingTaxTotal>`;
}

/**
 * Calcula el CUDS (Código Único de Documento Soporte) según la fórmula EXACTA
 * del Anexo Técnico de Documento Soporte (Resolución 000167 de 2021, numeral
 * 14.1.1.1 y 14.1.1.3):
 *
 *   CUDS = SHA-384(NumDS + FecDS + HorDS + ValDS + CodImp + ValImp + ValTot +
 *                   NumSNO + NITABS + Software-PIN + TipoAmbiente)
 *
 * Confirmado contra el numeral 14.1.1.3 (XPath de cada campo): NumSNO viene
 * de /Invoice/cac:AccountingSupplierParty/.../cbc:CompanyID (el VENDEDOR,
 * doc.supplier acá) y NITABS de /Invoice/cac:AccountingCustomerParty/.../
 * cbc:CompanyID (TÚ, el adquirente, doc.customer acá) -- en ESE orden. La
 * versión anterior de este código invertía nitOFE/numAdq asumiendo que el
 * primer campo de identificación debía ser TÚ ("el verdadero obligado") --
 * exactamente al revés de lo que dice el Anexo -- y además reutilizaba
 * @dian-kit/core#buildCufeInput/concatenateCufeFields (pensado para el CUFE
 * de factura), que difiere del CUDS en dos puntos más, ambos causa directa
 * de la regla DSAD06 ("Valor del CUDS no está calculado correctamente"):
 *   1) el Anexo exige un ÚNICO par CodImp/ValImp -- CodImp fijo "01", ValImp
 *      = la suma del IVA (0.00 si no hay IVA) -- mientras que buildCufeInput
 *      concatena TRES pares (IVA/INC/ICA) como hace el CUFE de factura.
 *   2) el Anexo exige el PIN del software (Software-PIN, numeral 14.1.1.2:
 *      "no está en el XML") como secreto, NO la clave técnica de la
 *      resolución -- buildCufeInput usa la clave técnica para cualquier tipo
 *      de documento en su set CUFE_DOCUMENTS, que incluye (incorrectamente
 *      para este propósito) a DOCUMENTO_SOPORTE.
 *
 * ValDS/ValTot sí coinciden con los campos que ya arma buildLegalMonetaryTotal
 * (lineExtensionAmount/payableAmount) -- ese pedazo del cálculo anterior era
 * correcto por coincidir con el propio formato del CUFE genérico.
 */
function computeCuds(doc, cfg) {
  const { formatDate, formatTime, truncateDecimals, sha384 } = require('@dian-kit/core');

  const ivaAmount = doc.taxTotals
    .filter(tt => tt.subtotals.some(s => s.taxScheme.code === '01'))
    .reduce((sum, tt) => sum + tt.taxAmount, 0);

  const raw = [
    doc.id,
    formatDate(doc.issueDate),
    formatTime(doc.issueTime),
    truncateDecimals(doc.legalMonetaryTotal.lineExtensionAmount, 2),
    '01',
    truncateDecimals(ivaAmount, 2),
    truncateDecimals(doc.legalMonetaryTotal.payableAmount, 2),
    doc.supplier.identification.number,
    doc.customer.identification.number,
    cfg.software_pin,
    doc.environment,
  ].join('');

  return sha384(raw);
}

/**
 * Party del vendedor (AccountingSupplierParty) de un Documento Soporte, a
 * partir de un Supplier real. Requiere que ya haya pasado
 * supplierDianReadiness.assertReadiness() -- acá no se valida completitud,
 * solo se mapea.
 *
 * schemeID: '13' (cédula) para persona natural, '31' (NIT) para jurídica --
 * mismo criterio que usa el resto del sistema para person_type. Si
 * Supplier.document_type viene explícito (captura manual), tiene prioridad.
 */
function buildSellerFromSupplier(supplier) {
  const { resolveCity } = require('../../data/divipola-colombia');
  const schemeID = supplier.document_type || (supplier.person_type === 'natural' ? '13' : '31');
  const resolved = supplier.city_code ? resolveCity(supplier.city_code) : null;

  return {
    name: supplier.business_name || supplier.name,
    nit: supplier.tax_id,
    // Siempre se calcula un DV real, sin importar el tipo de documento del
    // vendedor: el Anexo Técnico (regla DSAJ25a) exige que el
    // cac:PartyTaxScheme/cbc:CompanyID/@schemeName del vendedor sea SIEMPRE
    // literal "31" en Documento Soporte (confirmado contra el ejemplo
    // oficial DocumentoSoporte-OperacionConResidente.xml, que lo deja fijo
    // en "31" aunque el vendedor sea persona natural) -- y esa misma regla
    // exige que, cuando @schemeName es "31", el DV (@schemeID) esté
    // informado y sea correcto. Antes solo se calculaba para schemeID==='31'
    // (persona jurídica), dejando el DV vacío/'0' para personas naturales.
    dv: String(computeNitCheckDigit(supplier.tax_id)),
    schemeID,
    cityCode: supplier.city_code,
    city: resolved?.cityName || supplier.city,
    dept: resolved?.departmentName,
    address: supplier.address,
    email: supplier.email,
    regimeCode: Array.isArray(supplier.fiscal_responsibilities) ? supplier.fiscal_responsibilities[0] : undefined,
  };
}

/**
 * Igual que buildSellerFromSupplier pero a partir de los datos capturados
 * ad-hoc en el modal de generación de Documento Soporte de un gasto sin
 * Supplier asociado (decisión del usuario: se permite capturar sin crear
 * la ficha, con opción de crearla después con esos mismos datos). El objeto
 * ya debe haber pasado supplierDianReadiness.assertReadiness() en el
 * controller antes de llegar acá.
 */
function buildSellerFromAdHoc(adHoc) {
  const { resolveCity } = require('../../data/divipola-colombia');
  const schemeID = adHoc.document_type || (adHoc.person_type === 'natural' ? '13' : '31');
  const resolved = adHoc.city_code ? resolveCity(adHoc.city_code) : null;

  return {
    name: adHoc.name,
    nit: adHoc.tax_id,
    // Ver comentario en buildSellerFromSupplier() -- mismo criterio: DV real
    // siempre, sin importar el tipo de documento (regla DSAJ25a).
    dv: String(computeNitCheckDigit(adHoc.tax_id)),
    schemeID,
    cityCode: adHoc.city_code,
    city: resolved?.cityName || adHoc.city,
    dept: resolved?.departmentName,
    address: adHoc.address,
    email: adHoc.email,
    regimeCode: adHoc.regimeCode,
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
 *
 * `retentions` (opcional, Fase 2): { retefuente_rate, retefuente_amount,
 * reteiva_rate, reteiva_amount, reteica_rate, reteica_amount } tal cual
 * vienen de Purchase o Expense -- ver buildWithholdingTaxTotals() arriba.
 * Parámetro nuevo y opcional: no cambia el comportamiento de
 * dianAutoTestService.js, que no lo pasa.
 */
async function createSupportDocument(tenant, { documentNumber, items, resolution, seller, sale, retentions }) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};
  const {
    buildInvoiceXml, formatDate,
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
    // El grupo InvoicePeriod (regla DSFC01) NO va a nivel de encabezado --
    // @dian-kit solo sabe emitirlo ahí (vía este campo `period`), pero el
    // Anexo Técnico lo exige DENTRO DE CADA InvoiceLine (XPath
    // /Invoice/cac:InvoiceLine/cac:InvoicePeriod, confirmado contra el
    // ejemplo oficial DocumentoSoporte-OperacionConResidente.xml, que no
    // trae ningún InvoicePeriod de encabezado). Se omite acá a propósito y
    // se inyecta por línea más abajo, después de generar el XML.
    software: kit.config.software,
    numbering: kit.config.numbering,
  });

  const uuid = computeCuds(doc, cfg);
  const softwareSecurityCode = generateSoftwareSecurityCode(doc.software.id, doc.software.pin, doc.id);
  const providerDv = String(computeNitCheckDigit(doc.software.providerNit));
  let unsignedXml = buildInvoiceXml(doc, uuid, softwareSecurityCode)
    // addDianExtensions() de @dian-kit arma <sts:ProviderID> tomando
    // schemeID de doc.supplier.identification.dv y schemeName de
    // doc.supplier.identification.type -- correcto "por accidente" para
    // factura (donde supplier eres tú), incorrecto para Documento Soporte
    // (doc.supplier es el VENDEDOR). OJO: el ejemplo oficial "Generica.xml"
    // de la Caja de Herramientas FE (Resolución 000165, Factura) usa
    // schemeID="4" fijo, pero esa toolbox NO es la de Documento Soporte
    // (Resolución 000167) -- el propio comentario original de este archivo
    // (antes de tocarlo) ya citaba la regla DSAB22b ("DV del NIT del
    // Prestador de Servicios no está correctamente calculado"), señal de
    // que YA se había visto ese rechazo real en habilitación y se corrigió
    // calculando el DV real -- confirmado again al reintroducir "4" acá:
    // DSAB22b reapareció. Para Documento Soporte, schemeID debe ser el DV
    // real de doc.software.providerNit; schemeName sí debe ser "31" fijo
    // (ese cambio sí eliminó DSAB23 en un envío real).
    .replace(
      /<sts:ProviderID([^>]*)>/,
      (m, attrs) => `<sts:ProviderID${attrs.replace(/schemeID="[^"]*"/, `schemeID="${providerDv}"`).replace(/schemeName="[^"]*"/, 'schemeName="31"')}>`
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
    )
    // Retenciones (ReteFuente/ReteIVA/ReteICA) -- ver buildWithholdingTaxTotals()
    // arriba. UBL exige que WithholdingTaxTotal vaya después de TaxTotal y
    // antes de LegalMonetaryTotal; no-op (string vacío) cuando no hay
    // retención que declarar, así que no afecta a dianAutoTestService.js.
    .replace(
      '<cac:LegalMonetaryTotal>',
      buildWithholdingTaxTotals(retentions) + '<cac:LegalMonetaryTotal>'
    )
    // El grupo InvoicePeriod (regla DSFC01) va DENTRO DE CADA InvoiceLine,
    // justo después de LineExtensionAmount -- confirmado contra el ejemplo
    // oficial "DocumentoSoporte-OperacionConResidente.xml" (que no trae
    // ningún InvoicePeriod de encabezado, solo uno por línea). @dian-kit no
    // tiene forma de emitirlo ahí, así que se inyecta por línea con /g --
    // antes se inyectaba una sola vez a nivel de encabezado (vía doc.period
    // arriba), que la DIAN no reconoce como el grupo exigido y seguía
    // rechazando por DSFC01/DSFC02/DSFC03 aunque el grupo existiera en el
    // XML. StartDate = fecha de emisión (debe coincidir con SigningTime,
    // regla DSFC02b); DescriptionCode "1"/"Por operación" = tabla 16.1.6.
    .replace(
      /(<cac:InvoiceLine>[\s\S]*?<cbc:LineExtensionAmount[^>]*>[^<]*<\/cbc:LineExtensionAmount>)/g,
      `$1<cac:InvoicePeriod><cbc:StartDate>${formatDate(issueDate)}</cbc:StartDate><cbc:DescriptionCode>1</cbc:DescriptionCode><cbc:Description>Por operación</cbc:Description></cac:InvoicePeriod>`
    );
  // Reduce el vendedor al set mínimo de elementos que exige la DIAN para
  // Documento Soporte -- ver comentario de simplifySupplierParty() arriba.
  unsignedXml = simplifySupplierParty(unsignedXml);
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
 * Nota de Ajuste al Documento Soporte — tipo DIAN 95 (Resolución 000167 de
 * 2021, art. 17: "documento electrónico ... por el cual se realizan ajustes
 * al documento soporte, por errores aritméticos o de contenido"). No es
 * nota crédito/débito de factura (tipos 91/92) ni nota de ajuste de
 * documento equivalente (tipos 93/94, que sí trae @dian-kit en su enum
 * DocumentType) — es un tipo propio que la librería no conoce.
 *
 * FASE 5 — corregido contra el Anexo Técnico oficial (Resolución 000167 de
 * 2021, §6.1.2, §8.2, §10.3.1), que la Fase 4 no había podido consultar
 * directamente: el Anexo dice explícitamente que la Nota de Ajuste al
 * Documento Soporte usa **root `<CreditNote>`** (no `<Invoice>` como asumía
 * la Fase 4) — el DS mismo es "Invoice (Invoic5)" pero su Nota de Ajuste es
 * "CreditNote", con `CreditNoteLine`/`CreditedQuantity`/`CreditNoteTypeCode`,
 * igual para el caso crédito Y el caso débito (a diferencia de NC/ND de
 * factura, para la Nota de Ajuste al Documento Soporte NO existe un root
 * `DebitNote` — el propio Anexo solo define tres documentos XML para toda
 * esta familia: Invoice, CreditNote y ApplicationResponse). Confirmado
 * también por una fuente de integración (TOTVS/Protheus DT de Nota de
 * Ajuste para Documento Soporte COL), que arma
 * `<cbc:CreditNoteTypeCode>95</cbc:CreditNoteTypeCode>` para ambos casos.
 *
 * Para lograr ese root con @dian-kit (que tampoco conoce "95" — mismo
 * problema que "05" con el Documento Soporte) se usa
 * DocumentType.NOTA_AJUSTE_CREDITO_DOC_EQUIV ("94") como placeholder en vez
 * de DOCUMENTO_SOPORTE ("05"): "94" sí es un valor válido de su schema Y
 * cae dentro del set CREDIT_NOTE_DOCUMENTS que usa `getDocumentConfig()`
 * internamente (visto en el código fuente de @dian-kit/core@1.0.1) para
 * decidir root/línea/campo de cantidad — con "94" como placeholder,
 * `buildCreditNoteXml()` ya arma root `<CreditNote>`,
 * `<cac:CreditNoteLine>`/`<cbc:CreditedQuantity>` sin ningún parche de texto,
 * y solo queda reemplazar el código de tipo "94"→"95" (mismo patrón de
 * placeholder-y-reemplazo que ya usaba la Fase 4, pero apuntando al
 * builder/placeholder correctos en vez de Invoice/"05").
 *
 * También corregido: la referencia al Documento Soporte original
 * (`BillingReference/InvoiceDocumentReference/cbc:UUID`) queda con
 * `@schemeName="CUFE-SHA384"` porque @dian-kit lo deja fijo así en su
 * builder (pensado para cuando una Nota Crédito de factura referencia una
 * factura real, identificada por CUFE) — pero el Documento Soporte que
 * referenciamos tiene CUDS, no CUFE, así que se corrige ese atributo
 * también (mismo criterio que ya se aplica al UUID del documento principal).
 *
 * `discrepancyResponse` ahora solo se emite para ajustes tipo **débito**:
 * la Fase 4 lo emitía para crédito y débito por igual "hasta ver qué
 * rechaza el set de habilitación" — una fuente de integración (comentario
 * de código fuente Protheus/TOTVS, `// DiscrepancyResponse Solo para la
 * Nota de Débito`) confirma que para esta familia de documento
 * específicamente el grupo es exclusivo de la Nota de Débito; se aplica ya
 * ese criterio en vez de esperar el rechazo.
 *
 * Sigue MEJOR ESFUERZO, no verificado contra un envío aceptado por la DIAN:
 * - El texto exacto del ProfileID para tipo 95 sigue sin confirmar contra
 *   la tabla de reglas de la sección 8.2 del Anexo (no se pudo acceder al
 *   contenido completo de esa sección, solo a su encabezado e índice) — se
 *   mantiene el literal de la Fase 4 como mejor esfuerzo. Validar en el
 *   primer envío al set de habilitación.
 * - Roles supplier/customer invertidos y fix CUDS-SHA384/
 *   StandardItemIdentification: igual que createSupportDocument(), sin
 *   cambios en esta fase.
 *
 * @param {object} original - { number, cuds, issueDate } del SupportDocument
 *   que se está ajustando (support_document_number/cuds/dian_accepted_at).
 * @param {'credit'|'debit'} adjustmentType
 */
async function createSupportDocumentAdjustment(tenant, {
  documentNumber, items, resolution, seller, retentions, adjustmentType, reason, original,
}) {
  const kit = getKit(tenant);
  const cfg = tenant.dian_config || {};
  const {
    buildCreditNoteXml,
    generateSoftwareSecurityCode, signXml, DianDocumentSchema, DocumentType,
  } = require('@dian-kit/core');

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
    // Placeholder schema-válido que SÍ cae en el set CREDIT_NOTE_DOCUMENTS
    // de @dian-kit (root CreditNote) -- se corrige a "95" abajo. Ver nota
    // arriba: DOCUMENTO_SOPORTE ("05") de la Fase 4 producía root Invoice,
    // que el Anexo Técnico no contempla para la Nota de Ajuste.
    documentType: DocumentType.NOTA_AJUSTE_CREDITO_DOC_EQUIV,
    operationType: '10',
    environment: kit.config.environment,
    id: documentNumber,
    issueDate,
    issueTime: issueDate,
    currency: 'COP',
    supplier: buildCounterpartyData(seller),
    customer: buildSelfParty(cfg, tenant),
    lines: mapLines(items),
    taxTotals: buildDocumentTaxTotals(items),
    legalMonetaryTotal: buildLegalMonetaryTotal(items),
    paymentMeans: { paymentForm: '1', paymentMethod: '10' },
    // Sin InvoicePeriod -- confirmado contra el ejemplo oficial
    // "NotaDeAjuste.xml" de la Caja de Herramientas Documento Soporte: la
    // Nota de Ajuste no trae ese grupo (a diferencia del Documento Soporte
    // original, que sí lo exige con otro formato -- ver createSupportDocument()).
    // Referencia al Documento Soporte original.
    billingReference: {
      id: original.number,
      uuid: original.cuds,
      issueDate: new Date(original.issueDate),
    },
    // Solo para débito -- ver nota de fase arriba (confirmado contra fuente
    // de integración: el grupo es exclusivo de la Nota de Débito para esta
    // familia de documento).
    ...(adjustmentType === 'debit' ? {
      discrepancyResponse: {
        referenceId: original.number,
        responseCode: '1',
        description: reason || 'Nota de ajuste - débito',
      },
    } : {}),
    software: kit.config.software,
    numbering: kit.config.numbering,
  });

  // Mismo cálculo de CUDS que createSupportDocument() -- ver computeCuds()
  // arriba. El Anexo Técnico (numeral 14.1.1.4) usa exactamente la misma
  // fórmula/orden de campos para la Nota de Ajuste que para el Documento
  // Soporte original, solo con XPath bajo /CreditNote en vez de /Invoice.
  const uuid = computeCuds(doc, cfg);
  const softwareSecurityCode = generateSoftwareSecurityCode(doc.software.id, doc.software.pin, doc.id);
  const providerDv = String(computeNitCheckDigit(doc.software.providerNit));
  let unsignedXml = buildCreditNoteXml(doc, uuid, softwareSecurityCode)
    // Mismo fix que createSupportDocument() -- ver comentario ahí. schemeID
    // = DV real (no "4" del ejemplo de Factura, que es otra resolución);
    // schemeName = "31" fijo.
    .replace(
      /<sts:ProviderID([^>]*)>/,
      (m, attrs) => `<sts:ProviderID${attrs.replace(/schemeID="[^"]*"/, `schemeID="${providerDv}"`).replace(/schemeName="[^"]*"/, 'schemeName="31"')}>`
    )
    .replace(/CUDE-SHA384/g, 'CUDS-SHA384')
    // El UUID del Documento Soporte referenciado en BillingReference es un
    // CUDS, no un CUFE -- @dian-kit deja ese atributo fijo en "CUFE-SHA384"
    // (pensado para NC de factura referenciando una factura real).
    .replace(
      /(<cac:BillingReference>[\s\S]*?<cbc:UUID schemeName=")CUFE-SHA384("[\s\S]*?<\/cac:BillingReference>)/,
      '$1CUDS-SHA384$2'
    )
    // Código de tipo de documento: "94" (placeholder schema-válido para
    // @dian-kit, ver nota arriba) → "95" (Nota de Ajuste al Documento
    // Soporte, real ante la DIAN). Además, el NOMBRE de la etiqueta -- no
    // solo el valor -- también hay que corregirlo: @dian-kit usa
    // <cbc:CreditNoteTypeCode> para cualquier root CreditNote (config.
    // typeCodeTag), pero el ejemplo oficial "NotaDeAjuste.xml" de la Caja
    // de Herramientas Documento Soporte usa <cbc:InvoiceTypeCode>95</...>
    // incluso con root CreditNote -- una particularidad de este tipo de
    // documento específico, no del estándar UBL CreditNote genérico.
    .replace(
      /<cbc:CreditNoteTypeCode>94<\/cbc:CreditNoteTypeCode>/,
      '<cbc:InvoiceTypeCode>95</cbc:InvoiceTypeCode>'
    )
    .replace(
      /<cbc:ProfileID>[^<]*<\/cbc:ProfileID>/,
      // Texto literal exacto tomado del ejemplo oficial "NotaDeAjuste.xml"
      // -- nuestra redacción anterior ("no obligados a facturar") no
      // coincidía con la oficial (regla DSFC03: "código no corresponde de
      // acuerdo a tabla de referencia" -- el ProfileID es justamente una
      // de esas tablas).
      '<cbc:ProfileID>DIAN 2.1: Nota de ajuste al documento soporte en adquisiciones efectuadas a sujetos no obligados a expedir factura o documento equivalente </cbc:ProfileID>'
    )
    .replace(
      /<cbc:Description>[^<]*<\/cbc:Description>/g,
      m => `${m}<cac:StandardItemIdentification><cbc:ID schemeID="999" schemeName="Estándar de adopción del contribuyente">1</cbc:ID></cac:StandardItemIdentification>`
    )
    .replace(
      '<cac:LegalMonetaryTotal>',
      buildWithholdingTaxTotals(retentions) + '<cac:LegalMonetaryTotal>'
    );
  unsignedXml = simplifySupplierParty(unsignedXml);

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
  createSupportDocumentAdjustment,
  sendToDian,
  getStatusByCufe,
  getNumberingRange,
  mapLines,
  buildDocumentTaxTotals,
  buildWithholdingTaxTotals,
  buildSellerFromSupplier,
  buildSellerFromAdHoc,
  computeNitCheckDigit,
  parseDateCol,
};
