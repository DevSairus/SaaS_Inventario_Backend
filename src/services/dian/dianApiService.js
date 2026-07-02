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

// ZIP builder — usa adm-zip para compresión DEFLATE correcta
const AdmZip = require('adm-zip');

function createZip(fileContent, fileName) {
  const zip = new AdmZip();
  zip.addFile(fileName, Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent, 'utf8'));
  return zip.toBuffer();
}

// Helper central: construir y enviar SOAP firmado con WS-Addressing
async function signedCall({ p12Base64, password, environment, actionName, bodyContent }) {
  const certInfo = getCertInfo(p12Base64, password);
  const agent    = buildAgent(certInfo);
  const endpoint = ENDPOINTS[environment] || ENDPOINTS.test;
  const action   = WCF_BASE + actionName;

  const soapXml = buildSignedEnvelope({
    action, endpoint, bodyContent,
    certBase64: certInfo.certBase64,
    keyPem:     certInfo.keyPem,
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