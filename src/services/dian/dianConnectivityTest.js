#!/usr/bin/env node
/**
 * dianConnectivityTest.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Diagnóstico DIAN — WS-Security X.509 + WS-Addressing
 *
 * USO:
 *   # Tomar datos del tenant en la DB (por slug o NIT):
 *   node src/services/dian/dianConnectivityTest.js avmmotos
 *   node src/services/dian/dianConnectivityTest.js 900072256
 *
 *   # Probar con un P12/PFX alternativo (descarta si es problema del cert):
 *   node src/services/dian/dianConnectivityTest.js avmmotos --p12 C:\certs\otro.pfx --pass MiClave
 *
 *   # Modo producción:
 *   node src/services/dian/dianConnectivityTest.js avmmotos --prod
 *
 *   # Sin DB (hardcoded):
 *   node src/services/dian/dianConnectivityTest.js --no-db
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();

const https  = require('https');
const http   = require('http');
const net    = require('net');
const dns    = require('dns');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const forge  = require('node-forge');
const axios  = require('axios');

// ─── Parsear argumentos CLI ────────────────────────────────────────────────
const args = process.argv.slice(2);
const USE_PRODUCTION = args.includes('--prod');
const NO_DB          = args.includes('--no-db');
const p12FileIdx     = args.indexOf('--p12');
const passIdx        = args.indexOf('--pass');
const ALT_P12_FILE   = p12FileIdx !== -1 ? args[p12FileIdx + 1] : null;
const ALT_P12_PASS   = passIdx    !== -1 ? args[passIdx    + 1] : null;
// Valores de flags que no son el tenant
const flagValues = new Set([
  ALT_P12_FILE, ALT_P12_PASS,
].filter(Boolean));
// Primer argumento posicional que no sea flag ni valor de flag
const TENANT_ARG = args.find(a => !a.startsWith('--') && !flagValues.has(a));

const DIAN_URL = USE_PRODUCTION
  ? 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc'
  : 'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc';
const DIAN_HOST = new URL(DIAN_URL).hostname;

// ─── Signer (ExcC14N con contexto real) ─────────────────────────────────────
const { extractFromP12, buildSignedEnvelope, NS } = require('./dianWssSigner');

// ─── SOAP transport ────────────────────────────────────────────────────────
async function sendSoap(agent, actionName, xml) {
  const t0 = Date.now();
  try {
    const r = await axios.post(DIAN_URL, xml, {
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="http://wcf.dian.colombia/IWcfDianCustomerServices/${actionName}"`,
      },
      httpsAgent: agent, timeout: 30000,
      responseType: 'text', validateStatus: () => true,
    });
    return { status: r.status, body: String(r.data || ''), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: e.message, ms: Date.now() - t0 };
  }
}

// ─── Cuerpos SOAP ──────────────────────────────────────────────────────────
const bodyGetStatus = t =>
  `<wcf:GetStatus xmlns:wcf="${NS.WCF}"><wcf:trackId>${t}</wcf:trackId></wcf:GetStatus>`;

// ─── Obtener tenant de la DB ───────────────────────────────────────────────
async function getTenantFromDB(slugOrNit) {
  const { sequelize } = require('../../config/database');
  const Tenant = require('../../models/auth/Tenant');
  await sequelize.authenticate();
  const { Op } = require('sequelize');
  const tenant = await Tenant.findOne({
    where: {
      [Op.or]: [
        { slug:   slugOrNit },
        { tax_id: slugOrNit },
      ],
    },
  });
  if (!tenant) throw new Error(`Tenant "${slugOrNit}" no encontrado en la DB`);
  return tenant;
}

// ─── Imprimir resultado SOAP ───────────────────────────────────────────────
function printResult(label, { status, body, ms }) {
  const ok = status === 200;
  const hasInvalidSec = body.includes('InvalidSecurity');
  const hasFault = body.includes('Fault') || body.includes('fault');
  const icon = ok && !hasFault ? '✅' : '❌';
  console.log(`   ${icon} HTTP ${status || 'ERR'} (${ms}ms)`);
  if (hasInvalidSec) {
    console.log('   ❌ InvalidSecurity — firma no verificada por WCF');
  } else if (hasFault) {
    const txt = body.match(/<[^:>]+:Text[^>]*>([^<]+)<\/[^:>]+:Text>/)?.[1]
             || body.match(/<faultstring>([^<]+)<\/faultstring>/)?.[1]
             || 'Error desconocido';
    const code = body.match(/<[^:>]+:Value[^>]*>([^<]+)<\/[^:>]+:Value>/)?.[1] || '';
    if (ok) {
      console.log(`   ✅ Error de negocio (autenticación OK): ${code} — ${txt}`);
    } else {
      console.log(`   ❌ Fault: ${code} — ${txt}`);
    }
  } else if (ok) {
    const isValid = body.includes('<IsValid>true</IsValid>') || body.includes('<b:IsValid>true</b:IsValid>');
    console.log(`   ✅ Respuesta OK — IsValid: ${isValid ? 'true' : 'false/no aplica'}`);
  }
  console.log(`   Respuesta (600 chars): ${body.substring(0, 600)}`);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function run() {
  console.log('');
  console.log('═'.repeat(68));
  console.log('  DIAGNÓSTICO DIAN — WS-Security X.509 + WS-Addressing');
  console.log(`  Ambiente: ${USE_PRODUCTION ? '🔴 PRODUCCIÓN' : '🟡 HABILITACIÓN'}`);
  console.log('═'.repeat(68));

  // ── Obtener configuración ──────────────────────────────────────────────
  let cfg = {};

  if (!NO_DB && TENANT_ARG) {
    console.log(`\n📋 Cargando tenant "${TENANT_ARG}" desde DB...`);
    try {
      const tenant = await getTenantFromDB(TENANT_ARG);
      const dc = tenant.dian_config || {};
      cfg = {
        nit:        dc.nit || tenant.tax_id,
        softwareId: dc.software_id,
        p12Base64:  dc.certificate_p12_base64,
        password:   dc.certificate_password,
        label:      `${tenant.company_name} (${dc.nit || tenant.tax_id})`,
      };
      console.log(`   ✅ Tenant: ${tenant.company_name}`);
      console.log(`   NIT:        ${cfg.nit}`);
      console.log(`   Software ID: ${cfg.softwareId || '(no configurado)'}`);
      console.log(`   Certificado: ${cfg.p12Base64 ? '✅ presente (' + Math.round(cfg.p12Base64.length*3/4/1024) + ' KB)' : '❌ no configurado'}`);
    } catch (e) {
      console.log(`   ❌ Error DB: ${e.message}`);
      console.log(`   Stack: ${e.stack}`);
      console.log('\n   💡 Si el error es de conexión, verifica que el .env esté cargado');
      console.log('   o usa: node src/services/dian/dianConnectivityTest.js --no-db --p12 ruta.pfx --pass clave');
      process.exit(1);
    }
  } else if (NO_DB) {
    // Hardcoded fallback para pruebas sin DB
    cfg = {
      nit:        process.env.DIAN_NIT        || '900072256',
      softwareId: process.env.DIAN_SOFTWARE_ID || '94e5a334-3c1b-40f6-a8e1-7f2ec1fee692',
      p12Base64:  process.env.DIAN_CERT_P12,
      password:   process.env.DIAN_CERT_PASS  || process.env.DIAN_CERT_PASSWORD,
      label:      `NIT ${process.env.DIAN_NIT || '900072256'} (hardcoded)`,
    };
  }

  // ── P12 alternativo por CLI ────────────────────────────────────────────
  if (ALT_P12_FILE) {
    console.log(`\n🔄 P12 alternativo: ${ALT_P12_FILE}`);
    try {
      const p12Buf = fs.readFileSync(ALT_P12_FILE);
      cfg.p12Base64 = p12Buf.toString('base64');
      cfg.password  = ALT_P12_PASS || cfg.password || '';
      console.log(`   ✅ Cargado (${Math.round(p12Buf.length/1024)} KB), contraseña: "${cfg.password}"`);
    } catch (e) {
      console.log(`   ❌ No se pudo leer: ${e.message}`);
      process.exit(1);
    }
  }

  if (!cfg.p12Base64) {
    console.log('\n❌ No hay certificado P12. Usa:');
    console.log('   node dianConnectivityTest.js <slug_o_nit>');
    console.log('   node dianConnectivityTest.js --no-db --p12 ruta/cert.pfx --pass clave');
    process.exit(1);
  }

  console.log(`\n── Endpoint: ${DIAN_URL}`);

  // ── 1. DNS ──────────────────────────────────────────────────────────────
  process.stdout.write('\n1. DNS... ');
  try {
    const addrs = await dns.promises.lookup(DIAN_HOST, { all: true });
    console.log(`✅ ${addrs.map(x => x.address).join(', ')}`);
  } catch (e) { console.log(`❌ ${e.message}`); return; }

  // ── 2. TCP ───────────────────────────────────────────────────────────────
  process.stdout.write('2. TCP 443... ');
  await new Promise(resolve => {
    const s = net.createConnection({ host: DIAN_HOST, port: 443 });
    s.setTimeout(8000);
    s.on('connect', () => { console.log('✅'); s.destroy(); resolve(); });
    s.on('error',   e  => { console.log(`❌ ${e.message}`); resolve(); });
    s.on('timeout', () => { console.log('❌ TIMEOUT'); s.destroy(); resolve(); });
  });

  // ── 3. Extraer certificado ───────────────────────────────────────────────
  console.log('\n3. Extrayendo certificado X.509 del P12...');
  let certInfo;
  try {
    certInfo = extractFromP12(cfg.p12Base64, cfg.password || '');
    const now     = new Date();
    const expired = now < certInfo.notBefore || now > certInfo.notAfter;
    console.log(`   ✅ OK`);
    console.log(`   Subject: ${certInfo.subject}`);
    console.log(`   Serial : ${certInfo.serialHex}`);
    console.log(`   Válido : ${certInfo.notBefore.toISOString()} → ${certInfo.notAfter.toISOString()}`);
    if (expired) console.log('   ⚠️  CERTIFICADO VENCIDO');
  } catch (e) {
    console.log(`   ❌ ${e.message}`);
    console.log('   Verifica que la contraseña sea correcta');
    return;
  }

  // Agente mTLS
  const agent = new https.Agent({
    key:                certInfo.keyPem,
    cert:               certInfo.certPem,
    rejectUnauthorized: false,
  });

  // ── 4. WSDL + Análisis de política de seguridad ─────────────────────────
  process.stdout.write('\n4. WSDL... ');
  let wsdlXml = '';
  try {
    const r = await axios.get(`${DIAN_URL}?wsdl`, { httpsAgent: agent, timeout: 15000 });
    console.log(`✅ HTTP ${r.status}`);
    wsdlXml = r.data || '';
  } catch (e) { console.log(`❌ ${e.message}`); }

  if (wsdlXml) {
    console.log('\n   🔍 Política WS-Security del WSDL:');
    const algoMatch = wsdlXml.match(/<[\w:]*AlgorithmSuite[^>]*>([^<]+)<\/[\w:]*AlgorithmSuite>/);
    if (algoMatch) console.log('   AlgorithmSuite:', algoMatch[1].trim());
    for (const bt of ['TransportBinding','AsymmetricBinding','SymmetricBinding']) {
      if (wsdlXml.includes(bt)) console.log('   Binding:', bt);
    }
    if (wsdlXml.includes('InclusiveNamespaces')) {
      const m = wsdlXml.match(/InclusiveNamespaces[^>]*/);
      console.log('   InclusiveNamespaces:', m ? m[0] : 'presente');
    } else {
      console.log('   InclusiveNamespaces: NO encontrado');
    }
    const spElems = [...new Set((wsdlXml.match(/sp:[\w]+/g) || []))].slice(0, 12);
    if (spElems.length) console.log('   sp: elementos:', spElems.join(', '));
    const wsdlFile = path.join(__dirname, 'dian_wsdl_dump.xml');
    fs.writeFileSync(wsdlFile, wsdlXml, 'utf8');
    console.log('   📄 WSDL guardado:', wsdlFile);
  }

  // ── 5. GetStatus firmado ──────────────────────────────────────────────────
  console.log('\n5. GetStatus con WS-Security X.509 + WS-Addressing:');
  const TEST_CUFE = 'bf89bb64188f8ee29c642b27b013bebc0902efb921c087269f92755dd1387d7fea681fa58555114c40f9a0886f93c4af';
  const soapXml = buildSignedEnvelope({
    action:      `http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatus`,
    endpoint:    DIAN_URL,
    bodyContent: bodyGetStatus(TEST_CUFE),
    certBase64:    certInfo.certBase64,
    privateKey:    certInfo.privateKey,
    keyPem:        certInfo.keyPem,
    thumbprintB64: certInfo.thumbprintB64,
  });

  console.log(`   Tamaño: ${Buffer.byteLength(soapXml)} bytes`);
  const dumpFile = path.join(__dirname, 'soap_signed_dump.xml');
  fs.writeFileSync(dumpFile, soapXml, 'utf8');
  console.log(`   📄 Dump: ${dumpFile}`);

  // Auto-verificar digest canónicos antes de enviar
  const { checkDigests } = (() => {
    const xml = soapXml;
    const extractDigests = () => {
      const refs = [...xml.matchAll(/<ds:Reference URI="#([^"]+)"[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/g)];
      return Object.fromEntries(refs.map(m => [m[1], m[2]]));
    };
    return { checkDigests: extractDigests };
  })();
  const digests = checkDigests();
  console.log(`   Referencias firmadas: ${Object.keys(digests).join(', ')}`);
  const hasAction = Object.keys(digests).includes('Action-1');
  const hasTo     = Object.keys(digests).includes('To-1');
  console.log(`   WS-Addressing: a:Action ${hasAction ? '✅' : '❌'}  a:To ${hasTo ? '✅' : '❌'}`);

  // ── Auto-verificación local de firma ANTES de enviar a DIAN ──────────────
  // Si pasa aquí pero WCF rechaza → el problema es política/cert, no criptografía
  try {
    const sigValMatch  = soapXml.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/);
    const certB64Match = soapXml.match(/<wsse:BinarySecurityToken[^>]*>([^<]+)<\/wsse:BinarySecurityToken>/);
    const siMatch      = soapXml.match(/<ds:SignedInfo>([\s\S]+?)<\/ds:SignedInfo>/);
    if (sigValMatch && certB64Match && siMatch) {
      const canonSI  = '<ds:SignedInfo>' + siMatch[1] + '</ds:SignedInfo>';
      const certPem  = '-----BEGIN CERTIFICATE-----\n' + certB64Match[1].match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----';
      const sigBytes = Buffer.from(sigValMatch[1].replace(/\s/g,''), 'base64');
      const ok = require('crypto').createVerify('RSA-SHA256').update(canonSI,'utf8').verify(certPem, sigBytes);
      console.log(`   🔐 Auto-verify firma local: ${ok ? '✅ VÁLIDA' : '❌ INVÁLIDA'}`);
      if (ok) console.log('      → Si DIAN rechaza, es problema de política/cert no criptográfico');
    }
  } catch(e) { console.log('   Auto-verify error:', e.message); }

  printResult('GetStatus', await sendSoap(agent, 'GetStatus', soapXml));

  // ── 6. Resumen ────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(68));
  console.log('INTERPRETACIÓN:');
  console.log('  InvalidSecurity  → WCF rechazó la firma (ver dump para analizar)');
  console.log('  Error de negocio → ✅ Autenticación OK, problema en datos/CUFE');
  console.log('  HTTP 200 OK      → ✅ Todo funciona correctamente');
  console.log('═'.repeat(68));
}

// ⚠️  Solo ejecutar si es el script principal (no si es require'd por el servidor)
if (require.main === module) {
  run().catch(e => {
    console.error('\n❌ Error fatal:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  });
}