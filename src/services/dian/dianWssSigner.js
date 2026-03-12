/**
 * dianWssSigner.js — WS-Security X.509 con ExcC14N correcto
 * ═══════════════════════════════════════════════════════════
 *
 * CÓMO FUNCIONA WCF AL VERIFICAR:
 *
 *  1. Para cada Reference (ej. #Action-1):
 *     - Lee el elemento del DOCUMENTO REAL (con su contexto de ancestros)
 *     - Canonicaliza con ExcC14N TENIENDO EN CUENTA los ancestros del documento
 *     - Los namespaces ya "rendered" por ancestros NO se incluyen en el elemento
 *
 *  2. Para verificar la firma (ds:SignedInfo):
 *     - Lee ds:SignedInfo del documento (cuyo padre ds:Signature renderizó xmlns:ds)
 *     - Canonicaliza con ExcC14N → xmlns:ds NO se incluye (ya lo tiene el padre)
 *
 * DOCUMENTO FINAL:
 *   soap:Envelope [xmlns:soap, xmlns:a, xmlns:wsu]
 *     soap:Header
 *       a:Action      ← ancestors renderizan: soap, a, wsu → canónico sin xmlns
 *       a:To          ← idem
 *       wsse:Security [xmlns:wsse, xmlns:wsu (mismo valor)]
 *         wsu:Timestamp ← ancestors renderizan wsu → canónico sin xmlns
 *         ds:Signature [xmlns:ds]
 *           ds:SignedInfo ← padre renderiza ds → canónico sin xmlns:ds
 *     soap:Body       ← ancestors renderizan soap, wsu → canónico sin xmlns
 *
 * BUGS corregidos:
 *   - En docs 1-3: SignedInfo tenía <tag/> en vez de <tag></tag> → WCF expande → mismatch firma
 *   - En doc 4: Se cambió contexto de SIGNATURE_NS a SECURITY_NS → añadía xmlns:ds → WCF no lo tiene
 *   - En doc 5: Contexto {} para todo → añadía xmlns a referencias → WCF no los tiene
 *
 * FIX: mantener contextos originales (docs 1-3), solo expandir elementos vacíos.
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

/* ── Contextos de ancestros (NS ya "rendered" en el documento) ── */
// Refleja exactamente los xmlns declarados en los ancestros de cada elemento
const ENVELOPE_NS = {          // Envelope declara estos tres
  'soap': NS.SOAP,
  'a':    NS.ADDR,
  'wsu':  NS.WSU,
};
const SECURITY_NS = {          // Security añade wsse (wsu ya está en Envelope)
  ...ENVELOPE_NS,
  'wsse': NS.WSSE,
};
const SIGNATURE_NS = {         // Signature añade ds
  ...SECURITY_NS,
  'ds': NS.DS,
};

/* ── Extraer cert/key del P12 ───────────────────────────── */
function extractFromP12(p12Base64, password) {
  const p12Der  = forge.util.decode64(p12Base64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12obj  = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags = p12obj.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!keyBag) throw new Error('No se encontró clave privada en el P12');

  const certBags = p12obj.getBags({ bagType: forge.pki.oids.certBag });
  const certs    = certBags[forge.pki.oids.certBag] || [];
  if (!certs.length) throw new Error('No se encontraron certificados en el P12');

  const entityCert = certs.find(b => {
    const bc = b.cert.getExtension('basicConstraints');
    return !bc || !bc.cA;
  }) || certs[0];

  const certPem    = forge.pki.certificateToPem(entityCert.cert);
  const keyPem     = forge.pki.privateKeyToPem(keyBag.key);
  const certDer    = forge.asn1.toDer(forge.pki.certificateToAsn1(entityCert.cert));
  const certBase64 = forge.util.encode64(certDer.getBytes());
  const subject    = entityCert.cert.subject.attributes
    .map(a => `${a.shortName || a.type}=${a.value}`).join(', ');

  // Thumbprint SHA1 = SHA1(DER bytes) — requerido por sp:RequireThumbprintReference
  // certDer.getBytes() fue consumido por encode64() arriba; usamos certBase64 (mismo DER).
  const thumbprintB64 = crypto.createHash('sha1')
    .update(Buffer.from(certBase64, 'base64'))
    .digest('base64');

  return {
    certPem, keyPem,
    privateKey:  keyBag.key,
    certBase64, thumbprintB64, subject,
    notBefore: entityCert.cert.validity.notBefore,
    notAfter:  entityCert.cert.validity.notAfter,
    serialHex: entityCert.cert.serialNumber,
  };
}

