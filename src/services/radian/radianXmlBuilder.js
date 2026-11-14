// backend/src/services/radian/radianXmlBuilder.js
/**
 * Constructor de XML ApplicationResponse para los eventos RADIAN que Pitbox
 * emite (ver 00 - Documentación/RADIAN-Analisis-y-Plan.md §4/§5.2/§5.4/§8):
 *   - 030/032/031/033 — los emite el ADQUIRENTE (nosotros, en Compras)
 *     sobre la factura de un proveedor.
 *   - 034/036/037-040/041-042/043-044/045/046 — los emite el EMISOR (o
 *     tenedor legítimo, que en el uso normal de Pitbox somos siempre
 *     nosotros — ver radianService.js) sobre nuestra propia factura, una
 *     vez aceptada e inscrita como título valor. El 035 (Aval) NO está acá
 *     a propósito: lo emite el AVALISTA con su propio software, no el
 *     emisor de la factura — fuera del alcance de lo que Pitbox controla.
 * Quien EMITE el evento (SenderParty) siempre somos nosotros — lo que
 * cambia es el rol frente a la factura referenciada: en 030-033 somos el
 * adquirente (DocAdq del CUDE); en el resto somos el emisor de esa factura
 * (NitFE del CUDE). Ver `role` más abajo.
 *
 * Estructura confirmada contra el Anexo FE 1.9 §8.5.3.3–§8.6.3:
 * ResponseCode, Description, DocumentResponse/DocumentReference (ID,
 * UUID=CUFE, @schemeName, DocumentTypeCode). El bloque IssuerParty/Person
 * (datos de quien ejecuta el evento) aplica SOLO a 030 y 032 — confirmado
 * en §5.4 del plan; 031, 033 y 034 no lo llevan.
 *
 * MEJOR ESFUERZO, sin verificar contra un envío real aceptado por la DIAN:
 * el Anexo no publica un ejemplo XML completo de ApplicationResponse con el
 * mismo detalle que sí tiene el de Invoice — el orden/anidamiento exacto de
 * SenderParty/ReceiverParty/DocumentResponse se arma siguiendo el esquema
 * UBL 2.1 ApplicationResponse estándar. Validar contra el primer envío al
 * set de pruebas de habilitación antes de dar esto por cerrado (mismo
 * criterio que el resto de builders "sin verificar" en dianKitAdapter.js).
 *
 * RESUELTO — contradicción 030 vs. 036 para "inscripción" (pendiente en
 * versiones anteriores de este código/plan): es un TYPO del propio PDF
 * oficial de la DIAN, no una ambigüedad real. La Nota 1 del numeral 6.2.3
 * (pág. 40) dice "el primer evento... debe ser el 030 – inscripción de la
 * factura electrónica de venta como título valor – RADIAN", pero:
 *   (a) la tabla de esa misma página solo enumera los códigos 035–046 (030
 *       ni siquiera aparece — pertenece al Anexo FE, es "Acuse de recibo",
 *       un evento del ADQUIRENTE, no del emisor inscribiendo su factura);
 *   (b) el numeral 13.2.1 (pág. 357, la tabla que el propio Anexo cita como
 *       fuente del texto de cbc:Description) asigna esa descripción EXACTA
 *       ("Inscripción de la factura electrónica de venta como título valor
 *       - RADIAN") al código 036, responsable "Emisor".
 * Conclusión: la Nota 1 quiso decir "036", no "030" — confirmado por
 * cruce interno del propio documento, sin necesitar la v1.1. Este builder
 * ya usaba 036 para inscripción; queda documentado como confirmado, no
 * como pendiente de verificar.
 *
 * HALLAZGO ADICIONAL (misma revisión, numeral 13.2.1, pág. 357): el
 * Responsable de los eventos 041/042 (Limitación de circulación y su
 * terminación) es la "Autoridad judicial o administrativa", NO el
 * emisor/tenedor legítimo — a diferencia de 037-040/043-046, que sí lista
 * "Emisor/leg[í]timo tenedor" o "Emisor/Tenedor Legítimo o adquirente"
 * como responsable. Un tenant normal de Pitbox (taller, comercio) no es
 * una autoridad judicial o administrativa — ver radianService.js para
 * cómo se refleja esto (el backend los deja disponibles por API para el
 * caso atípico de un tenant que sí lo sea, pero la UI no los expone).
 *
 * HALLAZGO ADICIONAL 2: la misma Nota 1 dice que el evento 036 debe ser el
 * PRIMERO en registrarse "a excepción del evento 043 – Mandato" — es decir,
 * el Mandato es la única excepción que NO requiere que la factura ya esté
 * inscrita. radianService.js ya lo refleja (043/044 no exigen inscripción
 * previa, a diferencia de 037-042/045-046).
 */
