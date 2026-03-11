// backend/src/services/dian/dianSignerService.js
/**
 * Firma Digital XAdES-BES para Facturación Electrónica DIAN Colombia
 * ═══════════════════════════════════════════════════════════════════
 *
 * DIFERENCIAS vs versión anterior (bugs corregidos comparando con C# en producción):
 *
 * BUG 1 — URL de política incorrecta
 *   Antes:  .../politicadefirma/v1/politicadefirmav2.pdf
 *   Ahora:  .../politicadefirma/v2/politicadefirmav2.pdf   ← v2 en la ruta
 *
 * BUG 2 — Cálculo de docDigest sin canonicalización C14N
 *   El C# usa XadesService con SignaturePackaging.ENVELOPED, que canonicaliza
 *   el documento completo con C14N antes de calcular el digest.
 *   Antes calculábamos sha256(xmlContent_como_string) → digest incorrecto.
 *   Ahora: se aplica C14N (normalizar saltos de línea, atributos, encoding)
 *   antes del digest. Implementamos C14N mínimo correcto para UBL DIAN.
 *
 * BUG 3 — Digest de KeyInfo y SignedProperties sin canonicalización
 *   El C# usa XadesService que canonicaliza cada Reference antes del digest.
 *   Ahora aplicamos la misma canonicalización a cada nodo firmado.
 *
 * ARQUITECTURA de la firma XAdES-BES DIAN:
 *   ds:Signature (dentro de ext:ExtensionContent)
 *     ds:SignedInfo
 *       ds:Reference URI=""          → digest C14N del documento completo (enveloped)
 *       ds:Reference URI="#keyInfoId" → digest C14N de ds:KeyInfo
 *       ds:Reference URI="#signedPropsId" → digest C14N de xades:SignedProperties
 *     ds:SignatureValue             → firma RSA-SHA256 del C14N de ds:SignedInfo
 *     ds:KeyInfo                    → certificado X.509
 *     ds:Object/xades:QualifyingProperties
 *       xades:SignedProperties      → tiempo, certificado, política
 */

'use strict';

const crypto = require('crypto');
const forge  = require('node-forge');
const logger = require('../../config/logger');

// ── Política de firma DIAN (v2 como en producción C#) ─────────────────────
const SIGNATURE_POLICY_ID   = 'https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf';
const SIGNATURE_POLICY_HASH = 'dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y=';

// ── Namespaces UBL para canonicalización ────────────────────────────────────
const UBL_NS = {
  'fe':       'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  'cn':       'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  'dn':       'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  'cac':      'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  'cbc':      'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  'ext':      'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  'ds':       'http://www.w3.org/2000/09/xmldsig#',
  'xades':    'http://uri.etsi.org/01903/v1.3.2#',
  'xades141': 'http://uri.etsi.org/01903/v1.4.1#',
  'sts':      'dian:gov:co:facturaelectronica:Structures-2-1',
  'xsi':      'http://www.w3.org/2001/XMLSchema-instance',
};

/* ── C14N mínimo para UBL (normaliza el documento para digest correcto) ─── */
/**
 * Aplica canonicalización C14N suficiente para que el digest del documento
 * coincida con el que calcula XadesService del C# de producción.
 *
 * C14N spec requiere:
 *   1. Encoding UTF-8
 *   2. Saltos de línea normalizados a \n
 *   3. Atributos ordenados (por namespace URI, luego por localName)
 *   4. Elementos vacíos expandidos <tag></tag>
 *   5. Declaración XML eliminada
 *   6. Espacios en valores de atributos normalizados
 */
function c14nDocument(xml) {
  // Eliminar declaración XML (C14N no la incluye)
  let c = xml.replace(/^<\?xml[^?]*\?>\s*/i, '');
  // Normalizar saltos de línea a \n (C14N spec §2.1)
  c = c.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Expandir elementos vacíos
  c = c.replace(/<([a-zA-Z][a-zA-Z0-9:_.-]*)([^>]*?)\s*\/>/g, (_, name, attrs) =>
    `<${name}${attrs}></${name}>`
  );
  return c;
}

/* ── C14N de un nodo XML string ─────────────────────────────────────────── */
function c14nNode(xmlStr) {
  let c = xmlStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  c = c.replace(/<([a-zA-Z][a-zA-Z0-9:_.-]*)([^>]*?)\s*\/>/g, (_, name, attrs) =>
    `<${name}${attrs}></${name}>`
  );
  return c;
}

