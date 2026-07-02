/**
 * dianWssSigner.js — WS-Security X.509 Signature para DIAN
 * ═══════════════════════════════════════════════════════════════════
 *
 * Basado en la especificación WS-Security y validado contra el sandbox DIAN.
 * Solo firma el elemento wsa:To (no Body/Action/Timestamp/MessageID).
 * Usa ec:InclusiveNamespaces para ExcC14N correcto.
 */
'use strict';

const forge  = require('node-forge');
const crypto = require('crypto');

/* ── Namespaces ─────────────────────────────────────────── */
const NS = {
  SOAP:      'http://www.w3.org/2003/05/soap-envelope',
  ADDR:      'http://www.w3.org/2005/08/addressing',
  DS:        'http://www.w3.org/2000/09/xmldsig#',
  WSSE:      'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  WSU:       'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  WCF:       'http://wcf.dian.colombia/',
  X509VT:    'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3',
  B64ET:     'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary',
  EXC_C14N:  'http://www.w3.org/2001/10/xml-exc-c14n#',
  SHA256:    'http://www.w3.org/2001/04/xmlenc#sha256',
  RSA_SHA256:'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
};

/* ── Extraer cert/key del P12 ───────────────────────────── */
function extractFromP12(p12Base64, password) {
  if (!p12Base64 || p12Base64 === '[CONFIGURADO]') throw new Error('Certificado digital no configurado.');
  if (!password || password === '[CONFIGURADO]') throw new Error('Contraseña del certificado no configurada.');

  const logger = require('../../config/logger');
  const p12Der  = forge.util.decode64(p12Base64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12obj  = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags = p12obj.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!keyBag) throw new Error('No se encontró clave privada en el P12');

  const certBags = p12obj.getBags({ bagType: forge.pki.oids.certBag });
  const certs    = certBags[forge.pki.oids.certBag] || [];
  if (!certs.length) throw new Error('No se encontraron certificados en el P12');

  const entityCert = certs.find(b => { const bc = b.cert.getExtension('basicConstraints'); return !bc || !bc.cA; }) || certs[0];

  const certPem    = forge.pki.certificateToPem(entityCert.cert);
  const keyPem     = forge.pki.privateKeyToPem(keyBag.key);
  const certDer    = forge.asn1.toDer(forge.pki.certificateToAsn1(entityCert.cert));
  const certBase64 = forge.util.encode64(certDer.getBytes());
  const thumbprintB64 = crypto.createHash('sha1').update(Buffer.from(certBase64, 'base64')).digest('base64');

  const certNit = entityCert.cert.subject.attributes.find(a => a.shortName === 'SERIALNUMBER' || a.type === '2.5.4.5');
  logger.info('[DIAN WSS] Cert: NIT=' + (certNit?.value || 'N/A') + ' vence=' + entityCert.cert.validity.notAfter);

  // Cross-verify: firma con keyPem, verifica con OpenSSL nativo
  try {
    const testMsg = Buffer.from('dian-wss-cross-verify');
    const testSig = crypto.createSign('RSA-SHA256').update(testMsg).sign(keyPem);
    const certDerBuf = Buffer.from(certBase64, 'base64');
    const x509native = new crypto.X509Certificate(certDerBuf);
    const crossOk = crypto.createVerify('RSA-SHA256').update(testMsg).verify(x509native.publicKey, testSig);
    if (!crossOk) throw new Error('keyPem no corresponde al certificado');
    logger.info('[DIAN WSS] Cross-verify OK');
  } catch (e) {
    throw new Error('P12 cross-verify fallido: ' + e.message);
  }

  return {
    certPem, keyPem, privateKey: keyBag.key, certBase64, thumbprintB64,
    notBefore: entityCert.cert.validity.notBefore,
    notAfter:  entityCert.cert.validity.notAfter,
    subject:   entityCert.cert.subject.attributes.map(a => `${a.shortName || a.type}=${a.value}`).join(', '),
    serialHex: entityCert.cert.serialNumber,
  };
}

/* ── buildSignedEnvelope ─────────────────────────────────── */
/**
 * Construye el envelope SOAP 1.2 firmado para DIAN.
 * Solo firma el elemento wsa:To con RSA-SHA256 + ExcC14N.
 */
