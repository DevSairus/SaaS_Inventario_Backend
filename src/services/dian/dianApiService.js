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
const { parseServiceUrls, callWithFailover } = require('../../utils/serviceUrls');

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
// SendNominaSync — mismo contrato WcfDianCustomerServices, mismo shape de
// body que SendBillSync (fileName + contentFile). payrollDianAdapter.js ya
// llamaba a esta función dando por hecho que existía; nunca se había
// agregado, así que el primer envío real de nómina electrónica tronaba con
// un TypeError ("dianApiService.sendNominaSync is not a function").
// SOLO contentFile: así lo define el Anexo de Nómina (numeral 9.7.2) y la
// plantilla de la librería ubl21dian que usan proveedores en producción.
// Antes llevaba también fileName (copiado de SendBillSync), un elemento que
// la operación no tiene.
function bodySendNominaSync(content64) {
  return `<wcf:SendNominaSync xmlns:wcf="${NS.WCF}"><wcf:contentFile>${content64}</wcf:contentFile></wcf:SendNominaSync>`;
}
// SendEventUpdateStatus lleva SOLO contentFile — a diferencia de
// SendBillSync, NO lleva fileName (confirmado contra el Anexo FE 1.9
// §7.13.2, ver RADIAN-Analisis-y-Plan.md §5.2).
function bodySendEventUpdateStatus(content64) {
  return `<wcf:SendEventUpdateStatus xmlns:wcf="${NS.WCF}"><wcf:contentFile>${content64}</wcf:contentFile></wcf:SendEventUpdateStatus>`;
}
function bodyGetXmlByDocumentKey(trackId) {
  return `<wcf:GetXmlByDocumentKey xmlns:wcf="${NS.WCF}"><wcf:trackId>${trackId}</wcf:trackId></wcf:GetXmlByDocumentKey>`;
}

