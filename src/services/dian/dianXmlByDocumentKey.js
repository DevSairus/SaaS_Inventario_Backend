// backend/src/services/dian/dianXmlByDocumentKey.js
//
// Operación GetXmlByDocumentKey del web service de la DIAN
// (WcfDianCustomerServices): dado el CUFE/CUDE de un documento electrónico
// devuelve su XML (con todas las líneas). Se usa para completar las
// facturas recibidas que llegan solo como encabezado en el Excel de
// "Documentos recibidos" que se descarga del portal DIAN.
//
// @dian-kit no expone esta operación ni su constructor de sobre SOAP
// firmado (buildSignedSoapEnvelope es interno), así que aquí se replica el
// mismo sobre WS-Security que usa la librería para GetStatus/GetAcquirer:
// Timestamp + BinarySecurityToken + firma RSA-SHA256 sobre <wsa:To>.
// Solo se toma de la librería `loadP12` (exportada).
//
// IMPORTANTE: no está verificado que la DIAN devuelva el XML cuando quien
// consulta es el RECEPTOR de la factura (está documentado para el emisor).
// Por eso el resultado distingue "no disponible" de un error técnico, y el
// flujo de Pitbox sigue funcionando sin esto (carga con ZIP manual).
//
// Este archivo se copia tal cual a dian-service/ (la IP de Railway no está
// en la whitelist de la DIAN y la llamada debe salir de esa máquina) — si se
// cambia aquí, actualizar también allá.

'use strict';

const crypto = require('crypto');

const NS_SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const NS_WCF = 'http://wcf.dian.colombia';
const NS_WSA = 'http://www.w3.org/2005/08/addressing';
const NS_WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const NS_WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const NS_EC = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENCODING_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
const VALUE_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const ACTION = 'http://wcf.dian.colombia/IWcfDianCustomerServices/GetXmlByDocumentKey';
const ENDPOINTS = {
  production: 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc',
  habilitacion: 'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc',
};

const escapeXml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const id = (prefix) => `${prefix}${crypto.randomUUID()}`;