'use strict';

const { escXml, getColombiaDateTime } = require('../dian/dianXmlBuilder');

// DV del NIT (módulo 11) — mismo algoritmo que dianKitAdapter#computeNitCheckDigit,
// sin cargar @dian-kit para un cálculo de seis líneas.
function computeNitCheckDigit(nit) {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digits = String(nit).replace(/\D/g, '').split('').reverse();
  const sum = digits.reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  const mod = sum % 11;
  return mod < 2 ? mod : 11 - mod;
}
const { buildRadianCude } = require('./radianCude');

// Texto del literal de respuesta por código de evento — el Anexo exige que
// Description sea el literal exacto. 030/031/033/034 CONFIRMADOS contra la
// tabla 13.3.1 "Eventos de un Documento Electrónico" de la Caja de
// herramientas FE v1.9 (Anexo Tecnico/Tablas Referenciadas) y los XML de
// ejemplo oficiales (Ejemplificaciones/XMLs de ejemplo/Eventos RADIAN).
// El 032 no se cambia: la tabla dice "Recibo del bien o prestación del
// servicio", el XML de ejemplo "…y/o…" y el cuerpo del Anexo "…y prestación
// de servicio" -- se conserva el de la tabla, que es el que ya se usa. Si
// la DIAN lo rechazara por la descripción, RADIAN_032_DESCRIPTION permite
// cambiarlo desde las variables de entorno sin desplegar código (p. ej.
// "Recibo del bien y/o prestación del servicio", el del XML de ejemplo).
const EVENT_DESCRIPTION = {
  '030': 'Acuse de recibo de Factura Electrónica de Venta',
  '032': (process.env.RADIAN_032_DESCRIPTION || '').trim() || 'Recibo del bien o prestación del servicio',
  '031': 'Reclamo de la Factura Electrónica de Venta',
  '033': 'Aceptación expresa',
  '034': 'Aceptación Tácita',
  // Fase 4 — CONFIRMADO contra el Anexo RADIAN v1.0, numeral 13.2.1 ("Eventos
  // de un Documento Electrónico"), pág. 357: es la tabla que el propio Anexo
  // cita como fuente del literal exacto de cbc:Description (§6.2.3, pág. 40:
  // "están definidos en el numeral 13.2.1"). Texto copiado tal cual de esa
  // tabla — ya no es "mejor esfuerzo sin verificar" como el resto del
  // builder (extraído con `pdftotext -raw` sobre
  // 00 - Documentación/Anexo-Tecnico-RADIAN.pdf, páginas 357-358).
  '036': 'Inscripción de la factura electrónica de venta como título valor - RADIAN',
  '037': 'Endoso en propiedad',
  '038': 'Endoso en garantía',
  '039': 'Endoso en procuración',
  '040': 'Cancelación de endoso',
  '041': 'Limitaciones a la circulación de la factura electrónica de venta como título valor',
  '042': 'Terminación de las limitaciones a la circulación de la factura electrónica de venta como título valor',
  '043': 'Mandato',
  '044': 'Terminación del mandato',
  '045': 'Pago de la factura electrónica de venta como título valor',
  '046': 'Informe para el pago',
};

// Eventos con el bloque IssuerParty/Person (quien ejecuta el evento) — ver
// §5.4 del plan: solo 030 y 032 lo llevan.
const EVENTS_WITH_ISSUER_PARTY = new Set(['030', '032']);


