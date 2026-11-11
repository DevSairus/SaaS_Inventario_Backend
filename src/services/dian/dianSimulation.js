// backend/src/services/dian/dianSimulation.js
//
// Modo SIMULACIÓN de facturación electrónica (dian_config.environment =
// 'simulation'), pensado para demos en producción: Pitbox arma el XML, lo
// firma y calcula CUFE/CUDE/CUNE igual que siempre, pero NUNCA lo envía a la
// DIAN. El documento queda "aceptado" con dian_response.simulated = true, sin
// correo al adquiriente, y su PDF lleva la marca "DOCUMENTO DE DEMOSTRACIÓN".
//
// Para que una empresa de demo funcione sin trámites:
//   - los datos DIAN que falten (software, clave técnica, NIT...) se completan
//     con valores de demostración (simulationConfig);
//   - sin certificado, se firma con uno autofirmado generado en memoria;
//   - sin resolución, se crean resoluciones de numeración de simulación
//     (prefijos SIM*) por sede y tipo de documento (ensureSimulationResolutions).
// Solo un super admin puede activarlo (ver dian.controller#updateConfig).
'use strict';

const SIMULATION = 'simulation';

const isSimulation = (tenantOrCfg) => {
  const cfg = tenantOrCfg?.dian_config !== undefined ? tenantOrCfg.dian_config : tenantOrCfg;
  return (cfg?.environment || '') === SIMULATION;
};

// ── Certificado autofirmado (uno por proceso) ──────────────────────────────
const CERT_PASSWORD = 'pitbox-simulacion';
let _cert = null;
function simulationCertificate() {
  if (_cert) return _cert;
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'PITBOX SIMULACION - SIN VALIDEZ' },
    { name: 'organizationName', value: 'Pitbox Demo' },
    { name: 'countryName', value: 'CO' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], CERT_PASSWORD, { algorithm: '3des' });
  _cert = { base64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()), password: CERT_PASSWORD };
  return _cert;
}

function nitCheckDigit(nit) {
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digits = String(nit).replace(/\D/g, '').split('').reverse();
  const sum = digits.reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  const mod = sum % 11;
  return String(mod < 2 ? mod : 11 - mod);
}

const hasCertificate = (cfg) => cfg.certificate_p12_base64
  && cfg.certificate_p12_base64 !== '[CONFIGURADO]' && cfg.certificate_password;

/**
 * dian_config efectivo en simulación: lo que tenga la empresa + valores de
 * demostración para lo que falte. Fuera de simulación devuelve el original.
 */
function simulationConfig(tenant) {
  const cfg = tenant?.dian_config || {};
  if (!isSimulation(cfg)) return cfg;
  const nit = String(cfg.nit || tenant.tax_id || '900000000').split('-')[0].replace(/\D/g, '') || '900000000';
  const name = cfg.company_name || tenant.business_name || tenant.company_name || 'EMPRESA DEMO';
  const out = {
    ...cfg,
    nit,
    dv: cfg.dv || nitCheckDigit(nit),
    company_name: name,
    email: cfg.email || tenant.email || 'demo@pitbox.co',
    address: cfg.address || tenant.address || 'Sin direccion',
    city_code: cfg.city_code || '11001',
    city: cfg.city || 'Bogota',
    dept: cfg.dept || 'Bogota',
    software_id: cfg.software_id || 'PITBOX-SIMULACION',
    software_pin: cfg.software_pin || '00000',
    software_provider_nit: cfg.software_provider_nit || nit,
    technical_key: cfg.technical_key || 'pitbox-simulacion-sin-validez',
    software_id_nomina: cfg.software_id_nomina || cfg.software_id || 'PITBOX-SIMULACION',
    software_pin_nomina: cfg.software_pin_nomina || cfg.software_pin || '00000',
    environment: SIMULATION,
  };
  if (!hasCertificate(cfg)) {
    const c = simulationCertificate();
    out.certificate_p12_base64 = c.base64;
    out.certificate_password = c.password;
  }
  return out;
}

/**
 * La misma empresa con el dian_config de simulación (los getters del modelo
 * siguen funcionando por el prototipo). Fuera de simulación, la original.
 */