function buildEnvelope(cufe, endpointUrl, certificate) {
  const tsId = id('TS-'); const x509Id = id('X509-'); const sigId = id('SIG-');
  const kiId = id('KI-'); const strId = id('STR-'); const toId = id('ID-');
  const now = new Date();
  const created = now.toISOString();
  const expires = new Date(now.getTime() + 60000).toISOString();

  // Formas canónicas (exc-c14n) idénticas a las de @dian-kit.
  const canonicalTo = `<wsa:To xmlns:soap="${NS_SOAP}" xmlns:wcf="${NS_WCF}" xmlns:wsa="${NS_WSA}" xmlns:wsu="${NS_WSU}" wsu:Id="${toId}">${endpointUrl}</wsa:To>`;
  const digest = crypto.createHash('sha256').update(canonicalTo, 'utf8').digest('base64');
  const canonicalSignedInfo = `<ds:SignedInfo xmlns:ds="${NS_DS}" xmlns:soap="${NS_SOAP}" xmlns:wcf="${NS_WCF}" xmlns:wsa="${NS_WSA}"><ds:CanonicalizationMethod Algorithm="${NS_EC}"><ec:InclusiveNamespaces xmlns:ec="${NS_EC}" PrefixList="wsa soap wcf"></ec:InclusiveNamespaces></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod><ds:Reference URI="#${toId}"><ds:Transforms><ds:Transform Algorithm="${NS_EC}"><ec:InclusiveNamespaces xmlns:ec="${NS_EC}" PrefixList="soap wcf"></ec:InclusiveNamespaces></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const signature = crypto.sign('sha256', Buffer.from(canonicalSignedInfo, 'utf8'), certificate.privateKeyPem).toString('base64');

  const body = `<wcf:GetXmlByDocumentKey><wcf:trackId>${escapeXml(cufe)}</wcf:trackId></wcf:GetXmlByDocumentKey>`;
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:wcf="${NS_WCF}"><soap:Header xmlns:wsa="${NS_WSA}"><wsse:Security xmlns:wsse="${NS_WSSE}" xmlns:wsu="${NS_WSU}"><wsu:Timestamp wsu:Id="${tsId}"><wsu:Created>${created}</wsu:Created><wsu:Expires>${expires}</wsu:Expires></wsu:Timestamp><wsse:BinarySecurityToken EncodingType="${ENCODING_TYPE}" ValueType="${VALUE_TYPE}" wsu:Id="${x509Id}">${certificate.certificateDerBase64}</wsse:BinarySecurityToken><ds:Signature Id="${sigId}" xmlns:ds="${NS_DS}"><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${NS_EC}"><ec:InclusiveNamespaces PrefixList="wsa soap wcf" xmlns:ec="${NS_EC}"/></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#${toId}"><ds:Transforms><ds:Transform Algorithm="${NS_EC}"><ec:InclusiveNamespaces PrefixList="soap wcf" xmlns:ec="${NS_EC}"/></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>${signature}</ds:SignatureValue><ds:KeyInfo Id="${kiId}"><wsse:SecurityTokenReference wsu:Id="${strId}"><wsse:Reference URI="#${x509Id}" ValueType="${VALUE_TYPE}"/></wsse:SecurityTokenReference></ds:KeyInfo></ds:Signature></wsse:Security><wsa:Action>${ACTION}</wsa:Action><wsa:To wsu:Id="${toId}" xmlns:wsu="${NS_WSU}">${endpointUrl}</wsa:To></soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

// Extrae el texto del primer elemento cuyo nombre local cumpla `re`
// (la respuesta usa prefijos variables: b:, s:, a:...).
function pickTag(xml, re) {
  const tagRe = /<(?:[\w-]+:)?([\w-]+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?\1>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    if (re.test(m[1]) && m[2] && !m[2].includes('<')) return m[2].trim();
  }
  return '';
}

/**
 * @param {object} config - dian_config del tenant (certificate_p12_base64, certificate_password, environment)
 * @param {string} cufe
 * @param {Function} loadP12 - core.loadP12 de @dian-kit/core
 * @returns {Promise<{ found: boolean, xml: string|null, code: string, message: string }>}
 */
async function getXmlByDocumentKey(config, cufe, loadP12) {
  if (!config?.certificate_p12_base64 || !config?.certificate_password) {
    throw new Error('Certificado digital no configurado para este tenant.');
  }
  if (!cufe) throw new Error('CUFE requerido');

  const certificate = loadP12(Buffer.from(config.certificate_p12_base64, 'base64'), config.certificate_password);
  const url = config.environment === 'production' ? ENDPOINTS.production : ENDPOINTS.habilitacion;
  const envelope = buildEnvelope(cufe, url, certificate);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let text;
  let status;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${ACTION}"`, Accept: 'application/soap+xml, text/xml' },
      body: envelope,
      signal: controller.signal,
    });
    status = response.status;
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }

  if (status !== 200) {
    const fault = pickTag(text || '', /^(Text|faultstring|Reason)$/i);
    throw new Error(`DIAN respondió HTTP ${status}${fault ? `: ${fault}` : ''}`);
  }

  const code = pickTag(text, /^(Code|StatusCode)$/i);
  const message = pickTag(text, /^(Message|StatusMessage|StatusDescription)$/i);
  const b64 = pickTag(text, /^(XmlBytesBase64|XmlBase64Bytes|XmlBytes|XmlBase64)$/i);
  if (!b64) return { found: false, xml: null, code, message: message || 'La DIAN no devolvió el XML del documento' };

  const xml = Buffer.from(b64, 'base64').toString('utf8');
  return { found: true, xml, code, message };
}

module.exports = { getXmlByDocumentKey, buildEnvelope };