// Concepto del reclamo (031): tabla 13.3.12 "Concepto de Reclamo @listID"
// de la Caja de herramientas FE v1.9. Va como atributos de
// cbc:ResponseCode (listID = código, name = significado), igual que el XML
// de ejemplo oficial — obligatorio: la DIAN rechaza el 031 si listID no
// está en la tabla (regla AAH10).
const CLAIM_REASONS = {
  '01': 'Documento con inconsistencias',
  '02': 'Mercancía no entregada',
  '03': 'Mercancía entregada parcialmente',
  '04': 'Servicio no prestado',
};

// Declaración jurada del 034 — texto LITERAL del Anexo FE v1.9 (Res. 000165
// de 2023), numeral 6.5.5.7, nota 1 "persona natural o jurídica sin
// mandatario". Se llena con el número y el CUDE del Recibo del bien (032)
// que emitió el cliente, y con su razón social y NIT. Las notas 2 y 3
// (mandatario / mandato con persona natural comerciante) piden datos del
// mandatario y del mandante que Pitbox no captura: no se soportan todavía.
function tacitAcceptanceNote({ receiptNumber, receiptCude, buyerName, buyerNit }) {
  return `Manifiesto bajo la gravedad de juramento que transcurridos 3 días hábiles contados desde la creación del Recibo de bienes y servicios ${receiptNumber} con CUDE ${receiptCude}, el adquirente ${buyerName} identificado con NIT ${buyerNit} no manifestó expresamente la aceptación o rechazo de la referida factura, ni reclamó en contra de su contenido.`;
}

// NIT/documento sin DV ni separadores ("900123456-8" → "900123456"): es lo
// que va en CompanyID y, por tanto, en el CUDE.
function cleanPartyId(id, docType) {
  const s = String(id || '').trim();
  if (docType === '31') return s.split('-')[0].replace(/\D/g, '');
  return s.replace(/\s/g, '');
}

// SenderParty / ReceiverParty — Anexo FE 1.9 §6.5.4 (AAF01-AAF20 y
// AAG01-AAG..): PartyTaxScheme con RegistrationName, CompanyID (+
// schemeAgencyID "195", schemeAgencyName, schemeID = DV si es NIT,
// schemeName = tipo de documento, schemeVersionID = tipo de persona,
// tabla 13.2.3: 1 jurídica / 2 natural) y TaxScheme. Mismo formato que los
// XML de ejemplo oficiales. Antes iba PartyIdentification/PartyName, que no
// es la estructura del Anexo (y el CUDE se calcula sobre estos CompanyID).
function partyXml(tagName, { id, name, docType = '31', dv }) {
  const isNit = docType === '31';
  const dvAttr = isNit ? ` schemeID="${escXml(String(dv ?? computeNitCheckDigit(id)))}"` : '';
  const personType = isNit ? '1' : '2';
  return `
    <cac:${tagName}>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${escXml(name || '')}</cbc:RegistrationName>
        <cbc:CompanyID${dvAttr} schemeAgencyID="195" schemeName="${escXml(docType)}" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeVersionID="${personType}">${escXml(id)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>01</cbc:ID>
          <cbc:Name>IVA</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:${tagName}>`;
}