/* ── Expandir elementos auto-cerrados ───────────────────── */
// C14N requiere <tag></tag>, nunca <tag/>
function expandEmptyElements(xml) {
  return xml.replace(/<([a-zA-Z][a-zA-Z0-9:_.-]*)([^>]*?)\s*\/>/g, (_, name, attrs) =>
    `<${name}${attrs}></${name}>`
  );
}

/* ── SHA256 base64 ──────────────────────────────────────── */
function sha256b64(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('base64');
}

function fmtUtc(d) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

/* ── ExcC14N canonicalizador ────────────────────────────── */
/**
 * Canonicaliza elementXml según ExcC14N.
 *
 * @param {string} elementXml  Elemento XML a canonicalizar
 * @param {Object} ancestorNS  { prefix: uri } ya renderizados por ancestros
 *                             EN EL MISMO CONTEXTO DOCUMENTAL que verá WCF.
 *                             Ej: ENVELOPE_NS para a:Action (hijo del Envelope),
 *                                 SIGNATURE_NS para ds:SignedInfo (hijo de ds:Signature)
 */
function excC14nWithContext(elementXml, ancestorNS = {}) {
  const openTagMatch = elementXml.match(/^<([^\s>\/]+)((?:\s[^>]*?)?)\s*>/s);
  if (!openTagMatch) throw new Error(`ExcC14N parse error: ${elementXml.substring(0, 80)}`);

  const fullTagName = openTagMatch[1];
  const attrsStr    = openTagMatch[2] || '';
  const innerClose  = elementXml.slice(openTagMatch[0].length, -(`</${fullTagName}>`).length);
  const elemPrefix  = fullTagName.includes(':') ? fullTagName.split(':')[0] : '';

  // Separar xmlns:* de atributos regulares
  const nsDeclared   = {};
  const regularAttrs = {};
  const attrRe = /\s+((?:xmlns(?::([^\s=]+))?|([^\s=:]+:)?([^\s=]+))\s*=\s*"([^"]*)")/g;
  let m;
  while ((m = attrRe.exec(attrsStr)) !== null) {
    const full = m[1];
    if (full.startsWith('xmlns:')) {
      nsDeclared[m[2]] = m[5];
    } else if (full.startsWith('xmlns=')) {
      nsDeclared[''] = m[5];
    } else {
      const pfx = m[3] ? m[3].slice(0, -1) : '';
      regularAttrs[`${pfx}:${m[4]}`] = { prefix: pfx, localName: m[4], value: m[5] };
    }
  }

  // Prefijos visiblemente utilizados por este elemento y sus descendientes
  const usedPrefixes = new Set();
  if (elemPrefix) usedPrefixes.add(elemPrefix);
  for (const { prefix } of Object.values(regularAttrs)) {
    if (prefix) usedPrefixes.add(prefix);
  }
  const innerHits = innerClose.match(/(?:<|[\s])([a-zA-Z][a-zA-Z0-9]*):(?:[a-zA-Z])/g) || [];
  for (const h of innerHits) usedPrefixes.add(h.replace(/^[<\s]/, '').replace(/:.*/, ''));

  // ExcC14N: incluir xmlns si visiblemente utilizado Y no ya renderizado por ancestro
  const nsToRender = {};
  for (const prefix of usedPrefixes) {
    const uri = nsDeclared[prefix] ?? ancestorNS[prefix];
    if (!uri) continue;
    if (ancestorNS[prefix] === uri) continue; // ya renderizado → no incluir
    nsToRender[prefix] = uri;
  }
  for (const [prefix, uri] of Object.entries(nsDeclared)) {
    if (usedPrefixes.has(prefix) && ancestorNS[prefix] !== uri) {
      nsToRender[prefix] = uri;
    }
  }

  // xmlns:* ordenados ALFABÉTICAMENTE POR NOMBRE DE PREFIJO (spec ExcC14N)
  const nsSorted = Object.entries(nsToRender).sort(([a], [b]) => a.localeCompare(b));

  // Atributos regulares: sin prefijo primero (por localName), luego prefijados (por nsURI, localName)
  const scope = { ...ancestorNS, ...nsDeclared };
  const attrsSorted = Object.values(regularAttrs).sort((a, b) => {
    const aUri = a.prefix ? (scope[a.prefix] || '') : '';
    const bUri = b.prefix ? (scope[b.prefix] || '') : '';
    if (!a.prefix && !b.prefix) return a.localName.localeCompare(b.localName);
    if (!a.prefix) return -1;
    if (!b.prefix) return  1;
    if (aUri !== bUri) return aUri.localeCompare(bUri);
    return a.localName.localeCompare(b.localName);
  });

  let out = `<${fullTagName}`;
  for (const [pfx, uri] of nsSorted) out += ` xmlns:${pfx}="${uri}"`;
  for (const a of attrsSorted) {
    out += ` ${a.prefix ? `${a.prefix}:${a.localName}` : a.localName}="${a.value}"`;
  }
  out += `>${innerClose}</${fullTagName}>`;
  return out;
}