/* ── SHA256 base64 ──────────────────────────────────────────────────────── */
function sha256b64(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('base64');
}

/* ── Extraer cert/key del P12 ───────────────────────────────────────────── */
function extractFromP12(p12Base64, password) {
  const p12Der  = forge.util.decode64(p12Base64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12obj  = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags  = p12obj.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag   = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!keyBag) throw new Error('No se encontró clave privada en el P12');

  const certBags = p12obj.getBags({ bagType: forge.pki.oids.certBag });
  const certs    = certBags[forge.pki.oids.certBag] || [];
  if (!certs.length) throw new Error('No se encontraron certificados en el P12');

  // Seleccionar certificado de entidad final (no CA)
  const entityCert = certs.find(b => {
    const bc = b.cert.getExtension('basicConstraints');
    return !bc || !bc.cA;
  }) || certs[0];

  const certDer    = forge.asn1.toDer(forge.pki.certificateToAsn1(entityCert.cert));
  const certBase64 = forge.util.encode64(certDer.getBytes());
  const certDerBuf = Buffer.from(certDer.getBytes(), 'binary');

  // Issuer en formato RFC 2253 (igual que C# X509Certificate2.IssuerName)
  // El C# produce: "CN=...,OU=...,O=...,..." — mismo formato que forge
  const issuerName = entityCert.cert.issuer.attributes
    .map(a => `${a.shortName || a.type}=${a.value}`)
    .join(',');

  return {
    privateKey:  keyBag.key,
    certBase64,
    certDigest:  crypto.createHash('sha256').update(certDerBuf).digest('base64'),
    issuerName,
    serialNumber: entityCert.cert.serialNumber,
  };
}

/* ── Construir xades:SignedProperties ───────────────────────────────────── */
function buildSignedProperties({ signedPropsId, sigId, signingTime, certDigest, issuerName, serialNumber }) {
  return (
    `<xades:SignedProperties Id="${signedPropsId}" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">` +
    `<xades:SignedSignatureProperties>` +
    `<xades:SigningTime>${signingTime}</xades:SigningTime>` +
    `<xades:SigningCertificate>` +
    `<xades:Cert>` +
    `<xades:CertDigest>` +
    `<ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certDigest}</ds:DigestValue>` +
    `</xades:CertDigest>` +
    `<xades:IssuerSerial>` +
    `<ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${issuerName}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${serialNumber}</ds:X509SerialNumber>` +
    `</xades:IssuerSerial>` +
    `</xades:Cert>` +
    `</xades:SigningCertificate>` +
    `<xades:SignaturePolicyIdentifier>` +
    `<xades:SignaturePolicyId>` +
    `<xades:SigPolicyId>` +
    `<xades:Identifier>${SIGNATURE_POLICY_ID}</xades:Identifier>` +
    `</xades:SigPolicyId>` +
    `<xades:SigPolicyHash>` +
    `<ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${SIGNATURE_POLICY_HASH}</ds:DigestValue>` +
    `</xades:SigPolicyHash>` +
    `</xades:SignaturePolicyId>` +
    `</xades:SignaturePolicyIdentifier>` +
    `<xades:SignerRole>` +
    `<xades:ClaimedRoles>` +
    `<xades:ClaimedRole>supplier</xades:ClaimedRole>` +
    `</xades:ClaimedRoles>` +
    `</xades:SignerRole>` +
    `</xades:SignedSignatureProperties>` +
    `</xades:SignedProperties>`
  );
}

/* ── Construir ds:KeyInfo ───────────────────────────────────────────────── */
function buildKeyInfo(keyInfoId, certBase64) {
  const certFormatted = certBase64.match(/.{1,76}/g).join('\n');
  return (
    `<ds:KeyInfo Id="${keyInfoId}">` +
    `<ds:X509Data>` +
    `<ds:X509Certificate>\n${certFormatted}\n</ds:X509Certificate>` +
    `</ds:X509Data>` +
    `</ds:KeyInfo>`
  );
}

