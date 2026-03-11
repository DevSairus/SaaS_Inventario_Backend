// backend/src/services/dian/dianApiService.js
/**
 * Cliente WS DIAN — con WS-Security X.509 + WS-Addressing firmados.
 * Fix: se agregan a:Action y a:To al envelope Y se firman junto con TS y Body.
 */
'use strict';

const https  = require('https');
const axios  = require('axios');
const logger = require('../../config/logger');
const { extractFromP12, buildSignedEnvelope, NS } = require('./dianWssSigner');

const ENDPOINTS = {
  test:       'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc',
  production: 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc',
};

const WCF_BASE = 'http://wcf.dian.colombia/IWcfDianCustomerServices/';

// Caché del P12 parseado
let _certCache = null, _certCacheKey = null;
function getCertInfo(p12Base64, password) {
  if (!p12Base64 || p12Base64 === '[CONFIGURADO]') {
    throw new Error('Certificado digital no configurado. Cargue el archivo P12 en la configuración DIAN.');
  }
  if (!password || password === '[CONFIGURADO]') {
    throw new Error('Contraseña del certificado no configurada. Ingrésela en la configuración DIAN.');
  }
  const key = p12Base64.slice(0, 32) + ':' + password;
  if (_certCache && _certCacheKey === key) return _certCache;
  _certCache = extractFromP12(p12Base64, password);
  _certCacheKey = key;
  return _certCache;
}

function buildAgent(certInfo) {
  return new https.Agent({
    key: certInfo.keyPem, cert: certInfo.certPem,
    rejectUnauthorized: false, keepAlive: true, timeout: 120000,
  });
}

// Cuerpos SOAP
function bodyGetStatus(trackId) {
  return `<wcf:GetStatus xmlns:wcf="${NS.WCF}"><wcf:trackId>${trackId}</wcf:trackId></wcf:GetStatus>`;
}
function bodyGetStatusZip(zipKey) {
  return `<wcf:GetStatusZip xmlns:wcf="${NS.WCF}"><wcf:trackId>${zipKey}</wcf:trackId></wcf:GetStatusZip>`;
}
function bodyGetNumberingRange(nit, softwareId) {
  return `<wcf:GetNumberingRange xmlns:wcf="${NS.WCF}"><wcf:accountCode>${nit}</wcf:accountCode><wcf:accountCodeT>${nit}</wcf:accountCodeT><wcf:softwareCode>${softwareId}</wcf:softwareCode></wcf:GetNumberingRange>`;
}
function bodySendBillSync(fileName, content64) {
  return `<wcf:SendBillSync xmlns:wcf="${NS.WCF}"><wcf:fileName>${fileName}</wcf:fileName><wcf:contentFile>${content64}</wcf:contentFile></wcf:SendBillSync>`;
}
function bodySendTestSetAsync(fileName, content64, testSetId) {
  return `<wcf:SendTestSetAsync xmlns:wcf="${NS.WCF}"><wcf:fileName>${fileName}</wcf:fileName><wcf:contentFile>${content64}</wcf:contentFile><wcf:testSetId>${testSetId}</wcf:testSetId></wcf:SendTestSetAsync>`;
}

// Transporte
async function soapRequest(endpoint, actionName, soapXml, agent) {
  const start = Date.now();
  try {
    const r = await axios.post(endpoint, soapXml, {
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${WCF_BASE}${actionName}"`,
        'Accept': 'application/soap+xml, text/xml',
      },
      httpsAgent: agent, timeout: 120000,
      responseType: 'text', maxContentLength: Infinity, maxBodyLength: Infinity,
    });
    const body = String(r.data || '');
    logger.info(`[DIAN] <- ${actionName} HTTP ${r.status} (${Date.now()-start}ms) ${body.length}b`);
    return { statusCode: r.status, body };
  } catch (err) {
    if (err.response) {
      const body = String(err.response.data || '');
      logger.warn(`[DIAN] <- ${actionName} HTTP ${err.response.status} ERROR: ${body.substring(0,400)}`);
      return { statusCode: err.response.status, body };
    }
    logger.error(`[DIAN] Red: ${actionName}: ${err.message}`);
    throw err;
  }
}

