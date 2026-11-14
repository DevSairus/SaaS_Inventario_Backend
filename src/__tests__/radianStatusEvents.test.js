// Lector de la respuesta de GetStatusEvent (Anexo FE 1.9 §7.17). El Anexo
// no publica el contenido del ApplicationResponse que devuelve la DIAN, así
// que se prueban las dos formas que el parser acepta y que nunca toma el
// CUFE de la factura como si fuera el CUDE de un evento.
const { parseStatusEventXml } = require('../services/radian/radianStatusEvents');

const CUFE = 'c'.repeat(96);
const CUDE_030 = '1'.repeat(96);
const CUDE_032 = '2'.repeat(96);
const NS = 'xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';

const docResponse = (code, id, uuid, date, time) => `
  <cac:DocumentResponse>
    <cac:Response><cbc:ResponseCode>${code}</cbc:ResponseCode><cbc:Description>evento ${code}</cbc:Description></cac:Response>
    <cac:DocumentReference><cbc:ID>${id}</cbc:ID><cbc:UUID schemeName="CUDE-SHA384">${uuid}</cbc:UUID>${date ? `<cbc:IssueDate>${date}</cbc:IssueDate>` : ''}${time ? `<cbc:IssueTime>${time}</cbc:IssueTime>` : ''}</cac:DocumentReference>
  </cac:DocumentResponse>`;

describe('parseStatusEventXml', () => {
  it('forma (a): un DocumentResponse por evento con número, CUDE y fecha', () => {
    const xml = `<ApplicationResponse ${NS}><cbc:ID>FE100</cbc:ID>
      ${docResponse('030', 'ACU-1', CUDE_030, '2026-11-10', '09:00:00-05:00')}
      ${docResponse('032', 'REC-7', CUDE_032, '2026-11-12', '15:30:00-05:00')}
    </ApplicationResponse>`;
    const events = parseStatusEventXml(xml, CUFE);
    expect(events.map(e => e.code)).toEqual(['030', '032']);
    expect(events[1]).toMatchObject({ number: 'REC-7', cude: CUDE_032, issuedAt: '2026-11-12T15:30:00-05:00' });
  });

  it('forma (b): eventos completos anidados toman ID/UUID/fecha del propio evento', () => {
    const xml = `<ApplicationResponse ${NS}><cbc:ID>RESP</cbc:ID>
      <ApplicationResponse><cbc:ID>REC-9</cbc:ID><cbc:UUID>${CUDE_032}</cbc:UUID><cbc:IssueDate>2026-11-12</cbc:IssueDate><cbc:IssueTime>16:00:00-05:00</cbc:IssueTime>
        ${docResponse('032', 'FE100', CUFE)}
      </ApplicationResponse>
    </ApplicationResponse>`;
    const [e] = parseStatusEventXml(xml, CUFE);
    expect(e).toMatchObject({ code: '032', number: 'REC-9', cude: CUDE_032, issuedAt: '2026-11-12T16:00:00-05:00' });
  });

  it('si la referencia es la propia factura, no inventa número ni CUDE del evento', () => {
    const xml = `<ApplicationResponse ${NS}>${docResponse('032', 'FE100', CUFE, '2026-11-12')}</ApplicationResponse>`;
    const [e] = parseStatusEventXml(xml, CUFE);
    expect(e).toMatchObject({ code: '032', number: null, cude: null });
  });

  it('ignora códigos que no son eventos RADIAN (02 validado por la DIAN) y XML vacío o inválido', () => {
    const xml = `<ApplicationResponse ${NS}>${docResponse('02', 'FE100', CUFE)}</ApplicationResponse>`;
    expect(parseStatusEventXml(xml, CUFE)).toEqual([]);
    expect(parseStatusEventXml('', CUFE)).toEqual([]);
    expect(parseStatusEventXml('no es xml', CUFE)).toEqual([]);
  });
});