/* ── Construir ds:Reference ─────────────────────────────── */
function buildRef(id, digest) {
  // ⚠️  Elementos vacíos con <tag></tag> (nunca <tag/>) → requerido por C14N
  return (
    `<ds:Reference URI="#${id}">` +
    `<ds:Transforms><ds:Transform Algorithm="${NS.EXC_C14N}"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${NS.SHA256}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digest}</ds:DigestValue>` +
    `</ds:Reference>`
  );
}

/* ── Constructor principal ──────────────────────────────── */
function buildSignedEnvelope({ action, endpoint, bodyContent, certBase64, privateKey, keyPem, thumbprintB64 }) {
  const bodyId   = 'Body-1';
  const tsId     = 'TS-1';
  const tokenId  = 'X509Token-1';
  const actionId = 'Action-1';
  const toId     = 'To-1';

  const now     = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000);
  const created = fmtUtc(now);
  const exp     = fmtUtc(expires);

  // ── Canonicalizar referencias: WCF extrae el elemento por wsu:Id como nodo
  //    HUERFANO (sin ancestros), por lo que TODOS los namespaces visiblemente
  //    utilizados deben aparecer en el propio elemento (ExcC14N con contexto {}).
  //
  //    CONFIRMADO: digests sin xmlns = firma localmente valida pero WCF rechaza.
  //                digests con xmlns = lo que WCF computa al extraer por ID.
  const canonAction = excC14nWithContext(
    `<a:Action xmlns:a="${NS.ADDR}" xmlns:soap="${NS.SOAP}" xmlns:wsu="${NS.WSU}" wsu:Id="${actionId}" soap:mustUnderstand="1">${action}</a:Action>`,
    {}
  );
  const canonTo = excC14nWithContext(
    `<a:To xmlns:a="${NS.ADDR}" xmlns:soap="${NS.SOAP}" xmlns:wsu="${NS.WSU}" wsu:Id="${toId}" soap:mustUnderstand="1">${endpoint}</a:To>`,
    {}
  );
  const canonTS = excC14nWithContext(
    `<wsu:Timestamp xmlns:wsu="${NS.WSU}" wsu:Id="${tsId}"><wsu:Created>${created}</wsu:Created><wsu:Expires>${exp}</wsu:Expires></wsu:Timestamp>`,
    {}
  );
  const canonBody = excC14nWithContext(
    `<soap:Body xmlns:soap="${NS.SOAP}" xmlns:wsu="${NS.WSU}" wsu:Id="${bodyId}">${bodyContent}</soap:Body>`,
    {}
  );

  if (process.env.DEBUG_WSS) {
    console.log('[WSS] canonAction:', canonAction);
    console.log('[WSS] canonTo:    ', canonTo);
    console.log('[WSS] canonTS:    ', canonTS);
    console.log('[WSS] canonBody:  ', canonBody);
  }

  const dAction = sha256b64(canonAction);
  const dTo     = sha256b64(canonTo);
  const dTS     = sha256b64(canonTS);
  const dBody   = sha256b64(canonBody);

  // ── ds:SignedInfo ──────────────────────────────────────────────────────────
  // SignedInfo vive DENTRO de ds:Signature en el documento. WCF lo canonicaliza
  // con el contexto del documento donde ds:Signature ya renderizó xmlns:ds.
  // → canónico de SignedInfo = sin xmlns:ds → firmamos sin xmlns:ds.
  //
  // En el string del documento incluimos xmlns:ds explícitamente en SignedInfo
  // (redundante respecto a Signature, pero hace que excC14nWithContext pueda
  // encontrar la URI del prefijo ds: al canonicalizar con SIGNATURE_NS).
  //
  // ⚠️  CRÍTICO: los elementos vacíos DEBEN ser <tag></tag>, no <tag/>
  //     WCF expande siempre; si nosotros usamos <tag/>, los strings difieren
  //     → hash diferente → firma inválida.
  const signedInfo = expandEmptyElements(
    `<ds:SignedInfo xmlns:ds="${NS.DS}">` +
    `<ds:CanonicalizationMethod Algorithm="${NS.EXC_C14N}"/>` +
    `<ds:SignatureMethod Algorithm="${NS.RSA_SHA256}"/>` +
    buildRef(actionId, dAction) +
    buildRef(toId,     dTo)     +
    buildRef(tsId,     dTS)     +
    buildRef(bodyId,   dBody)   +
    `</ds:SignedInfo>`
  );

  // ds:SignedInfo está dentro de ds:Signature (que renderizó xmlns:ds) → SIGNATURE_NS
  const canonSignedInfo = excC14nWithContext(signedInfo, SIGNATURE_NS);

  if (process.env.DEBUG_WSS) {
    console.log('[WSS] canonSignedInfo:', canonSignedInfo);
  }

  // ── Firma RSA-SHA256 con Node.js crypto (OpenSSL) ──────────────────────────
  // Usamos crypto.createSign en lugar de forge para mayor compatibilidad con WCF.
  // forge.privateKey.sign() y crypto.createSign('RSA-SHA256') deben ser equivalentes
  // (ambos usan PKCS#1 v1.5), pero OpenSSL es la referencia estándar.
  const sigB64 = crypto.createSign('RSA-SHA256')
    .update(canonSignedInfo, 'utf8')
    .sign(keyPem, 'base64');

  // ── Envelope SOAP final ────────────────────────────────────────────────────
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${NS.SOAP}" xmlns:a="${NS.ADDR}" xmlns:wsu="${NS.WSU}">` +
    `<soap:Header>` +
    `<a:Action wsu:Id="${actionId}" soap:mustUnderstand="1">${action}</a:Action>` +
    `<a:To wsu:Id="${toId}" soap:mustUnderstand="1">${endpoint}</a:To>` +
    `<wsse:Security xmlns:wsse="${NS.WSSE}" soap:mustUnderstand="1">` +
    `<wsu:Timestamp wsu:Id="${tsId}">` +
    `<wsu:Created>${created}</wsu:Created>` +
    `<wsu:Expires>${exp}</wsu:Expires>` +
    `</wsu:Timestamp>` +
    `<wsse:BinarySecurityToken wsu:Id="${tokenId}" EncodingType="${NS.B64ET}" ValueType="${NS.X509VT}">${certBase64}</wsse:BinarySecurityToken>` +
    `<ds:Signature xmlns:ds="${NS.DS}">` +
    signedInfo +
    `<ds:SignatureValue>${sigB64}</ds:SignatureValue>` +
    `<ds:KeyInfo>` +
    `<wsse:SecurityTokenReference xmlns:wsse="${NS.WSSE}">` +
    `<wsse:Reference URI="#${tokenId}" ValueType="${NS.X509VT}"/>` +
    `</wsse:SecurityTokenReference>` +
    `</ds:KeyInfo>` +
    `</ds:Signature>` +
    `</wsse:Security>` +
    `</soap:Header>` +
    `<soap:Body wsu:Id="${bodyId}">${bodyContent}</soap:Body>` +
    `</soap:Envelope>`
  );
}

module.exports = { extractFromP12, buildSignedEnvelope, NS };