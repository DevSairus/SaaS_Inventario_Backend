// backend/src/services/dian/payrollDianAdapter.js
/**
 * Firma y envío del Documento Soporte de Pago de Nómina Electrónica.
 *
 * Envío: numeral 9 del Anexo Técnico (Resolución 000013/2021) — Nómina
 * Electrónica usa EL MISMO servicio web WCF que ya está integrado para
 * Factura Electrónica en dianApiService.js (WcfDianCustomerServices, mismo
 * host vpfe-hab.dian.gov.co / vpfe.dian.gov.co, mismo WS-Security X.509 vía
 * dianWssSigner.js#buildSignedEnvelope). La única diferencia es la
 * operación (SendNominaSync en vez de SendBillSync) — ya agregada a
 * dianApiService.js#sendNominaSync(), reutilizada tal cual aquí.
 *
 * GetStatus (consulta de estado por CUNE) NO necesita nada nuevo — el
 * propio Anexo dice que la operación existente "se modifica para incluir
 * la consulta de Documentos Soporte de Pago de Nómina Electrónica". Usar
 * dianApiService.js#getStatus() pasando el CUNE donde antes iba el CUFE.
 *
 * Firma: el numeral 9.3 exige explícitamente que la SECCIÓN DE FIRMADO use
 * UBL 2.1 (aunque el resto del documento sea el esquema propio de nómina) —
 * por eso tiene sentido reusar signXml() de @dian-kit/core, que ya sabe
 * construir/inyectar una firma XAdES-BES dentro de un contenedor
 * <ext:UBLExtensions>.
 *
 * ⚠️ RIESGO NO VERIFICADO: signXml() fue probado por este proyecto solo
 * contra raíces <Invoice>/<CreditNote> (ver createInvoice(),
 * createSupportDocument() en dianKitAdapter.js) — no hay evidencia de que
 * localice el contenedor de extensión correctamente dentro de una raíz
 * <NominaIndividual>, que no es UBL. signPayrollXml() más abajo incluye una
 * verificación mínima post-firma para detectar esto temprano. Si falla, la
 * alternativa de respaldo es adaptar la construcción de firma XAdES manual
 * que ya existe en dianWssSigner.js (firma un elemento XML a mano con
 * node-forge — más bajo nivel, pero agnóstico a qué raíz se firme).
 */
'use strict';

const { signXml } = require('@dian-kit/core');
const logger = require('../../config/logger');
const dianApiService = require('./dianApiService');
const { getKit } = require('./dianKitAdapter');
const { buildPayrollXml, buildPayrollAdjustmentXml } = require('./payrollXmlBuilder');

/**
 * Firma el XML sin firmar de NominaIndividual con XAdES-BES.
 * @param {string} unsignedXml - salida de buildPayrollXml().xml
 * @param {object} certificateData - mismo objeto que usa dianKitAdapter.js
 *   (kit.config.certificateData) — extraído del P12 del tenant.
 * @param {Date} signingTime
 */
async function signPayrollXml(unsignedXml, certificateData, signingTime) {
  const { signedXml } = await signXml({ xml: unsignedXml, certificate: certificateData, signingTime });

  const extIdx = signedXml.indexOf('<ext:UBLExtensions');
  const sigIdx = signedXml.indexOf('<ds:Signature');
  if (extIdx === -1 || sigIdx === -1 || sigIdx < extIdx) {
    logger.warn('[Payroll-DIAN] La firma no quedó claramente dentro de <ext:UBLExtensions> — revisar manualmente antes de enviar a DIAN.');
  }

  return signedXml;
}

/**
 * Orquestación completa: construye el XML, lo firma, y lo envía a DIAN vía
 * SendNominaSync. Análogo a createInvoice()/createSupportDocument() en
 * dianKitAdapter.js pero para nómina.
 *
 * @param {object} params.tenant - incluye dian_config (nit, dv, p12Base64,
 *   p12Password, environment, certificateData, software_id_nomina,
 *   software_pin_nomina, ...)
 * @param {object} params.employee
 * @param {object} params.period
 * @param {object} params.liquidation
 * @param {object} params.numbering
 */
