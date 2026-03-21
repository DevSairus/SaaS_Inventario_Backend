/**
 * dianWssSigner.js — WS-Security X.509 con ExcC14N correcto via DOM
 * ═══════════════════════════════════════════════════════════════════
 *
 * Reescrito para usar xmldom (DOM real) en lugar de regex para ExcC14N.
 */
'use strict';

const forge  = require('node-forge');
const crypto = require('crypto');
const logger = require('../../config/logger');
const { DOMParser } = require('xmldom');

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

const ENVELOPE_NS = { 'soap': NS.SOAP, 'a': NS.ADDR, 'wsu': NS.WSU };
const SECURITY_NS = { ...ENVELOPE_NS, 'wsse': NS.WSSE };
const SIGNATURE_NS = { ...SECURITY_NS, 'ds': NS.DS };

/* ── DOMParser ───────────────────────────────────────────── */
const SILENT = { warning: () => {}, error: () => {}, fatalError: (e) => { throw e; } };
function parseXml(str) {
  return new DOMParser({ errorHandler: SILENT }).parseFromString(str, 'text/xml');
}

/* ── Escape C14N ─────────────────────────────────────────── */
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}

/* ── Buscar URI de prefijo subiendo el árbol ─────────────── */
function lookupNsUri(node, prefix) {
  if (!node || node.nodeType !== 1) return null;
  for (let i = 0; i < node.attributes.length; i++) {
    const attr = node.attributes.item(i);
    if (attr.name === 'xmlns:' + prefix) return attr.value;
    if (attr.prefix === 'xmlns' && attr.localName === prefix) return attr.value;
  }
  return lookupNsUri(node.parentNode, prefix);
}

/* ── ExcC14N DOM recursivo ───────────────────────────────── */
function excC14nElement(el, visibleNs) {
  // 1. Prefijos utilizados visiblemente en este elemento
  const usedPrefixes = new Set();
  if (el.prefix) usedPrefixes.add(el.prefix);
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes.item(i);
    if (attr.name === 'xmlns' || attr.prefix === 'xmlns') continue;
    if (attr.prefix) usedPrefixes.add(attr.prefix);
  }

  // 2. Determinar qué xmlns renderizar
  const nsToRender = {};
  for (const prefix of usedPrefixes) {
    const uri = lookupNsUri(el, prefix);
    if (uri && visibleNs[prefix] !== uri) nsToRender[prefix] = uri;
  }

  // 3. Ordenar xmlns por prefijo
  const nsSorted = Object.entries(nsToRender).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

  // 4. Recopilar y ordenar atributos no-xmlns por (NS-URI, local-name)
  const attrs = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes.item(i);
    if (attr.name === 'xmlns' || attr.prefix === 'xmlns') continue;
    attrs.push(attr);
  }
  attrs.sort((a, b) => {
    const aUri = a.prefix ? (lookupNsUri(el, a.prefix) || '') : '';
    const bUri = b.prefix ? (lookupNsUri(el, b.prefix) || '') : '';
    if (!a.prefix && !b.prefix) return a.localName < b.localName ? -1 : 1;
    if (!a.prefix) return -1;
    if (!b.prefix) return 1;
    if (aUri !== bUri) return aUri < bUri ? -1 : 1;
    return a.localName < b.localName ? -1 : 1;
  });

  // 5. Etiqueta de apertura
  let out = '<' + el.nodeName;
  for (const [prefix, uri] of nsSorted) out += ' xmlns:' + prefix + '="' + escapeAttr(uri) + '"';
  for (const attr of attrs) out += ' ' + attr.name + '="' + escapeAttr(attr.value) + '"';
  out += '>';

  // 6. Hijos
  const childVis = { ...visibleNs, ...nsToRender };
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes.item(i);
    if (child.nodeType === 1) out += excC14nElement(child, childVis);
    else if (child.nodeType === 3 || child.nodeType === 4) out += escapeText(child.data || '');
  }
  out += '</' + el.nodeName + '>';
  return out;
}

function domExcC14n(xmlStr, ancestorNs) {
  const doc = parseXml(xmlStr);
  return excC14nElement(doc.documentElement, ancestorNs || {});
}

/* ── Extraer cert/key del P12 ───────────────────────────── */
function extractFromP12(p12Base64, password) {
  if (!p12Base64 || p12Base64 === '[CONFIGURADO]') throw new Error('Certificado digital no configurado.');
  if (!password || password === '[CONFIGURADO]') throw new Error('Contraseña del certificado no configurada.');

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

  try {
    const testMsg = Buffer.from('dian-wss-verify');
    const sig = crypto.createSign('RSA-SHA256').update(testMsg).sign(keyPem);
    const ok  = crypto.createVerify('RSA-SHA256').update(testMsg).verify(certPem, sig);
    if (!ok) throw new Error('La clave privada no corresponde al certificado');
    logger.info('[DIAN WSS] P12 OK: clave <-> certificado verificados');
  } catch (e) { throw new Error('P12 inválido: ' + e.message); }

  return { certPem, keyPem, privateKey: keyBag.key, certBase64, thumbprintB64 };
}

/* ── SHA256 base64 ───────────────────────────────────────── */
function sha256b64(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('base64'); }
function fmtUtc(d)   { return d.toISOString().replace(/\.\d+Z$/, 'Z'); }

/* ── ds:Reference ────────────────────────────────────────── */
function buildRef(id, digest) {
  return (
    '<ds:Reference URI="#' + id + '">' +
    '<ds:Transforms><ds:Transform Algorithm="' + NS.EXC_C14N + '"></ds:Transform></ds:Transforms>' +
    '<ds:DigestMethod Algorithm="' + NS.SHA256 + '"></ds:DigestMethod>' +
    '<ds:DigestValue>' + digest + '</ds:DigestValue>' +
    '</ds:Reference>'
  );
}