function withSimulation(tenant) {
  if (!tenant || !isSimulation(tenant)) return tenant;
  const wrapped = Object.create(tenant);
  Object.defineProperty(wrapped, 'dian_config', { value: simulationConfig(tenant), enumerable: true });
  return wrapped;
}

/** Respuesta "aceptada" con la misma forma que las de la DIAN. */
function simulatedResponse(documentNumber, key) {
  const message = 'SIMULACIÓN: documento NO enviado a la DIAN (demostración sin validez fiscal)';
  return {
    isValid: true,
    statusCode: '00',
    statusDescription: 'Procesado Correctamente (simulación)',
    statusMessage: message,
    xmlDocumentKey: key || null,
    trackId: key || null,
    errors: [],
    simulated: true,
    raw: JSON.stringify({ simulated: true, documentNumber, key, message, at: new Date().toISOString() }),
  };
}

const SIM_PREFIX = {
  invoice: 'SIMF',
  credit_note: 'SIMC',
  debit_note: 'SIMD',
  support_document: 'SIMS',
  support_document_adjustment: 'SIMA',
  payroll: 'SIMN',
};

/**
 * Crea las resoluciones de simulación (is_test = true, como cualquier
 * ambiente que no es producción) que falten por sede activa y tipo de
 * documento. Devuelve cuántas creó.
 */
async function ensureSimulationResolutions(tenantId, { transaction, branchId = null } = {}) {
  const { DianResolution, Branch } = require('../../models');
  const where = { tenant_id: tenantId, is_active: true };
  if (branchId) where.id = branchId;
  const branches = await Branch.findAll({ where, attributes: ['id'], transaction });
  const existing = await DianResolution.findAll({
    where: { tenant_id: tenantId, is_active: true, is_test: true },
    attributes: ['branch_id', 'document_type'],
    transaction,
  });
  const have = new Set(existing.map((r) => `${r.branch_id}|${r.document_type}`));
  const rows = [];
  for (const b of branches) {
    for (const [documentType, prefix] of Object.entries(SIM_PREFIX)) {
      if (have.has(`${b.id}|${documentType}`)) continue;
      rows.push({
        tenant_id: tenantId,
        branch_id: b.id,
        document_type: documentType,
        resolution_number: '00000000000',
        resolution_date: '2020-01-01',
        prefix,
        from_number: 1,
        to_number: 999999999,
        current_number: 1,
        valid_from: '2020-01-01',
        valid_to: '2099-12-31',
        is_active: true,
        is_test: true,
        notes: 'Resolución de SIMULACIÓN (demo): los documentos con este prefijo no se envían a la DIAN.',
      });
    }
  }
  // validate:false — el ENUM del modelo no lista 'payroll' (la BD sí lo acepta).
  if (rows.length) await DianResolution.bulkCreate(rows, { transaction, validate: false });
  return rows.length;
}

/** ¿Este documento (venta, nómina...) se "aceptó" en simulación? */
const isSimulatedDocument = (docRecord) => !!docRecord?.dian_response?.simulated;

/**
 * Marca de agua "DOCUMENTO DE DEMOSTRACIÓN – SIN VALIDEZ FISCAL" en todas las
 * páginas de un PDF de pdfkit creado con bufferPages: true. Llamar justo
 * antes de doc.end().
 */
function drawSimulationWatermark(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // sin esto pdfkit puede agregar páginas en blanco
    doc.save();
    doc.rotate(-35, { origin: [width / 2, height / 2] });
    // Caja más ancha que la página (el texto va en diagonal): sin partir líneas.
    const boxX = -width * 0.5;
    const boxW = width * 2;
    doc.fillColor('#d0021b').opacity(0.13).font('Helvetica-Bold').fontSize(34)
      .text('DOCUMENTO DE DEMOSTRACIÓN', boxX, height / 2 - 40, { width: boxW, align: 'center', lineBreak: false });
    doc.fontSize(17)
      .text('SIN VALIDEZ FISCAL · NO ENVIADO A LA DIAN', boxX, height / 2 + 6, { width: boxW, align: 'center', lineBreak: false });
    doc.restore();
    doc.opacity(1);
    doc.page.margins.bottom = bottom;
  }
}

module.exports = {
  isSimulatedDocument,
  drawSimulationWatermark,
  SIMULATION,
  isSimulation,
  simulationConfig,
  withSimulation,
  simulatedResponse,
  ensureSimulationResolutions,
};
