// backend/src/services/ensambladora/auditLog.js
const logger = require('../../config/logger');

/**
 * Registra una entrada de auditoría (ver EnsambladoraAuditLog). Best-effort:
 * si falla, solo se loguea un warning -- nunca debe bloquear la acción real
 * (radicar/cerrar/reenviar una garantía, etc), mismo criterio que
 * refrescarCacheEstado en ciclovida.controller.js.
 *
 * @param {object} datos
 * @param {string} datos.entidad_tipo 'garantia' | 'alistamiento' | ...
 * @param {string} [datos.entidad_id]
 * @param {string} [datos.vin]
 * @param {string} datos.accion
 * @param {string} [datos.usuario_id]
 * @param {string} [datos.usuario_nombre]
 * @param {object} [datos.detalle]
 */
async function registrarAuditoria(datos) {
  try {
    const { EnsambladoraAuditLog } = require('../../models');
    await EnsambladoraAuditLog.create({
      entidad_tipo: datos.entidad_tipo,
      entidad_id: datos.entidad_id || null,
      vin: datos.vin || null,
      accion: datos.accion,
      usuario_id: datos.usuario_id || null,
      usuario_nombre: datos.usuario_nombre || null,
      detalle: datos.detalle || {},
    });
  } catch (error) {
    logger.warn('[Ensambladora] No se pudo registrar auditoría', {
      entidad_tipo: datos.entidad_tipo,
      accion: datos.accion,
      message: error.message,
    });
  }
}

module.exports = { registrarAuditoria };
