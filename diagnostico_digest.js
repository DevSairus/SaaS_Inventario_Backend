/**
 * DIAGNÓSTICO DE DIGESTS — ejecutar en Windows con:
 *   node diagnostico_digests.js
 *
 * Compara los 3 posibles canonicals del Timestamp contra el DigestValue
 * que aparece en soap_signed_dump.xml para determinar cuál coincide con
 * lo que WCF verificará.
 *
 * Resultado esperado: UNO solo debe coincidir con el dump.
 * Ese es el canonical que el código usó para firmar.
 * Si ese mismo coincide con lo que WCF computa → firma válida.
 * Si no coincide → ese es el bug.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const NS_WSU  = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const NS_SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const NS_WCF  = 'http://wcf.dian.colombia/';

// Leer el dump generado por el script de diagnóstico
const dumpPath = path.join(__dirname, 'src', 'services', 'dian', 'soap_signed_dump.xml');
const dump = fs.readFileSync(dumpPath, 'utf8');

// Extraer valores del dump
const tsDigestMatch   = dump.match(/URI="#TS-1"[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/);
const bodyDigestMatch = dump.match(/URI="#Body-1"[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/);
const createdMatch    = dump.match(/<wsu:Created>([^<]+)<\/wsu:Created>/);
const expiresMatch    = dump.match(/<wsu:Expires>([^<]+)<\/wsu:Expires>/);
const trackIdMatch    = dump.match(/<wcf:trackId>([^<]+)<\/wcf:trackId>/);

const tsDigest   = tsDigestMatch?.[1];
const bodyDigest = bodyDigestMatch?.[1];
const created    = createdMatch?.[1];
const expires    = expiresMatch?.[1];
const trackId    = trackIdMatch?.[1];

console.log('=== VALORES EXTRAÍDOS DEL DUMP ===');
console.log('Created   :', created);
console.log('Expires   :', expires);
console.log('TS Digest  :', tsDigest);
console.log('Body Digest:', bodyDigest);
console.log('TrackId    :', trackId?.substring(0,20) + '...');
console.log('');

// ── TIMESTAMP ──
// La estructura en el Envelope final:
// soap:Envelope (xmlns:soap, xmlns:wsu)      ← wsu en scope desde aquí
//   soap:Header
//     wsse:Security (xmlns:wsse, xmlns:wsu redeclarado)  ← wsu también aquí
//       wsu:Timestamp (wsu:Id="TS-1")        ← wsu ya en scope del ancestro
//
// ExcC14N dice: incluir un NS en un nodo si:
//   1. Es visiblemente utilizado en ese nodo O sus descendientes, Y
//   2. No fue "renderizado" en ningún ancestro del nodo en la salida
// 
// wsu: está en scope del Envelope (ancestro) → fue "renderizado" allí → NO incluir en Timestamp
// PERO: si Node.js hace ExcC14N standalone (sin contexto), NO ve que wsu: ya fue renderizado
//        → SÍ incluye xmlns:wsu en canonTS

console.log('=== ANÁLISIS TIMESTAMP ===');
const tsVariants = [
  ['CON xmlns:wsu (código actual, ExcC14N standalone)',
   `<wsu:Timestamp xmlns:wsu="${NS_WSU}" wsu:Id="TS-1"><wsu:Created>${created}</wsu:Created><wsu:Expires>${expires}</wsu:Expires></wsu:Timestamp>`],
  ['SIN xmlns:wsu (ExcC14N en contexto del Envelope — lo que computa WCF)',
   `<wsu:Timestamp wsu:Id="TS-1"><wsu:Created>${created}</wsu:Created><wsu:Expires>${expires}</wsu:Expires></wsu:Timestamp>`],
];

let tsCodeVariant = null;
let tsWCFVariant  = null;
for (const [label, canon] of tsVariants) {
  const d = crypto.createHash('sha256').update(canon).digest('base64');
  const match = d === tsDigest ? '✅ COINCIDE CON DUMP' : '❌ no coincide';
  console.log(`[${match}] ${label}`);
  console.log(`         digest: ${d}`);
  if (d === tsDigest && label.includes('standalone')) tsCodeVariant = canon;
  if (d === tsDigest && label.includes('WCF'))        tsWCFVariant  = canon;
}

console.log('');
console.log('=== ANÁLISIS BODY ===');
const bodyVariants = [
  ['CON xmlns:wsu en Body (Envelope tiene wsu en scope → WCF lo incluye)',
   `<soap:Body xmlns:soap="${NS_SOAP}" xmlns:wsu="${NS_WSU}" wsu:Id="Body-1"><wcf:GetStatus xmlns:wcf="${NS_WCF}"><wcf:trackId>${trackId}</wcf:trackId></wcf:GetStatus></soap:Body>`],
  ['SIN xmlns:wsu en Body',
   `<soap:Body xmlns:soap="${NS_SOAP}" wsu:Id="Body-1"><wcf:GetStatus xmlns:wcf="${NS_WCF}"><wcf:trackId>${trackId}</wcf:trackId></wcf:GetStatus></soap:Body>`],
];

for (const [label, canon] of bodyVariants) {
  const d = crypto.createHash('sha256').update(canon).digest('base64');
  const match = d === bodyDigest ? '✅ COINCIDE CON DUMP' : '❌ no coincide';
  console.log(`[${match}] ${label}`);
  console.log(`         digest: ${d}`);
}

console.log('');
console.log('=== CONCLUSIÓN ===');
console.log('');
console.log('El digest del TS en el dump es el que el CÓDIGO calculó y firmó.');
console.log('WCF verifica contra su propio ExcC14N del TS en contexto del Envelope.');
console.log('');
console.log('SI el código firmó CON xmlns:wsu y WCF verifica SIN xmlns:wsu → MISMATCH → InvalidSecurity.');
console.log('SI ambos coinciden → el problema está en la firma RSA o en el certificado.');
console.log('');
console.log('ACCIÓN REQUERIDA:');
console.log('Comparte esta salida con el asistente para determinar el fix exacto.');