function buildSignedEnvelope({ action, endpoint, bodyContent, certBase64, keyPem }) {
  const tsId    = 'TS-'    + crypto.randomUUID();
  const x509Id  = 'X509-'  + crypto.randomUUID();
  const sigId   = 'SIG-'   + crypto.randomUUID();
  const kiId    = 'KI-'    + crypto.randomUUID();
  const strId   = 'STR-'   + crypto.randomUUID();
  const toId    = 'ID-'    + crypto.randomUUID();

  // Timestamp
  const now     = new Date();
  const expires = new Date(now.getTime() + 60000); // 60 segundos
  const created = now.toISOString();
  const exp     = expires.toISOString();

  // Canonicalizar wsa:To con InclusiveNamespaces PrefixList="soap wcf"
  const canonicalTo =
    '<wsa:To' +
    ' xmlns:soap="' + NS.SOAP + '"' +
    ' xmlns:wcf="' + NS.WCF + '"' +
    ' xmlns:wsa="' + NS.ADDR + '"' +
    ' xmlns:wsu="' + NS.WSU + '"' +
    ' wsu:Id="' + toId + '"' +
    '>' + endpoint + '</wsa:To>';

  // SHA-256 digest de wsa:To
  const digestValue = crypto.createHash('sha256').update(canonicalTo, 'utf8').digest('base64');

  // SignedInfo canonical con InclusiveNamespaces PrefixList="wsa soap wcf"
  const canonicalSignedInfo =
    '<ds:SignedInfo xmlns:ds="' + NS.DS + '" xmlns:soap="' + NS.SOAP + '" xmlns:wcf="' + NS.WCF + '" xmlns:wsa="' + NS.ADDR + '">' +
    '<ds:CanonicalizationMethod Algorithm="' + NS.EXC_C14N + '">' +
    '<ec:InclusiveNamespaces xmlns:ec="' + NS.EXC_C14N + '" PrefixList="wsa soap wcf"></ec:InclusiveNamespaces>' +
    '</ds:CanonicalizationMethod>' +
    '<ds:SignatureMethod Algorithm="' + NS.RSA_SHA256 + '"></ds:SignatureMethod>' +
    '<ds:Reference URI="#' + toId + '">' +
    '<ds:Transforms>' +
    '<ds:Transform Algorithm="' + NS.EXC_C14N + '">' +
    '<ec:InclusiveNamespaces xmlns:ec="' + NS.EXC_C14N + '" PrefixList="soap wcf"></ec:InclusiveNamespaces>' +
    '</ds:Transform>' +
    '</ds:Transforms>' +
    '<ds:DigestMethod Algorithm="' + NS.SHA256 + '"></ds:DigestMethod>' +
    '<ds:DigestValue>' + digestValue + '</ds:DigestValue>' +
    '</ds:Reference>' +
    '</ds:SignedInfo>';

  // Firma RSA-SHA256
  const signatureValue = crypto.sign('sha256', Buffer.from(canonicalSignedInfo, 'utf8'), keyPem).toString('base64');

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="' + NS.SOAP + '" xmlns:wcf="' + NS.WCF + '">' +
    '<soap:Header xmlns:wsa="' + NS.ADDR + '">' +
    '<wsse:Security xmlns:wsse="' + NS.WSSE + '" xmlns:wsu="' + NS.WSU + '">' +
    '<wsu:Timestamp wsu:Id="' + tsId + '">' +
    '<wsu:Created>' + created + '</wsu:Created>' +
    '<wsu:Expires>' + exp + '</wsu:Expires>' +
    '</wsu:Timestamp>' +
    '<wsse:BinarySecurityToken EncodingType="' + NS.B64ET + '" ValueType="' + NS.X509VT + '" wsu:Id="' + x509Id + '">' + certBase64 + '</wsse:BinarySecurityToken>' +
    '<ds:Signature Id="' + sigId + '" xmlns:ds="' + NS.DS + '">' +
    '<ds:SignedInfo>' +
    '<ds:CanonicalizationMethod Algorithm="' + NS.EXC_C14N + '">' +
    '<ec:InclusiveNamespaces PrefixList="wsa soap wcf" xmlns:ec="' + NS.EXC_C14N + '"></ec:InclusiveNamespaces>' +
    '</ds:CanonicalizationMethod>' +
    '<ds:SignatureMethod Algorithm="' + NS.RSA_SHA256 + '"></ds:SignatureMethod>' +
    '<ds:Reference URI="#' + toId + '">' +
    '<ds:Transforms>' +
    '<ds:Transform Algorithm="' + NS.EXC_C14N + '">' +
    '<ec:InclusiveNamespaces PrefixList="soap wcf" xmlns:ec="' + NS.EXC_C14N + '"></ec:InclusiveNamespaces>' +
    '</ds:Transform>' +
    '</ds:Transforms>' +
    '<ds:DigestMethod Algorithm="' + NS.SHA256 + '"></ds:DigestMethod>' +
    '<ds:DigestValue>' + digestValue + '</ds:DigestValue>' +
    '</ds:Reference>' +
    '</ds:SignedInfo>' +
    '<ds:SignatureValue>' + signatureValue + '</ds:SignatureValue>' +
    '<ds:KeyInfo Id="' + kiId + '">' +
    '<wsse:SecurityTokenReference wsu:Id="' + strId + '">' +
    '<wsse:Reference URI="#' + x509Id + '" ValueType="' + NS.X509VT + '"></wsse:Reference>' +
    '</wsse:SecurityTokenReference>' +
    '</ds:KeyInfo>' +
    '</ds:Signature>' +
    '</wsse:Security>' +
    '<wsa:Action>' + action + '</wsa:Action>' +
    '<wsa:To wsu:Id="' + toId + '" xmlns:wsu="' + NS.WSU + '">' + endpoint + '</wsa:To>' +
    '</soap:Header>' +
    '<soap:Body>' +
    bodyContent +
    '</soap:Body>' +
    '</soap:Envelope>'
  );
}

module.exports = { extractFromP12, buildSignedEnvelope, NS };