async function submitPayrollDocument({ tenant, employee, period, liquidation, numbering }) {
  const cfg = tenant.dian_config || {};

  const built = buildPayrollXml({ tenant, employee, period, liquidation, numbering });

  // Se reutiliza getKit() de dianKitAdapter.js SOLO para extraer
  // certificateData del P12 (kit.config.certificateData) — es la única
  // forma confiable de obtener ese objeto sin reimplementar el parseo del
  // P12 que ya hace el SDK internamente. El resto de la config de ese kit
  // (numbering/software de FACTURACIÓN) no se usa para nada aquí.
  const kit = getKit(tenant);
  const signedXml = await signPayrollXml(built.xml, kit.config.certificateData, new Date());

  const dianResponse = await dianApiService.sendNominaSync({
    xmlContent: signedXml,
    nit: cfg.nit,
    documentNumber: built.numeroDocumento,
    p12Base64: cfg.certificate_p12_base64,
    password: cfg.certificate_password,
    environment: cfg.environment === 'production' ? 'production' : 'test',
  });

  return {
    xml: signedXml,
    cune: built.cune,
    numeroDocumento: built.numeroDocumento,
    devengadosTotal: built.devengadosTotal,
    deduccionesTotal: built.deduccionesTotal,
    comprobanteTotal: built.comprobanteTotal,
    dianResponse,
  };
}

/**
 * Orquestación completa de la Nota de Ajuste (NominaIndividualDeAjuste):
 * construye el XML (Reemplazar/Eliminar), lo firma, y lo envía a DIAN.
 *
 * Envío: se reutiliza sendNominaSync() sin cambios — igual que Nota
 * Crédito/Débito reutilizan sendBillSync() de Factura (ver
 * dianService.js#sendCreditNoteToDian), la DIAN identifica el tipo de
 * documento por el elemento raíz del XML (NominaIndividualDeAjuste), no
 * por la operación SOAP invocada.
 *
 * @param {object} params.tenant, employee, period, liquidation, numbering
 *   - mismos que submitPayrollDocument().
 * @param {'replace'|'delete'} params.adjustmentType
 * @param {object} params.predecessor - { numeroPred, cunePred, fechaGenPred }
 */
async function submitPayrollAdjustmentDocument({
  tenant, employee, period, liquidation, numbering, adjustmentType, predecessor,
}) {
  const cfg = tenant.dian_config || {};

  const built = buildPayrollAdjustmentXml({
    tenant, employee, period, liquidation, numbering, adjustmentType, predecessor,
  });

  const kit = getKit(tenant);
  const signedXml = await signPayrollXml(built.xml, kit.config.certificateData, new Date());

  const dianResponse = await dianApiService.sendNominaSync({
    xmlContent: signedXml,
    nit: cfg.nit,
    documentNumber: built.numeroDocumento,
    p12Base64: cfg.certificate_p12_base64,
    password: cfg.certificate_password,
    environment: cfg.environment === 'production' ? 'production' : 'test',
  });

  return {
    xml: signedXml,
    cune: built.cune,
    numeroDocumento: built.numeroDocumento,
    devengadosTotal: built.devengadosTotal,
    deduccionesTotal: built.deduccionesTotal,
    comprobanteTotal: built.comprobanteTotal,
    dianResponse,
  };
}

/**
 * Consulta el estado de un documento de nómina ya enviado, por CUNE.
 * Reutiliza getStatus() sin cambios — ver nota arriba. Sirve tanto para
 * NominaIndividual como para NominaIndividualDeAjuste (mismo parámetro).
 */
async function getPayrollDocumentStatus({ cune, tenant }) {
  const cfg = tenant.dian_config || {};
  return dianApiService.getStatus({
    cufe: cune, // GetStatus acepta el trackId genérico; para nómina se pasa el CUNE en el mismo parámetro
    p12Base64: cfg.certificate_p12_base64,
    password: cfg.certificate_password,
    environment: cfg.environment === 'production' ? 'production' : 'test',
  });
}

module.exports = {
  signPayrollXml,
  submitPayrollDocument,
  submitPayrollAdjustmentDocument,
  getPayrollDocumentStatus,
};