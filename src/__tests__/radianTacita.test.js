// Reglas RADIAN contra el Anexo FE v1.9 (Res. 000165/2023): plazo de 3 días
// hábiles en hora Colombia, literales de Description, concepto del 031,
// declaración jurada del 034 y bloqueo de notas tras la aceptación.
const { addBusinessDays, isWithinBusinessDeadline } = require('../services/radian/businessDays');
const { buildEventXml, tacitAcceptanceNote } = require('../services/radian/radianXmlBuilder');
const { notesBlockedReason } = require('../utils/radianAcceptance');

const CUDE_032 = 'a'.repeat(96);
const base = {
  applicationResponseId: 'ARC034000001',
  invoiceNumber: 'FE100',
  invoiceCufe: 'b'.repeat(96),
  ownNit: '900123456',
  ownName: 'Taller Uno SAS',
  counterpartyNit: '800987654',
  counterpartyName: 'Cliente Dos SAS',
  softwarePin: '12345',
};

describe('plazo de 3 días hábiles (hora Colombia)', () => {
  it('un 032 a las 8 p. m. del viernes cuenta desde el viernes, salta el festivo y vence a medianoche en Colombia', () => {
    // Viernes 13-nov-2026 20:00 COT (= sábado 01:00 UTC). Lunes 16-nov es
    // festivo (Independencia de Cartagena trasladado): mar 17, mié 18, jue 19.
    const deadline = addBusinessDays(new Date('2026-11-13T20:00:00-05:00'), 3);
    expect(deadline.toISOString()).toBe('2026-11-20T04:59:59.000Z');
  });

  it('a las 7 p. m. del último día el plazo todavía no ha vencido (antes vencía a las 6:59 p. m.)', () => {
    const deadline = addBusinessDays(new Date('2026-11-13T10:00:00-05:00'), 3);
    expect(isWithinBusinessDeadline(new Date('2026-11-19T19:00:00-05:00'), deadline)).toBe(true);
    expect(isWithinBusinessDeadline(new Date('2026-11-20T00:00:01-05:00'), deadline)).toBe(false);
  });
});

describe('034 Aceptación Tácita', () => {
  it('usa el literal oficial y la declaración jurada con el número y CUDE del 032', () => {
    const { xml } = buildEventXml({ ...base, eventCode: '034', receiptNumber: 'REC-77', receiptCude: CUDE_032 });
    expect(xml).toContain('<cbc:Description>Aceptación Tácita</cbc:Description>');
    expect(xml).toContain(tacitAcceptanceNote({ receiptNumber: 'REC-77', receiptCude: CUDE_032, buyerName: 'Cliente Dos SAS', buyerNit: '800987654' }));
    expect(xml).toContain('Manifiesto bajo la gravedad de juramento que transcurridos 3 días hábiles contados desde la creación del Recibo de bienes y servicios REC-77');
    expect(xml).not.toContain('PENDIENTE');
  });

  it('no se puede construir sin el número y el CUDE del 032', () => {
    expect(() => buildEventXml({ ...base, eventCode: '034' })).toThrow(/CUDE del Recibo del bien/);
  });
});

describe('031 Reclamo', () => {
  it('lleva el concepto en listID/name de ResponseCode y el literal oficial', () => {
    const { xml } = buildEventXml({ ...base, eventCode: '031', claimReasonCode: '02', claimReasonText: 'No llegó el pedido' });
    expect(xml).toContain('<cbc:ResponseCode name="Mercancía no entregada" listID="02">031</cbc:ResponseCode>');
    expect(xml).toContain('<cbc:Description>Reclamo de la Factura Electrónica de Venta</cbc:Description>');
    expect(xml).toContain('<cbc:Note>No llegó el pedido</cbc:Note>');
  });

  it('rechaza un concepto fuera de la tabla 13.3.12', () => {
    expect(() => buildEventXml({ ...base, eventCode: '031', claimReasonCode: '99' })).toThrow(/Concepto de reclamo/);
  });
});

