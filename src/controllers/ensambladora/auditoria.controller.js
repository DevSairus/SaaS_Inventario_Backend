// backend/src/controllers/ensambladora/auditoria.controller.js
const { EnsambladoraAuditLog } = require('../../models');
const logger = require('../../config/logger');

/**
 * GET /api/ensambladora/auditoria?entidad_tipo=&entidad_id=&vin=&accion=&limit=
 * Listado de solo lectura del log de auditoría (ver registrarAuditoria,
 * services/ensambladora/auditLog.js) -- radicar/cerrar/reenviar garantía,
 * crear alistamiento, y eventos entrantes del Core relacionados con garantía.
 */
async function listar(req, res) {
  try {
    const { entidad_tipo, entidad_id, vin, accion, limit } = req.query;
    const where = {};
    if (entidad_tipo) where.entidad_tipo = entidad_tipo;
    if (entidad_id) where.entidad_id = entidad_id;
    if (vin) where.vin = vin;
    if (accion) where.accion = accion;

    const safeLimit = Math.max(1, Math.min(200, parseInt(limit) || 100));

    const registros = await EnsambladoraAuditLog.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: safeLimit,
    });

    res.json({ success: true, data: registros });
  } catch (error) {
    logger.error('[Ensambladora] Error listando auditoría', { message: error.message });
    res.status(500).json({ success: false, message: 'Error listando el log de auditoría' });
  }
}

module.exports = { listar };