/**
 * Construye el ApplicationResponse de un evento RADIAN (030, 032, 031, 033
 * o 034).
 *
 * @param {object} p
 * @param {'030'|'032'|'031'|'033'|'034'} p.eventCode
 * @param {string} p.applicationResponseId - Consecutivo propio del evento
 * @param {string} p.invoiceNumber - cbc:ID de la factura referenciada
 * @param {string} p.invoiceCufe - CUFE de la factura referenciada
 * @param {string} p.ownNit - NIT propio (tenant, quien emite este evento)
 * @param {string} p.ownName
 * @param {string} p.counterpartyNit - NIT de la contraparte (proveedor en 030-033, cliente en 034)
 * @param {string} p.counterpartyName
 * @param {string} [p.issuerFirstName] - Requerido solo en 030/032
 * @param {string} [p.issuerFamilyName]
 * @param {string} [p.issuerIdNumber] - 030/032: documento de quien recibió
 * @param {string} [p.issuerIdType] - 030/032: tipo de documento (tabla 13.2.1; 13 = cédula)
 * @param {string} [p.issuerJobTitle] - 030/032, opcional
 * @param {string} [p.issuerDepartment] - 030/032, opcional
 * @param {string} [p.claimReasonCode] - Solo 031 (reclamo)
 * @param {string} [p.claimReasonText] - Solo 031, texto libre del motivo (va en cbc:Note)
 * @param {string} [p.receiptNumber] - Solo 034: número del 032 que emitió el cliente
 * @param {string} [p.receiptCude] - Solo 034: CUDE de ese 032
 * @param {string} [p.extraNote] - Fase 4 (036-046): detalle estructurado
 *   pero legible del evento (endosatario, motivo de limitación, datos del
 *   mandatario, monto pagado...) — el Anexo no publica un esquema de
 *   campos propio para cada uno de estos eventos (mismo vacío que el
 *   catálogo de motivos del 031), así que se declara en cbc:Note en vez de
 *   inventar elementos XML sin confirmar.
 * @param {string} p.softwarePin
 * @param {string} p.environment - 'test' | 'production'
 */
