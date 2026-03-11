cat > /mnt/user-data/outputs/verificar_firma_rsa.js << 'EOJS'
/**
 * VERIFICADOR DE FIRMA RSA — ejecutar en Windows:
 *   node verificar_firma_rsa.js
 *
 * Lee el dump actual y verifica localmente si la firma RSA es matemáticamente
 * válida usando la clave pública del BinarySecurityToken.
 * Si la verificación local pasa pero WCF rechaza → el problema es de política (cert no autorizado).
 * Si la verificación local falla → el problema es en la firma (bug en el código).
 */

const crypto = require('crypto');
const forge  = require('node-forge');
const fs     = require('fs');
const path   = require('path');

const NS = {
  DS:        'http://www.w3.org/2000/09/xmldsig#',
  EXC_C14N:  'http://www.w3.org/2001/10/xml-exc-c14n#',
  RSA_SHA256:'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  SHA256:    'http://www.w3.org/2001/04/xmlenc#sha256',
  WSU:       'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  WCF:       'http://wcf.dian.colombia/',
  SOAP:      'http://www.w3.org/2003/05/soap-envelope',
};

const dumpPath = path.join(__dirname, 'src', 'services', 'dian', 'soap_signed_dump.xml');
const dump = fs.readFileSync(dumpPath, 'utf8');

// ── Extraer valores del dump ──────────────────────────────────────────────────
const certB64Match  = dump.match(/ValueType="[^"]*#X509v3">([A-Za-z0-9+/=\s]+)<\/wsse:BinarySecurityToken>/);
const sigMatch      = dump.match(/<ds:SignatureValue>([A-Za-z0-9+/=\s]+)<\/ds:SignatureValue>/);
const createdMatch  = dump.match(/<wsu:Created>([^<]+)<\/wsu:Created>/);
const expiresMatch  = dump.match(/<wsu:Expires>([^<]+)<\/wsu:Expires>/);
const trackIdMatch  = dump.match(/<wcf:trackId>([^<]+)<\/wcf:trackId>/);
const tsDigestMatch = dump.match(/URI="#TS-1"[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/);
const bdDigestMatch = dump.match(/URI="#Body-1"[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/);

const certDerB64  = certB64Match?.[1].replace(/\s/g, '');
const sigB64      = sigMatch?.[1].replace(/\s/g, '');
const created     = createdMatch?.[1];
const expires     = expiresMatch?.[1];
const trackId     = trackIdMatch?.[1];
const tsDigest    = tsDigestMatch?.[1];
const bodyDigest  = bdDigestMatch?.[1];

console.log('=== DATOS EXTRAÍDOS ===');
console.log('Cert DER (primeros 20 chars):', certDerB64?.substring(0, 20) + '...');
console.log('Firma (primeros 20 chars)    :', sigB64?.substring(0, 20) + '...');
console.log('Created:', created, ' Expires:', expires);
console.log('TS Digest  :', tsDigest);
console.log('Body Digest:', bodyDigest);
console.log('');

// ── Reconstruir el SignedInfo canónico (SIN xmlns:ds) ────────────────────────
// Este es el string sobre el cual WCF verifica la firma
const signedInfo =
  '<ds:SignedInfo>' +
  `<ds:CanonicalizationMethod Algorithm="${NS.EXC_C14N}"/>` +
  `<ds:SignatureMethod Algorithm="${NS.RSA_SHA256}"/>` +
  `<ds:Reference URI="#TS-1">` +
    `<ds:Transforms><ds:Transform Algorithm="${NS.EXC_C14N}"/></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${NS.SHA256}"/>` +
    `<ds:DigestValue>${tsDigest}</ds:DigestValue>` +
  `</ds:Reference>` +
  `<ds:Reference URI="#Body-1">` +
    `<ds:Transforms><ds:Transform Algorithm="${NS.EXC_C14N}"/></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${NS.SHA256}"/>` +
    `<ds:DigestValue>${bodyDigest}</ds:DigestValue>` +
  `</ds:Reference>` +
  '</ds:SignedInfo>';

console.log('=== SignedInfo canónico para verificar ===');
console.log(signedInfo);
console.log('');

// ── Verificar con la clave pública del cert ───────────────────────────────────
try {
  // Parsear el cert del BinarySecurityToken
  const certDer  = Buffer.from(certDerB64, 'base64');
  const certAsn1 = forge.asn1.fromDer(forge.util.createBuffer(certDer));
  const cert     = forge.pki.certificateFromAsn1(certAsn1);
  const pubKeyPem = forge.pki.publicKeyToPem(cert.publicKey);

  console.log('Cert subject:', cert.subject.attributes.map(a => `${a.shortName}=${a.value}`).join(', '));
  console.log('');

  // Verificar con Node.js crypto (más fiable que forge para verificación)
  const sigBuffer        = Buffer.from(sigB64, 'base64');
  const signedInfoBuffer = Buffer.from(signedInfo, 'utf8');

  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(signedInfoBuffer);
  const valid = verify.verify(pubKeyPem, sigBuffer);

  console.log('=== RESULTADO VERIFICACIÓN RSA-SHA256 ===');
  if (valid) {
    console.log('✅ FIRMA VÁLIDA — la firma RSA es matemáticamente correcta.');
    console.log('');
    console.log('Si WCF aún rechaza con InvalidSecurity, el problema es de POLÍTICA:');
    console.log('→ El certificado no está en la lista de confianza del portal DIAN.');
    console.log('→ El NIT en el cert no coincide con el NIT del software registrado.');
    console.log('→ El software no está autorizado para ese NIT en catalogo-vpfe-hab.dian.gov.co.');
    console.log('');
    console.log('ACCIÓN: Verificar en https://catalogo-vpfe-hab.dian.gov.co/User/Login');
    console.log('que el NIT 900072256 tiene el software 94e5a334-... activo.');
  } else {
    console.log('❌ FIRMA INVÁLIDA — hay un bug en la generación de la firma RSA.');
    console.log('');
    console.log('Causas posibles:');
    console.log('1. El SignedInfo que se firmó difiere del que se reconstruye aquí.');
    console.log('   → Verificar que buildCanonicalSignedInfo() produce exactamente este string.');
    console.log('2. La clave privada no corresponde al cert del BinarySecurityToken.');
    console.log('   → Verificar que extractFromP12() usa el mismo cert para ambos.');
    console.log('3. forge.privateKey.sign() usa padding diferente al esperado.');
  }
} catch (e) {
  console.error('Error verificando:', e.message);
}
EOJS