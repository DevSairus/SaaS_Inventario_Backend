#!/usr/bin/env node
/**
 * dianConnectivityTest.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Diagnóstico DIAN — WS-Security X.509 + WS-Addressing
 *
 * USO:
 *   # Habilitación (default):
 *   node src/services/dian/dianConnectivityTest.js 900072256
 *
 *   # PRODUCCIÓN (prueba definitiva — usa CUFE real de una factura aceptada):
 *   node src/services/dian/dianConnectivityTest.js 900072256 --prod
 *
 *   # Producción con CUFE específico:
 *   node src/services/dian/dianConnectivityTest.js 900072256 --prod --cufe 8466c9a754c0cf52ad0f29e4b7e27e3c66a5692eecd072fe992ebd3c3f6315875feaaf9d27a0e03c80566e5a0b7bb489
 *
 *   # Con P12 alternativo (descarta si es problema del cert):
 *   node src/services/dian/dianConnectivityTest.js 900072256 --p12 C:\certs\otro.pfx --pass MiClave
 *
 *   # Sin DB (variables de entorno):
 *   node src/services/dian/dianConnectivityTest.js --no-db --p12 ruta.pfx --pass clave
 *
 * INTERPRETACIÓN DE RESULTADOS:
 *   InvalidSecurity  → WCF rechazó la firma
 *                      Si la firma local es VÁLIDA: problema de registro/entorno en DIAN
 *                      (verificar en portal DIAN que el software esté registrado)
 *   Error de negocio → ✅ Autenticación OK — el WS-Security funciona correctamente
 *   HTTP 200 OK      → ✅ Todo funciona perfectamente
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

require('dotenv').config();

const https  = require('https');
const net    = require('net');
const dns    = require('dns');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const axios  = require('axios');

// ─── Parsear argumentos CLI ────────────────────────────────────────────────
const args = process.argv.slice(2);
const USE_PRODUCTION = args.includes('--prod');
const NO_DB          = args.includes('--no-db');
const p12FileIdx     = args.indexOf('--p12');
const passIdx        = args.indexOf('--pass');
const cufeIdx        = args.indexOf('--cufe');
const ALT_P12_FILE   = p12FileIdx !== -1 ? args[p12FileIdx + 1] : null;
const ALT_P12_PASS   = passIdx    !== -1 ? args[passIdx    + 1] : null;
const CLI_CUFE       = cufeIdx    !== -1 ? args[cufeIdx    + 1] : null;

const flagValues = new Set([ALT_P12_FILE, ALT_P12_PASS, CLI_CUFE].filter(Boolean));
const TENANT_ARG = args.find(a => !a.startsWith('--') && !flagValues.has(a));

const DIAN_URL  = USE_PRODUCTION
  ? 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc'
  : 'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc';
const DIAN_HOST = new URL(DIAN_URL).hostname;

// CUFE por defecto según entorno:
//   Producción  → factura E2656 de AVM MOTOS (aceptada por DIAN el 2025-12-31)
//   Habilitación → CUFE de prueba genérico
const DEFAULT_CUFE_PROD = '8466c9a754c0cf52ad0f29e4b7e27e3c66a5692eecd072fe992ebd3c3f6315875feaaf9d27a0e03c80566e5a0b7bb489';
const DEFAULT_CUFE_HAB  = 'bf89bb64188f8ee29c642b27b013bebc0902efb921c087269f92755dd1387d7fea681fa58555114c40f9a0886f93c4af';
const TEST_CUFE = CLI_CUFE || (USE_PRODUCTION ? DEFAULT_CUFE_PROD : DEFAULT_CUFE_HAB);

// ─── Signer ────────────────────────────────────────────────────────────────
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
  const ok            = status === 200;
  const hasInvalidSec = body.includes('InvalidSecurity');
  const hasFault      = body.includes('Fault') || body.includes('fault');
  const icon          = ok && !hasFault ? '✅' : '❌';
  console.log(`   ${icon} HTTP ${status || 'ERR'} (${ms}ms)`);

  if (hasInvalidSec) {
    console.log('   ❌ InvalidSecurity — WCF rechazó la firma');
    console.log('      Si la firma local es VÁLIDA: problema de registro en DIAN');
    console.log('      → Verificar en portal DIAN que el software esté registrado');
    if (USE_PRODUCTION) {
      console.log('      → En producción: https://catalogo-vpfe.dian.gov.co');
    } else {
      console.log('      → En habilitación: https://catalogo-vpfe-hab.dian.gov.co');
    }
  } else if (hasFault) {
    const txt  = body.match(/<[^:>]+:Text[^>]*>([^<]+)<\/[^:>]+:Text>/)?.[1]
              || body.match(/<faultstring>([^<]+)<\/faultstring>/)?.[1]
              || 'Error desconocido';
    const code = body.match(/<[^:>]+:Value[^>]*>([^<]+)<\/[^:>]+:Value>/)?.[1] || '';
    if (ok) {
      console.log(`   ✅ Error de negocio (autenticación WS-Security OK): ${code} — ${txt}`);
      console.log('      → El WS-Security funciona. El CUFE puede no existir en este entorno.');
    } else {
      console.log(`   ❌ Fault: ${code} — ${txt}`);
    }
  } else if (ok) {
    const isValid = body.includes('<IsValid>true</IsValid>') || body.includes('<b:IsValid>true</b:IsValid>');
    console.log(`   ✅ Respuesta OK — IsValid: ${isValid ? 'true ✅' : 'false/no aplica'}`);
    if (isValid) console.log('   🎉 DIAN reconoció el documento. WS-Security 100% funcional.');
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

  // ── Obtener configuración ────────────────────────────────────────────────
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
      console.log(`   Certificado: ${cfg.p12Base64
        ? '✅ presente (' + Math.round(cfg.p12Base64.length * 3 / 4 / 1024) + ' KB)'
        : '❌ no configurado'}`);
    } catch (e) {
      console.log(`   ❌ Error DB: ${e.message}`);
      console.log('\n   💡 Usa: node dianConnectivityTest.js --no-db --p12 ruta.pfx --pass clave');
      process.exit(1);
    }
  } else if (NO_DB) {
    cfg = {
      nit:        process.env.DIAN_NIT         || '900072256',
      softwareId: process.env.DIAN_SOFTWARE_ID || '',
      p12Base64:  process.env.DIAN_CERT_P12,
      password:   process.env.DIAN_CERT_PASS   || process.env.DIAN_CERT_PASSWORD || '',
      label:      `NIT ${process.env.DIAN_NIT || '900072256'} (env)`,
    };
  }

  // ── P12 alternativo por CLI ──────────────────────────────────────────────
  if (ALT_P12_FILE) {
    console.log(`\n🔄 P12 alternativo: ${ALT_P12_FILE}`);
    try {
      const p12Buf  = fs.readFileSync(ALT_P12_FILE);
      cfg.p12Base64 = p12Buf.toString('base64');
      cfg.password  = ALT_P12_PASS || cfg.password || '';
      console.log(`   ✅ Cargado (${Math.round(p12Buf.length / 1024)} KB), contraseña: "${cfg.password}"`);
    } catch (e) {
      console.log(`   ❌ No se pudo leer: ${e.message}`);
      process.exit(1);
    }
  }

  if (!cfg.p12Base64) {
    console.log('\n❌ No hay certificado P12 configurado.');
    console.log('   node dianConnectivityTest.js <slug_o_nit>');
    console.log('   node dianConnectivityTest.js --no-db --p12 ruta/cert.pfx --pass clave');
    process.exit(1);
  }

  console.log(`\n── Endpoint: ${DIAN_URL}`);
  console.log(`── CUFE a consultar: ${TEST_CUFE.substring(0, 20)}...`);

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
    console.log(`   Subject:    ${certInfo.subject}`);
    console.log(`   Serial:     ${certInfo.serialHex}`);
    console.log(`   Thumbprint: ${Buffer.from(certInfo.thumbprintB64, 'base64').toString('hex').toUpperCase()}`);
    console.log(`   Válido:     ${certInfo.notBefore.toISOString()} → ${certInfo.notAfter.toISOString()}`);
    if (expired) console.log('   ⚠️  CERTIFICADO VENCIDO');
  } catch (e) {
    console.log(`   ❌ ${e.message}`);
    console.log('   Verifica que la contraseña del P12 sea correcta');
    return;
  }

  const agent = new https.Agent({
    key:                certInfo.keyPem,
    cert:               certInfo.certPem,
    rejectUnauthorized: false,
  });

  // ── 4. WSDL ──────────────────────────────────────────────────────────────
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
    for (const bt of ['TransportBinding', 'AsymmetricBinding', 'SymmetricBinding']) {
      if (wsdlXml.includes(bt)) console.log('   Binding:', bt);
    }
    console.log('   InclusiveNamespaces:', wsdlXml.includes('InclusiveNamespaces') ? 'presente' : 'NO encontrado');
    const spElems = [...new Set((wsdlXml.match(/sp:[\w]+/g) || []))].slice(0, 12);
    if (spElems.length) console.log('   sp: elementos:', spElems.join(', '));
    const wsdlFile = path.join(__dirname, 'dian_wsdl_dump.xml');
    fs.writeFileSync(wsdlFile, wsdlXml, 'utf8');
    console.log('   📄 WSDL guardado:', wsdlFile);
  }

  // ── 5. GetStatus con WS-Security ─────────────────────────────────────────
  console.log('\n5. GetStatus con WS-Security X.509 + WS-Addressing:');
  const soapXml = buildSignedEnvelope({
    action:        `http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatus`,
    endpoint:      DIAN_URL,
    bodyContent:   bodyGetStatus(TEST_CUFE),
    certBase64:    certInfo.certBase64,
    privateKey:    certInfo.privateKey,
    keyPem:        certInfo.keyPem,
    thumbprintB64: certInfo.thumbprintB64,
  });

  console.log(`   Tamaño: ${Buffer.byteLength(soapXml)} bytes`);
  const dumpFile = path.join(__dirname, 'soap_signed_dump.xml');
  fs.writeFileSync(dumpFile, soapXml, 'utf8');
  console.log(`   📄 Dump: ${dumpFile}`);

  // Referencias firmadas
  const refs = [...soapXml.matchAll(/<ds:Reference URI="#([^"]+)"[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/g)];
  const digestMap = Object.fromEntries(refs.map(m => [m[1], m[2]]));
  console.log(`   Referencias firmadas: ${Object.keys(digestMap).join(', ')}`);
  console.log(`   WS-Addressing: a:Action ${digestMap['Action-1'] ? '✅' : '❌'}  a:To ${digestMap['To-1'] ? '✅' : '❌'}`);

  if (process.env.DEBUG_WSS) {
    console.log('\n   Digests:');
    for (const [id, val] of Object.entries(digestMap)) {
      console.log(`     ${id}: ${val}`);
    }
  }

  // ── Auto-verificación local ──────────────────────────────────────────────
  try {
    const sigValMatch  = soapXml.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/);
    const certB64Match = soapXml.match(/<wsse:BinarySecurityToken[^>]*>([^<]+)<\/wsse:BinarySecurityToken>/);
    const siMatch      = soapXml.match(/<ds:SignedInfo>([\s\S]+?)<\/ds:SignedInfo>/);
    if (sigValMatch && certB64Match && siMatch) {
      const canonSI  = '<ds:SignedInfo>' + siMatch[1] + '</ds:SignedInfo>';
      const certPem  = '-----BEGIN CERTIFICATE-----\n'
                     + certB64Match[1].match(/.{1,64}/g).join('\n')
                     + '\n-----END CERTIFICATE-----';
      const sigBytes = Buffer.from(sigValMatch[1].replace(/\s/g, ''), 'base64');
      const ok = crypto.createVerify('RSA-SHA256').update(canonSI, 'utf8').verify(certPem, sigBytes);
      console.log(`   🔐 Auto-verify firma local: ${ok ? '✅ VÁLIDA' : '❌ INVÁLIDA'}`);
      if (ok)  console.log('      → Si DIAN rechaza, es problema de política/registro, no criptografía');
      if (!ok) console.log('      → Error en la firma RSA — revisar extracción de clave del P12');
    } else {
      console.log('   🔐 Auto-verify: no se encontraron todos los elementos para verificar');
    }
  } catch (e) {
    console.log('   Auto-verify error:', e.message);
  }

  printResult('GetStatus', await sendSoap(agent, 'GetStatus', soapXml));

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(68));
  console.log('INTERPRETACIÓN:');
  console.log('  InvalidSecurity + firma VÁLIDA  → Registro/entorno en portal DIAN');
  console.log('  InvalidSecurity + firma INVÁLIDA → Bug en WS-Security (revisar código)');
  console.log('  Error de negocio (HTTP 200)     → ✅ WS-Security OK, CUFE no existe aquí');
  console.log('  IsValid: true                   → ✅ Todo funciona perfectamente');
  console.log('');
  if (USE_PRODUCTION) {
    console.log('  Portales DIAN:');
    console.log('    Producción:   https://catalogo-vpfe.dian.gov.co');
  } else {
    console.log('  Si InvalidSecurity persiste, prueba en producción:');
    console.log('    node dianConnectivityTest.js ' + (TENANT_ARG || '900072256') + ' --prod');
    console.log('  Portal habilitación: https://catalogo-vpfe-hab.dian.gov.co');
  }
  console.log('═'.repeat(68));
}

if (require.main === module) {
  run().catch(e => {
    console.error('\n❌ Error fatal:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  });
}