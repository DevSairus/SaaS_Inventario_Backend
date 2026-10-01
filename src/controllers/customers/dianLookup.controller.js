// src/controllers/customers/dianLookup.controller.js
//
// Consulta de clientes (adquirientes) en la DIAN por NIT / cédula, vía la
// operación GetAcquirer. Solo está disponible para tenants que tienen SU
// PROPIO certificado digital cargado en la configuración DIAN -- no existe
// una credencial global de plataforma a propósito, para que cada consulta
// salga a nombre de quien la hace.
//
// La DIAN solo devuelve nombre y correo de recepción de facturas (no
// dirección, ciudad ni responsabilidades fiscales).

const { Tenant } = require('../../models');
const dianKit = require('../../services/dian/dianKitAdapter');
const logger = require('../../config/logger');

// Mismos schemeID que DOCUMENT_TYPE_OPTIONS en CustomersPage.jsx
const DOCUMENT_TYPES = ['13', '31', '22', '41', '12', '91'];

const hasOwnCertificate = (cfg) =>
  !!cfg.certificate_p12_base64 && cfg.certificate_p12_base64 !== '[CONFIGURADO]' &&
  !!cfg.certificate_password && cfg.certificate_password !== '[CONFIGURADO]';

/* ─── GET /api/customers/dian-lookup/availability ───────────────────────────
   Le dice al frontend si debe mostrar el botón "Consultar DIAN".
─────────────────────────────────────────────────────────────────────────────── */
const getAvailability = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.tenant_id, { attributes: ['id', 'dian_config'] });
    const cfg = tenant?.dian_config || {};
    res.json({
      success: true,
      data: {
        available: hasOwnCertificate(cfg),
        environment: cfg.environment || 'test',
      },
    });
  } catch (err) {
    logger.error('DIAN lookup availability:', err.message);
    res.status(500).json({ success: false, message: 'Error verificando la consulta DIAN.' });
  }
};

/* ─── GET /api/customers/dian-lookup/:documentType/:number ──────────────────
   El número puede venir con DV en el caso de NIT ("900072256-1"); a la DIAN
   se envía sin DV.
─────────────────────────────────────────────────────────────────────────────── */
const lookup = async (req, res) => {
  const { documentType } = req.params;
  const [numberBase] = String(req.params.number || '').trim().split('-');
  const number = numberBase.replace(/[\s.]/g, '');

  if (!DOCUMENT_TYPES.includes(documentType)) {
    return res.status(400).json({ success: false, message: 'Tipo de identificación no soportado para consulta DIAN.' });
  }
  const validNumber = documentType === '41' ? /^[A-Za-z0-9]{3,20}$/ : /^\d{3,15}$/;
  if (!validNumber.test(number)) {
    return res.status(400).json({ success: false, message: 'Número de identificación inválido.' });
  }

  let tenant;
  try {
    tenant = await Tenant.findByPk(req.tenant_id);
  } catch (err) {
    logger.error('DIAN lookup tenant:', err.message);
    return res.status(500).json({ success: false, message: 'Error consultando la DIAN.' });
  }
  if (!hasOwnCertificate(tenant?.dian_config || {})) {
    return res.status(403).json({
      success: false,
      code: 'DIAN_CERTIFICATE_REQUIRED',
      message: 'La consulta DIAN requiere tener cargado el certificado digital de tu empresa en Configuración DIAN.',
    });
  }

  try {
    const result = await dianKit.lookupAcquirer(tenant, {
      identificationType: documentType,
      identificationNumber: number,
    });

    logger.info(`[DIAN Lookup] tenant=${tenant.id} user=${req.user?.id} doc=${documentType}:${number} found=${result.found}`);

    if (!result.found) {
      return res.status(404).json({
        success: false,
        message: result.message || 'La DIAN no devolvió datos para este documento.',
      });
    }

    const isNit = documentType === '31';
    res.json({
      success: true,
      data: {
        customer_type: isNit ? 'company' : 'individual',
        document_type: documentType,
        tax_id: isNit ? `${number}-${dianKit.computeNitCheckDigit(number)}` : number,
        full_name: result.receiverName,
        business_name: isNit ? result.receiverName : '',
        email: result.receiverEmail,
      },
    });
  } catch (err) {
    logger.error(`[DIAN Lookup] tenant=${tenant.id} doc=${documentType}:${number} error: ${err.message}`);
    res.status(502).json({
      success: false,
      message: 'No se pudo consultar la DIAN en este momento. Intenta de nuevo.',
    });
  }
};

module.exports = { getAvailability, lookup };