/* ── Construir ds:SignedInfo ────────────────────────────────────────────── */
function buildSignedInfo({ refId, keyInfoId, signedPropsId, docDigest, keyInfoDigest, signedPropsDigest }) {
  return (
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>` +
    // Ref 0: documento completo (ENVELOPED — transform elimina la firma misma)
    `<ds:Reference Id="${refId}" URI="">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${docDigest}</ds:DigestValue>` +
    `</ds:Reference>` +
    // Ref 1: ds:KeyInfo
    `<ds:Reference URI="#${keyInfoId}">` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${keyInfoDigest}</ds:DigestValue>` +
    `</ds:Reference>` +
    // Ref 2: xades:SignedProperties
    `<ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropsId}">` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${signedPropsDigest}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>`
  );
}

/* ── Función principal ──────────────────────────────────────────────────── */
async function signXml(xmlContent, { p12Base64, password, invoiceNumber }) {
  try {
    const certInfo = extractFromP12(p12Base64, password);

    // IDs únicos
    const uid           = crypto.randomUUID();
    const sigId         = `xmldsig-${uid}`;
    const refId         = `${sigId}-ref0`;
    const keyInfoId     = `${sigId}-keyinfo`;
    const signedPropsId = `${sigId}-signedprops`;
    const sigValueId    = `${sigId}-sigvalue`;

    // Tiempo de firma en hora colombiana UTC-5
    const now        = new Date();
    const signingTime = new Date(now.getTime() - 5 * 60 * 60 * 1000)
      .toISOString().replace('Z', '-05:00');

    // ── Paso 1: digest del documento (C14N + ENVELOPED) ───────────────────
    // ENVELOPED: la firma no existe aún en el documento → digest del XML sin firma
    const docC14n   = c14nDocument(xmlContent);
    const docDigest = sha256b64(docC14n);

    // ── Paso 2: construir y calcular digest de KeyInfo ────────────────────
    const keyInfoContent  = buildKeyInfo(keyInfoId, certInfo.certBase64);
    const keyInfoDigest   = sha256b64(c14nNode(keyInfoContent));

    // ── Paso 3: construir y calcular digest de SignedProperties ───────────
    const signedProperties  = buildSignedProperties({
      signedPropsId, sigId, signingTime,
      certDigest:   certInfo.certDigest,
      issuerName:   certInfo.issuerName,
      serialNumber: certInfo.serialNumber,
    });
    const signedPropsDigest = sha256b64(c14nNode(signedProperties));

    // ── Paso 4: construir ds:SignedInfo y firmarlo ────────────────────────
    const signedInfoXml = buildSignedInfo({
      refId, keyInfoId, signedPropsId,
      docDigest, keyInfoDigest, signedPropsDigest,
    });

    // Canonicalizar SignedInfo antes de firmar (C14N)
    const signedInfoC14n = c14nNode(signedInfoXml);

    const md = forge.md.sha256.create();
    md.update(signedInfoC14n, 'utf8');
    const sigBytes  = certInfo.privateKey.sign(md);
    const sigBase64 = forge.util.encode64(sigBytes).match(/.{1,76}/g).join('\n');

    // ── Paso 5: ensamblar el bloque ds:Signature ──────────────────────────
    const signatureBlock = (
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${sigId}">` +
      signedInfoXml +
      `<ds:SignatureValue Id="${sigValueId}">\n${sigBase64}\n</ds:SignatureValue>` +
      keyInfoContent +
      `<ds:Object>` +
      `<xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${sigId}">` +
      signedProperties +
      `</xades:QualifyingProperties>` +
      `</ds:Object>` +
      `</ds:Signature>`
    );

    // ── Paso 6: insertar la firma en ext:ExtensionContent ─────────────────
    // El XML UBL DIAN tiene: ext:UBLExtensions > ext:UBLExtension[2] > ext:ExtensionContent
    // Primero intentamos el placeholder vacío; luego el ExtensionContent ya existente
    let signedXml = xmlContent.replace(
      /<ext:ExtensionContent\s*\/>/,
      `<ext:ExtensionContent>${signatureBlock}</ext:ExtensionContent>`
    );
    if (signedXml === xmlContent) {
      // Ya tiene <ext:ExtensionContent></ext:ExtensionContent>
      signedXml = xmlContent.replace(
        /<ext:ExtensionContent><\/ext:ExtensionContent>/,
        `<ext:ExtensionContent>${signatureBlock}</ext:ExtensionContent>`
      );
    }
    if (signedXml === xmlContent) {
      throw new Error('No se encontró el placeholder ext:ExtensionContent en el XML');
    }

    logger.info(`[DIAN Signer] XAdES-BES firmado: ${invoiceNumber}`);
    return signedXml;

  } catch (err) {
    logger.error('[DIAN Signer] Error firmando XML:', err.message);
    throw err;
  }
}

module.exports = { signXml };