// El cuerpo SOAP de las operaciones de la DIAN va en el namespace
// http://wcf.dian.colombia (SIN barra final), como en el Anexo FE 1.9, el de
// Nómina y @dian-kit. Con la barra, el WCF no reconoce la operación y
// responde "The server was unable to process the request due to an internal
// error" (evento 030 en producción, 2026-11-15).
const { buildSignedEnvelope, NS } = require('../services/dian/dianWssSigner');
const crypto = require('crypto');

describe('namespace de las operaciones WCF de la DIAN', () => {
  it('es http://wcf.dian.colombia, sin barra final', () => {
    expect(NS.WCF).toBe('http://wcf.dian.colombia');
  });

  it('el sobre firmado declara wcf sin barra', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
    const xml = buildSignedEnvelope({
      action: 'http://wcf.dian.colombia/IWcfDianCustomerServices/SendEventUpdateStatus',
      endpoint: 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc',
      bodyContent: `<wcf:SendEventUpdateStatus xmlns:wcf="${NS.WCF}"><wcf:contentFile>QQ==</wcf:contentFile></wcf:SendEventUpdateStatus>`,
      certBase64: 'QQ==', keyPem,
    });
    expect(xml).not.toContain('xmlns:wcf="http://wcf.dian.colombia/"');
    expect(xml).toContain('xmlns:wcf="http://wcf.dian.colombia"');
  });
});