// Transporte
//
// La IP de Railway no está autorizada por la DIAN (responde 403 con una
// página HTML). Igual que facturas y consultas (dianKitAdapter), si hay
// DIAN_SERVICE_URL el sobre ya firmado se entrega por dian-service
// (/api/dian/forward-soap), que corre en un equipo autorizado. Sin esa
// variable (desarrollo local) se envía directo.
async function soapRequestViaService(urls, environment, actionName, soapXml) {
  const apiKey = process.env.DIAN_API_KEY || 'pitbox-dian-2026';
  const start = Date.now();
  // Hasta 3 intentos si el túnel no alcanza a dian-service (502/503/504):
  // en ese caso la petición no llegó a la DIAN, reintentar es seguro.
  let result;
  for (let attempt = 1; ; attempt += 1) {
    try {
      result = await sendOnce();
      break;
    } catch (err) {
      if (!err.retriable || attempt >= 3) throw err;
      logger.warn(`[DIAN] ${actionName}: dian-service no respondió (intento ${attempt}/3), reintentando en 4 s`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  logger.info(`[DIAN] <- ${actionName} vía dian-service HTTP ${result.statusCode} (${Date.now() - start}ms) ${String(result.body || '').length}b`);
  return { statusCode: result.statusCode, body: String(result.body || '') };

  function sendOnce() { return callWithFailover(urls, async (baseUrl) => {
    let response;
    try {
      response = await fetch(`${baseUrl}/api/dian/forward-soap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ environment, actionName, soapXml }),
      });
    } catch (e) {
      const cause = e.cause?.code || e.cause?.message || e.message;
      throw new Error(`No se pudo conectar con el servicio DIAN (${baseUrl}): ${cause}. Verifique que dian-service esté encendido.`);
    }
    if (response.status === 404) {
      throw new Error('El servicio DIAN (dian-service) está desactualizado: falta /api/dian/forward-soap. Actualícelo y reinícielo.');
    }
    // 502/503/504 con página HTML = el túnel de Cloudflare no alcanzó a
    // dian-service (apagado o reiniciándose). No es una respuesta de la DIAN.
    if ([502, 503, 504].includes(response.status)) {
      const err = new Error(`El servicio DIAN (dian-service) no respondió a través del túnel (HTTP ${response.status}). Verifique que esté encendido en el equipo autorizado y reintente.`);
      err.retriable = true;
      throw err;
    }
    if (!response.ok) throw new Error(`Servicio DIAN error ${response.status}: ${(await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)}`);
    return response.json();
  }, logger); }
}

// Una respuesta que no es un sobre SOAP (403/5xx con página HTML) no es un
// rechazo de la DIAN: el documento nunca llegó a validarse. Se lanza como
// error de conexión para que quede como "error" (reintentable) y no como
// "rechazado" con un motivo vacío.
function assertSoapResponse(actionName, { statusCode, body }) {
  if (/Envelope/i.test(body || '')) return;
  const hint = statusCode === 403
    ? 'La DIAN bloqueó la conexión (403): el envío no salió por un equipo autorizado. Revise DIAN_SERVICE_URL y que dian-service esté encendido y actualizado.'
    : `La DIAN respondió HTTP ${statusCode} sin una respuesta SOAP válida. Intente de nuevo en unos minutos.`;
  const err = new Error(hint);
  err.httpStatus = statusCode;
  err.isConnectionError = true;
  throw err;
}

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
  // ErrorMessage trae una lista <b:string>Regla: …, Rechazo: …</b:string>:
  // se une en un texto legible en vez de guardar el bloque XML crudo.
  const errorBlock = parseXmlValue(xml, 'ErrorMessage');
  const errorList = errorBlock
    ? [...errorBlock.matchAll(/<(?:[a-zA-Z0-9_]+:)?string>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?string>/g)].map((m) => m[1].trim()).filter(Boolean)
    : [];
  return {
    isValid: isValidRaw === 'true' || statusCode === '00',
    statusCode,
    statusDescription: parseXmlValue(xml, 'StatusDescription'),
    statusMessage: parseXmlValue(xml, 'StatusMessage') ||
                   (errorList.length ? errorList.join(' | ') : errorBlock) ||
                   parseXmlValue(xml, 'ProcessedMessage'),
    errors: errorList,
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
  const serviceUrls = parseServiceUrls(process.env.DIAN_SERVICE_URL);
  const response = serviceUrls.length
    ? await soapRequestViaService(serviceUrls, environment === 'production' ? 'production' : 'test', actionName, soapXml)
    : await soapRequest(endpoint, actionName, soapXml, agent);
  assertSoapResponse(actionName, response);
  return response;
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

async function sendNominaSync({ xmlContent, nit, documentNumber, p12Base64, password, environment = 'production' }) {
  const zipBuf = createZip(Buffer.from(xmlContent, 'utf8'), `${nit}${documentNumber}.xml`);
  const r = await signedCall({ p12Base64, password, environment, actionName: 'SendNominaSync',
    bodyContent: bodySendNominaSync(zipBuf.toString('base64')) });
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

/**
 * Envía un evento RADIAN (ApplicationResponse ya firmado XAdES) via
 * SendEventUpdateStatus. `xmlContent` debe venir YA FIRMADO — a diferencia
 * de sendBillSync/sendTestSetAsync (que no firman tampoco, ambos reciben el
 * XML final), se explicita acá porque el flujo de eventos usa
 * dianSignerService.signXml en vez de @dian-kit.
 */
async function sendEventUpdateStatus({ signedXml, nit, documentNumber, p12Base64, password, environment = 'production' }) {
  const zipBuf = createZip(Buffer.from(signedXml, 'utf8'), `${nit}${documentNumber}.xml`);
  const r = await signedCall({
    p12Base64, password, environment, actionName: 'SendEventUpdateStatus',
    bodyContent: bodySendEventUpdateStatus(zipBuf.toString('base64')),
  });
  return parseSoapResponse(r.body);
}

async function getXmlByDocumentKey({ trackId, p12Base64, password, environment = 'production' }) {
  const r = await signedCall({ p12Base64, password, environment, actionName: 'GetXmlByDocumentKey', bodyContent: bodyGetXmlByDocumentKey(trackId) });
  return parseSoapResponse(r.body);
}

module.exports = {
  getStatus, getStatusZip, getNumberingRange, sendBillSync, sendTestSetAsync,
  sendNominaSync,
  sendEventUpdateStatus, getXmlByDocumentKey,
  signedCall,
};