function buildEventXml({
  eventCode,
  applicationResponseId,
  invoiceNumber, invoiceCufe,
  ownNit, ownName, ownDv,
  counterpartyNit, counterpartyName, counterpartyDocType = '31',
  issuerFirstName, issuerFamilyName,
  issuerIdNumber, issuerIdType = '13', issuerJobTitle, issuerDepartment,
  claimReasonCode, claimReasonText,
  receiptNumber, receiptCude,
  extraNote,
  softwarePin,
  environment = 'test',
}) {
  if (!EVENT_DESCRIPTION[eventCode]) {
    throw new Error(`Código de evento RADIAN no soportado: ${eventCode}`);
  }

  const { date: issueDate, time: issueTime } = getColombiaDateTime();
  const profileExecutionID = environment === 'production' ? '1' : '2';
  const responseCode = eventCode;
  const ownId = cleanPartyId(ownNit, '31');
  const counterpartyId = cleanPartyId(counterpartyNit, counterpartyDocType);

  // Anexo FE 1.9 §11.5 / §11.5.2 (XPath): NitFE = SenderParty/CompanyID
  // ("quien genera el evento") y DocAdq = ReceiverParty/CompanyID ("quien
  // recibe el ApplicationResponse"). Nosotros siempre somos el SenderParty,
  // así que el orden es fijo para TODOS los eventos. Antes, en 030-033
  // (Compras) iba primero el NIT del proveedor y el CUDE no coincidía con el
  // que recalcula la DIAN. Hash verificado contra el ejemplo §11.5.1.
  const cude = buildRadianCude({
    applicationResponseId,
    issueDate, issueTime,
    nitEmisorFactura: ownId,
    nitAdquiriente: counterpartyId,
    responseCode,
    referencedDocumentId: invoiceNumber,
    documentTypeCode: '01',
    softwarePin,
  });

  // 030/032: persona que recibió la factura / el bien o servicio. Anexo FE
  // 1.9 §6.5.5.3 y §6.5.5.5 (AAH11-AAH19): ID con @schemeName (tipo de
  // documento, tabla 13.2.1) y FirstName/FamilyName son obligatorios;
  // @schemeID (DV) solo si es NIT; JobTitle/OrganizationDepartment
  // opcionales. Mismo orden que los XML de ejemplo oficiales.
  let issuerPartyXml = '';
  if (EVENTS_WITH_ISSUER_PARTY.has(eventCode)) {
    const idNumber = String(issuerIdNumber || '').trim();
    const idType = String(issuerIdType || '13').trim();
    if (!idNumber || !String(issuerFirstName || '').trim() || !String(issuerFamilyName || '').trim()) {
      throw new Error(`El evento ${eventCode} exige el documento, nombres y apellidos de quien recibió${eventCode === '032' ? ' el bien o servicio' : ' la factura'}.`);
    }
    const dvAttr = idType === '31' ? ` schemeID="${computeNitCheckDigit(idNumber)}"` : '';
    issuerPartyXml = `
    <cac:IssuerParty>
      <cac:Person>
        <cbc:ID${dvAttr} schemeName="${escXml(idType)}">${escXml(idNumber)}</cbc:ID>
        <cbc:FirstName>${escXml(String(issuerFirstName).trim())}</cbc:FirstName>
        <cbc:FamilyName>${escXml(String(issuerFamilyName).trim())}</cbc:FamilyName>${issuerJobTitle ? `
        <cbc:JobTitle>${escXml(issuerJobTitle)}</cbc:JobTitle>` : ''}${issuerDepartment ? `
        <cbc:OrganizationDepartment>${escXml(issuerDepartment)}</cbc:OrganizationDepartment>` : ''}
      </cac:Person>
    </cac:IssuerParty>`;
  }

  // El 031 (Reclamo) necesita expresar el motivo — el Anexo no publica un
  // catálogo cerrado de códigos localizable en las secciones revisadas (ver
  // checklist §8 del plan: "Tabla de motivos del reclamo. Sin resolver"), así
  // que se declara en un único cbc:Note de encabezado con código + texto,
  // en vez de inventar un catálogo de ResponseCode que no está confirmado.
  // El código elegido por el usuario igual queda guardado tal cual en
  // radian_events.claim_reason_code para auditoría/reportes internos.
  let headerNoteXml = '';
  if (extraNote) {
    headerNoteXml = `\n  <cbc:Note>${escXml(extraNote)}</cbc:Note>`;
  } else if (eventCode === '031' && claimReasonText) {
    headerNoteXml = `\n  <cbc:Note>${escXml(claimReasonText)}</cbc:Note>`;
  } else if (eventCode === '034') {
    if (!receiptNumber || !receiptCude) {
      throw new Error('El 034 requiere el número y el CUDE del Recibo del bien (032) que emitió el cliente.');
    }
    const note = tacitAcceptanceNote({ receiptNumber, receiptCude, buyerName: counterpartyName, buyerNit: counterpartyId });
    headerNoteXml = `\n  <cbc:Note>${escXml(note)}</cbc:Note>`;
  }

  // 031: el concepto del reclamo va en atributos de ResponseCode (tabla 13.3.12).
  let responseCodeAttrs = '';
  if (eventCode === '031') {
    const reasonName = CLAIM_REASONS[claimReasonCode];
    if (!reasonName) {
      throw new Error(`Concepto de reclamo no válido: "${claimReasonCode || ''}". Use 01, 02, 03 o 04.`);
    }
    responseCodeAttrs = ` name="${escXml(reasonName)}" listID="${claimReasonCode}"`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"
  xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>10</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1: Eventos</cbc:ProfileID>
  <cbc:ProfileExecutionID>${profileExecutionID}</cbc:ProfileExecutionID>
  <cbc:ID>${escXml(applicationResponseId)}</cbc:ID>
  <cbc:UUID schemeName="CUDE-SHA384">${cude}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>${headerNoteXml}
  ${partyXml('SenderParty', { id: ownId, name: ownName, docType: '31', dv: ownDv || undefined })}
  ${partyXml('ReceiverParty', { id: counterpartyId, name: counterpartyName, docType: counterpartyDocType })}
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ResponseCode${responseCodeAttrs}>${responseCode}</cbc:ResponseCode>
      <cbc:Description>${escXml(EVENT_DESCRIPTION[eventCode])}</cbc:Description>
    </cac:Response>${issuerPartyXml}
    <cac:DocumentReference>
      <cbc:ID>${escXml(invoiceNumber)}</cbc:ID>
      <cbc:UUID schemeName="CUFE-SHA384">${escXml(invoiceCufe)}</cbc:UUID>
      <cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>
    </cac:DocumentReference>
  </cac:DocumentResponse>
</ApplicationResponse>`;

  return { xml, cude, issueDate, issueTime };
}

module.exports = { buildEventXml, CLAIM_REASONS, tacitAcceptanceNote };
