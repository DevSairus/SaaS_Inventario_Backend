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
const { buildRadianCude } = require('./radianCude');

// Texto del literal de respuesta por código de evento — el Anexo exige que
// Description sea el literal exacto, no una descripción libre (ver §8 del
// plan). Solo se confirmó contra el índice de secciones del Anexo FE 1.9
// (título de cada sección, no el cuerpo XML de ejemplo) — MEJOR ESFUERZO
// para los cinco, igual de "sin verificar" que el resto de este builder.
const EVENT_DESCRIPTION = {
  '030': 'Acuse de recibo',
  '032': 'Recibo del bien o prestación del servicio',
  '031': 'Reclamo',
  '033': 'Aceptación expresa',
  '034': 'Aceptación tácita',
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

// Rol de "nosotros" (ownNit) frente a la factura referenciada, para el CUDE
// (ver radianCude.js): 030-033 los emitimos como adquirentes; el resto los
// emitimos como el emisor original de esa factura (o su tenedor legítimo,
// que en Pitbox es la misma parte — ver radianService.js).
const EVENT_ROLE = {
  '030': 'acquirer', '032': 'acquirer', '031': 'acquirer', '033': 'acquirer',
  '034': 'issuer',
  '036': 'issuer', '037': 'issuer', '038': 'issuer', '039': 'issuer', '040': 'issuer',
  '041': 'issuer', '042': 'issuer', '043': 'issuer', '044': 'issuer',
  '045': 'issuer', '046': 'issuer',
};

// ⚠️ TEXTO SIN VERIFICAR — el 034 exige una cbc:Note con una declaración
// jurada específica (Anexo FE 1.9 §6.5.5.7, con 3 variantes según quién la
// emite: directo, mandatario, o mandato con persona natural comerciante —
// ver §2 del plan). No tengo acceso al PDF de ese Anexo en este entorno
// (solo está el Anexo RADIAN en 00 - Documentación/, no el de Factura
// Electrónica v1.9) — el texto de abajo es una reconstrucción de mejor
// esfuerzo a partir de la cita parcial que sí quedó en el plan, NO el
// literal exacto. Es una declaración BAJO GRAVEDAD DE JURAMENTO con efecto
// legal real (habilita la factura para circular como título valor) —
// **no usar en producción sin verificar el texto exacto contra el PDF
// oficial y sin revisión legal/contable previa**.
const DECLARATION_NOTE_TEMPLATES = {
  direct: '[PENDIENTE VERIFICAR TEXTO EXACTO — Anexo FE 1.9 §6.5.5.7] Manifiesto bajo la gravedad de juramento que transcurridos tres (3) días hábiles siguientes a la fecha de recibo de la factura electrónica de venta, no se presentó ante el emisor o su representante ningún reclamo respecto de su contenido.',
  mandatario: '[PENDIENTE VERIFICAR TEXTO EXACTO — Anexo FE 1.9 §6.5.5.7] Manifiesto bajo la gravedad de juramento, actuando como mandatario, que transcurridos tres (3) días hábiles siguientes a la fecha de recibo de la factura electrónica de venta, no se presentó reclamo alguno respecto de su contenido.',
  mandato_persona_natural: '[PENDIENTE VERIFICAR TEXTO EXACTO — Anexo FE 1.9 §6.5.5.7] Manifiesto bajo la gravedad de juramento, en virtud del mandato conferido por persona natural comerciante, que transcurridos tres (3) días hábiles siguientes a la fecha de recibo de la factura electrónica de venta, no se presentó reclamo alguno respecto de su contenido.',
};

function partyNitXml(tagName, nit, name) {
  return `
    <cac:${tagName}>
      <cac:PartyIdentification>
        <cbc:ID>${escXml(nit)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${escXml(name || '')}</cbc:Name>
      </cac:PartyName>
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
 * @param {string} [p.claimReasonCode] - Solo 031 (reclamo)
 * @param {string} [p.claimReasonText] - Solo 031, texto libre del motivo (va en cbc:Note)
 * @param {'direct'|'mandatario'|'mandato_persona_natural'} [p.declarantType] - Solo 034
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
  ownNit, ownName,
  counterpartyNit, counterpartyName,
  issuerFirstName, issuerFamilyName,
  claimReasonCode, claimReasonText,
  declarantType = 'direct',
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
  const role = EVENT_ROLE[eventCode];

  const cude = buildRadianCude({
    applicationResponseId,
    issueDate, issueTime,
    nitEmisorFactura: role === 'acquirer' ? counterpartyNit : ownNit,
    nitAdquiriente: role === 'acquirer' ? ownNit : counterpartyNit,
    responseCode,
    referencedDocumentId: invoiceNumber,
    documentTypeCode: '01',
    softwarePin,
  });

  const issuerPartyXml = EVENTS_WITH_ISSUER_PARTY.has(eventCode) ? `
    <cac:IssuerParty>
      <cac:Person>
        <cbc:FirstName>${escXml(issuerFirstName)}</cbc:FirstName>
        <cbc:FamilyName>${escXml(issuerFamilyName)}</cbc:FamilyName>
      </cac:Person>
    </cac:IssuerParty>` : '';

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
  } else if (eventCode === '031' && (claimReasonCode || claimReasonText)) {
    headerNoteXml = `\n  <cbc:Note>${escXml([claimReasonCode, claimReasonText].filter(Boolean).join(' - '))}</cbc:Note>`;
  } else if (eventCode === '034') {
    const template = DECLARATION_NOTE_TEMPLATES[declarantType] || DECLARATION_NOTE_TEMPLATES.direct;
    headerNoteXml = `\n  <cbc:Note>${escXml(template)}</cbc:Note>`;
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
  ${partyNitXml('SenderParty', ownNit, ownName)}
  ${partyNitXml('ReceiverParty', counterpartyNit, counterpartyName)}
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ResponseCode>${responseCode}</cbc:ResponseCode>
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

module.exports = { buildEventXml };