describe('030 Acuse de recibo y 032 Recibo del bien (Compras)', () => {
  const receiver = { issuerFirstName: 'Ana', issuerFamilyName: 'Pérez', issuerIdNumber: '1036781830', issuerIdType: '13' };

  it('030 usa el literal oficial e identifica a quien recibió', () => {
    const { xml } = buildEventXml({ ...base, eventCode: '030', ...receiver });
    expect(xml).toContain('<cbc:Description>Acuse de recibo de Factura Electrónica de Venta</cbc:Description>');
    expect(xml).toContain('<cbc:ID schemeName="13">1036781830</cbc:ID>');
  });

  it('032 lleva documento, nombres, apellidos y opcionales, como el XML de ejemplo oficial', () => {
    const { xml } = buildEventXml({ ...base, eventCode: '032', ...receiver, issuerJobTitle: 'Almacenista', issuerDepartment: 'Bodega' });
    expect(xml).toMatch(/<cac:IssuerParty>\s*<cac:Person>\s*<cbc:ID schemeName="13">1036781830<\/cbc:ID>\s*<cbc:FirstName>Ana<\/cbc:FirstName>\s*<cbc:FamilyName>Pérez<\/cbc:FamilyName>\s*<cbc:JobTitle>Almacenista<\/cbc:JobTitle>\s*<cbc:OrganizationDepartment>Bodega<\/cbc:OrganizationDepartment>/);
  });

  it('con NIT informa el DV en schemeID', () => {
    const { xml } = buildEventXml({ ...base, eventCode: '032', ...receiver, issuerIdNumber: '900123456', issuerIdType: '31' });
    expect(xml).toContain('<cbc:ID schemeID="8" schemeName="31">900123456</cbc:ID>');
  });

  it('no se emite sin documento de quien recibió (antes salía "N/A" y la DIAN lo rechazaba)', () => {
    expect(() => buildEventXml({ ...base, eventCode: '032', issuerFirstName: 'Ana', issuerFamilyName: 'Pérez' })).toThrow(/documento, nombres y apellidos/);
  });
});

describe('CUDE y partes del evento (Anexo FE 1.9 §11.5 y §6.5.4)', () => {
  const { buildRadianCude } = require('../services/radian/radianCude');

  it('reproduce el CUDE del ejemplo oficial §11.5.1', () => {
    expect(buildRadianCude({
      applicationResponseId: '1', issueDate: '2019-04-30', issueTime: '19:48:50-05:00',
      nitEmisorFactura: '99998888', nitAdquiriente: '800197268', responseCode: '030',
      referencedDocumentId: 'FE123', documentTypeCode: '01', softwarePin: '11111',
    })).toBe('0d91ba25b01f5e7dbda870a11b274501d3a62a73e91932c473c86c93f12a142a2ac45876efcde3e679024a01c0be41f9');
  });

  it('en Compras (030-033) el CUDE va con NUESTRO NIT primero (SenderParty) y el del proveedor después', () => {
    const { xml, cude, issueDate, issueTime } = buildEventXml({ ...base, eventCode: '033' });
    const expected = buildRadianCude({
      applicationResponseId: base.applicationResponseId, issueDate, issueTime,
      nitEmisorFactura: base.ownNit, nitAdquiriente: base.counterpartyNit, responseCode: '033',
      referencedDocumentId: base.invoiceNumber, documentTypeCode: '01', softwarePin: base.softwarePin,
    });
    expect(cude).toBe(expected);
    expect(xml).toContain(`<cbc:UUID schemeName="CUDE-SHA384">${expected}</cbc:UUID>`);
  });

  it('SenderParty/ReceiverParty usan PartyTaxScheme con CompanyID como el XML de ejemplo', () => {
    const { xml } = buildEventXml({ ...base, eventCode: '033', ownDv: '8', counterpartyNit: '1036781830', counterpartyDocType: '13' });
    expect(xml).toMatch(/<cac:SenderParty>\s*<cac:PartyTaxScheme>\s*<cbc:RegistrationName>Taller Uno SAS<\/cbc:RegistrationName>\s*<cbc:CompanyID schemeID="8" schemeAgencyID="195" schemeName="31" schemeAgencyName="CO, DIAN \(Dirección de Impuestos y Aduanas Nacionales\)" schemeVersionID="1">900123456<\/cbc:CompanyID>/);
    expect(xml).toContain('schemeName="13" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeVersionID="2">1036781830</cbc:CompanyID>');
    expect(xml).not.toContain('PartyIdentification');
  });

  it('un NIT con DV pegado ("800987654-1") se informa sin el DV', () => {
    const { xml } = buildEventXml({ ...base, eventCode: '033', counterpartyNit: '800987654-1' });
    expect(xml).toContain('>800987654</cbc:CompanyID>');
  });
});

describe('notas crédito/débito tras la aceptación', () => {
  it('se bloquean con 033 o 034 y se permiten antes', () => {
    expect(notesBlockedReason({ radian_status: '034' })).toMatch(/aceptación tácita/);
    expect(notesBlockedReason({ radian_status: '033_received' })).toMatch(/aceptación expresa/);
    expect(notesBlockedReason({ radian_status: '032_received' })).toBeNull();
    expect(notesBlockedReason({ radian_status: 'none' })).toBeNull();
  });
});