// Parsers XML
function parseXmlValue(xml, tag) {
  const re = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseSoapResponse(xml) {
  if (xml.includes('Fault') || xml.includes('fault')) {
    const faultStr  = parseXmlValue(xml, 'Text') || parseXmlValue(xml, 'faultstring');
    const faultCode = parseXmlValue(xml, 'Value') || parseXmlValue(xml, 'faultcode');
    if (faultStr || faultCode) {
      return { isValid: false, statusCode: faultCode || 'FAULT',
               statusDescription: faultStr, statusMessage: faultStr,
               xmlDocumentKey: null, transactionId: null, isFault: true, raw: xml };
    }
  }
  const isValidRaw = parseXmlValue(xml, 'IsValid');
  const statusCode = parseXmlValue(xml, 'StatusCode');
  return {
    isValid: isValidRaw === 'true' || statusCode === '00',
    statusCode,
    statusDescription: parseXmlValue(xml, 'StatusDescription'),
    statusMessage: parseXmlValue(xml, 'StatusMessage') ||
                   parseXmlValue(xml, 'ErrorMessage') ||
                   parseXmlValue(xml, 'ProcessedMessage'),
    xmlDocumentKey: parseXmlValue(xml, 'XmlDocumentKey') || parseXmlValue(xml, 'ZipKey'),
    transactionId: parseXmlValue(xml, 'TransactionID'),
    raw: xml,
  };
}

// ZIP builder
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ _crcTable[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function createZip(fileContent, fileName) {
  const nb = Buffer.from(fileName, 'utf8');
  const crc = crc32(fileContent);
  const now = new Date();
  const dd = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
  const dt = (now.getHours()<<11)|(now.getMinutes()<<5)|Math.floor(now.getSeconds()/2);
  const lh = Buffer.alloc(30 + nb.length);
  lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
  lh.writeUInt16LE(0,8); lh.writeUInt16LE(dt,10); lh.writeUInt16LE(dd,12);
  lh.writeUInt32LE(crc,14); lh.writeUInt32LE(fileContent.length,18);
  lh.writeUInt32LE(fileContent.length,22); lh.writeUInt16LE(nb.length,26);
  lh.writeUInt16LE(0,28); nb.copy(lh,30);
  const cd = Buffer.alloc(46 + nb.length);
  cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6);
  cd.writeUInt16LE(0,8); cd.writeUInt16LE(0,10); cd.writeUInt16LE(dt,12);
  cd.writeUInt16LE(dd,14); cd.writeUInt32LE(crc,16);
  cd.writeUInt32LE(fileContent.length,20); cd.writeUInt32LE(fileContent.length,24);
  cd.writeUInt16LE(nb.length,28); cd.writeUInt16LE(0,30); cd.writeUInt16LE(0,32);
  cd.writeUInt16LE(0,34); cd.writeUInt16LE(0,36); cd.writeUInt32LE(0,38);
  cd.writeUInt32LE(0,42); nb.copy(cd,46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(1,8); eocd.writeUInt16LE(1,10);
  eocd.writeUInt32LE(cd.length,12); eocd.writeUInt32LE(lh.length+fileContent.length,16);
  eocd.writeUInt16LE(0,20);
  return Buffer.concat([lh, fileContent, cd, eocd]);
}

// Helper central: construir y enviar SOAP firmado con WS-Addressing
async function signedCall({ p12Base64, password, environment, actionName, bodyContent }) {
  const certInfo = getCertInfo(p12Base64, password);
  const agent    = buildAgent(certInfo);
  const endpoint = ENDPOINTS[environment] || ENDPOINTS.test;
  const action   = WCF_BASE + actionName;

  const soapXml = buildSignedEnvelope({
    action, endpoint, bodyContent,
    certBase64:    certInfo.certBase64,
    privateKey:    certInfo.privateKey,
    keyPem:        certInfo.keyPem,
    thumbprintB64: certInfo.thumbprintB64,
  });

  logger.info(`[DIAN] -> ${actionName} | ${environment} | ${Buffer.byteLength(soapXml)}b`);
  return soapRequest(endpoint, actionName, soapXml, agent);
}

// ─── API Pública ──────────────────────────────────────────────────────────────

async function getStatus({ cufe, p12Base64, password, environment = 'test' }) {
  const r = await signedCall({ p12Base64, password, environment, actionName: 'GetStatus', bodyContent: bodyGetStatus(cufe) });
  return parseSoapResponse(r.body);
}

async function getStatusZip({ zipKey, p12Base64, password, environment = 'test' }) {
  const r = await signedCall({ p12Base64, password, environment, actionName: 'GetStatusZip', bodyContent: bodyGetStatusZip(zipKey) });
  return parseSoapResponse(r.body);
}

async function getNumberingRange({ nit, softwareId, p12Base64, password, environment = 'production' }) {
  const r = await signedCall({ p12Base64, password, environment, actionName: 'GetNumberingRange', bodyContent: bodyGetNumberingRange(nit, softwareId) });
  return parseSoapResponse(r.body);
}

async function sendBillSync({ xmlContent, nit, invoiceNumber, p12Base64, password, environment = 'production' }) {
  const zipBuf = createZip(Buffer.from(xmlContent,'utf8'), `${nit}${invoiceNumber}.xml`);
  const r = await signedCall({ p12Base64, password, environment, actionName: 'SendBillSync',
    bodyContent: bodySendBillSync(`${nit}${invoiceNumber}.zip`, zipBuf.toString('base64')) });
  return parseSoapResponse(r.body);
}

async function sendTestSetAsync({ xmlContent, nit, invoiceNumber, testSetId, p12Base64, password, environment = 'test' }) {
  const zipBuf = createZip(Buffer.from(xmlContent,'utf8'), `${nit}${invoiceNumber}.xml`);
  const r = await signedCall({ p12Base64, password, environment, actionName: 'SendTestSetAsync',
    bodyContent: bodySendTestSetAsync(`${nit}${invoiceNumber}.zip`, zipBuf.toString('base64'), testSetId) });

  logger.info(`[DIAN] SendTestSetAsync HTTP=${r.statusCode}`);
  const zipKey = parseXmlValue(r.body,'SendTestSetAsyncResult') || parseXmlValue(r.body,'ZipKey') ||
                 parseXmlValue(r.body,'string') || parseXmlValue(r.body,'trackId');
  if (!zipKey) {
    const parsed = parseSoapResponse(r.body);
    parsed.raw = r.body || `HTTP ${r.statusCode}`;
    return parsed;
  }
  logger.info(`[DIAN] ZipKey=${zipKey} - polling`);
  return pollGetStatusZip({ zipKey, p12Base64, password, environment });
}

async function pollGetStatusZip({ zipKey, p12Base64, password, environment, maxRetries = 12, delayMs = 3000 }) {
  for (let i = 1; i <= maxRetries; i++) {
    const result = await getStatusZip({ zipKey, p12Base64, password, environment });
    if ((result.statusCode === '99' || result.statusCode === null) && i < maxRetries) {
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }
    return result;
  }
  return { isValid: false, statusCode: 'TIMEOUT', statusDescription: 'Timeout DIAN', raw: '' };
}

module.exports = { getStatus, getStatusZip, getNumberingRange, sendBillSync, sendTestSetAsync };