/* ── buildSignedEnvelope ─────────────────────────────────── */
function buildSignedEnvelope({ action, endpoint, bodyContent, certBase64, privateKey, keyPem, thumbprintB64 }) {
  const bodyId   = 'Body-1', tsId = 'TS-1', tokenId = 'X509Token-1';
  const actionId = 'Action-1', toId = 'To-1';

  const now     = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000);
  const created = fmtUtc(now);
  const exp     = fmtUtc(expires);

  // Canonicalizar cada referencia con DOM ExcC14N y el contexto de ancestros exacto
  const canonAction = domExcC14n(
    '<a:Action xmlns:a="' + NS.ADDR + '" xmlns:soap="' + NS.SOAP + '" xmlns:wsu="' + NS.WSU + '" wsu:Id="' + actionId + '" soap:mustUnderstand="1">' + escapeText(action) + '</a:Action>',
    ENVELOPE_NS
  );
  const canonTo = domExcC14n(
    '<a:To xmlns:a="' + NS.ADDR + '" xmlns:soap="' + NS.SOAP + '" xmlns:wsu="' + NS.WSU + '" wsu:Id="' + toId + '" soap:mustUnderstand="1">' + escapeText(endpoint) + '</a:To>',
    ENVELOPE_NS
  );
  const canonTS = domExcC14n(
    '<wsu:Timestamp xmlns:wsu="' + NS.WSU + '" wsu:Id="' + tsId + '"><wsu:Created>' + created + '</wsu:Created><wsu:Expires>' + exp + '</wsu:Expires></wsu:Timestamp>',
    SECURITY_NS
  );
  const canonBody = domExcC14n(
    '<soap:Body xmlns:soap="' + NS.SOAP + '" xmlns:wsu="' + NS.WSU + '" wsu:Id="' + bodyId + '">' + bodyContent + '</soap:Body>',
    ENVELOPE_NS
  );

  logger.info('[DIAN WSS] Digests — action=' + sha256b64(canonAction).substring(0,12) + ' to=' + sha256b64(canonTo).substring(0,12) + ' ts=' + sha256b64(canonTS).substring(0,12) + ' body=' + sha256b64(canonBody).substring(0,12));

  const dAction = sha256b64(canonAction);
  const dTo     = sha256b64(canonTo);
  const dTS     = sha256b64(canonTS);
  const dBody   = sha256b64(canonBody);

  // ds:SignedInfo — elementos vacíos expandidos (ExcC14N requiere <tag></tag>)
  const signedInfoXml =
    '<ds:SignedInfo>' +
    '<ds:CanonicalizationMethod Algorithm="' + NS.EXC_C14N + '"></ds:CanonicalizationMethod>' +
    '<ds:SignatureMethod Algorithm="' + NS.RSA_SHA256 + '"></ds:SignatureMethod>' +
    buildRef(actionId, dAction) +
    buildRef(toId,     dTo)     +
    buildRef(tsId,     dTS)     +
    buildRef(bodyId,   dBody)   +
    '</ds:SignedInfo>';

  // Canonicalizar SignedInfo: está dentro de ds:Signature que declara xmlns:ds → SIGNATURE_NS
  const canonSignedInfo = domExcC14n(
    '<ds:SignedInfo xmlns:ds="' + NS.DS + '">' +
      signedInfoXml.slice('<ds:SignedInfo>'.length, -'</ds:SignedInfo>'.length) +
    '</ds:SignedInfo>',
    SIGNATURE_NS
  );

  // Firma RSA-SHA256 sobre la forma canónica de ds:SignedInfo
  const sigB64 = crypto.createSign('RSA-SHA256').update(canonSignedInfo, 'utf8').sign(keyPem, 'base64');

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="' + NS.SOAP + '" xmlns:a="' + NS.ADDR + '" xmlns:wsu="' + NS.WSU + '">' +
    '<soap:Header>' +
    '<a:Action wsu:Id="' + actionId + '" soap:mustUnderstand="1">' + action + '</a:Action>' +
    '<a:To wsu:Id="' + toId + '" soap:mustUnderstand="1">' + endpoint + '</a:To>' +
    '<wsse:Security xmlns:wsse="' + NS.WSSE + '" soap:mustUnderstand="1">' +
    '<wsu:Timestamp wsu:Id="' + tsId + '">' +
    '<wsu:Created>' + created + '</wsu:Created>' +
    '<wsu:Expires>' + exp + '</wsu:Expires>' +
    '</wsu:Timestamp>' +
    '<wsse:BinarySecurityToken wsu:Id="' + tokenId + '" EncodingType="' + NS.B64ET + '" ValueType="' + NS.X509VT + '">' + certBase64 + '</wsse:BinarySecurityToken>' +
    '<ds:Signature xmlns:ds="' + NS.DS + '">' +
    signedInfoXml +
    '<ds:SignatureValue>' + sigB64 + '</ds:SignatureValue>' +
    '<ds:KeyInfo>' +
    '<wsse:SecurityTokenReference xmlns:wsse="' + NS.WSSE + '">' +
    '<wsse:Reference URI="#' + tokenId + '" ValueType="' + NS.X509VT + '"/>' +
    '</wsse:SecurityTokenReference>' +
    '</ds:KeyInfo>' +
    '</ds:Signature>' +
    '</wsse:Security>' +
    '</soap:Header>' +
    '<soap:Body wsu:Id="' + bodyId + '">' + bodyContent + '</soap:Body>' +
    '</soap:Envelope>'
  );
}

module.exports = { extractFromP12, buildSignedEnvelope, NS };