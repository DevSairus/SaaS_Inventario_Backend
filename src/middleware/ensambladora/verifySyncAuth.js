// backend/src/middleware/ensambladora/verifySyncAuth.js
// Autentica requests entrantes de sincronización desde el Core Ensambladora.
// Mismo esquema que src/services/ncf/ncfClient.js:verificarFirmaWebhook, pero
// resolviendo primero el tenant a partir de X-Api-Key (no hay JWT aquí --
// mismo patrón que metaWebhook.controller.js). Ver
// contrato-sincronizacion-ensambladora.md, sección 2.
const crypto = require('crypto');
const { EnsambladoraSyncCredential } = require('../../models');
const logger = require('../../config/logger');

function verificarFirma(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function verifySyncAuth(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    const signature = req.headers['x-signature'];

    if (!apiKey) {
      return res.status(401).json({ success: false, code: 'api_key_faltante', message: 'Header X-Api-Key requerido' });
    }

    const credential = await EnsambladoraSyncCredential.findOne({ where: { api_key: apiKey } });
    if (!credential) {
      return res.status(401).json({ success: false, code: 'api_key_invalida', message: 'API key no reconocida' });
    }
    if (credential.estado !== 'activo') {
      return res.status(403).json({
        success: false,
        code: 'credencial_no_activa',
        message: `La credencial de sincronización está en estado "${credential.estado}"`,
      });
    }

    const rawBody = req.rawBody || Buffer.from('');
    if (!verificarFirma(rawBody, signature, credential.hmac_secret)) {
      logger.warn('[Ensambladora Sync] Firma HMAC inválida', { tenant_id: credential.tenant_id });
      return res.status(401).json({ success: false, code: 'firma_invalida', message: 'X-Signature no coincide con el body enviado' });
    }

    req.ensambladoraCredential = credential;
    req.tenant_id = credential.tenant_id; // para que el controller no dependa de tenantMiddleware
    next();
  } catch (error) {
    logger.error('[Ensambladora Sync] Error verificando autenticación', { message: error.message });
    res.status(500).json({ success: false, message: 'Error verificando autenticación de sincronización' });
  }
}

module.exports = { verifySyncAuth };
