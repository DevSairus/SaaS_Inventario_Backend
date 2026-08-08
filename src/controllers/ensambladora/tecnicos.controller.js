// backend/src/controllers/ensambladora/tecnicos.controller.js
const { EnsambladoraTecnicoAsesor } = require('../../models');
const { consultarTecnico } = require('../../services/ensambladora/coreApiClient');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');
const logger = require('../../config/logger');

/**
 * GET /api/ensambladora/tecnicos
 * "Gestión local de usuarios" (roadmap, Fase 7) -- listado del registro
 * local (ensambladora_tecnicos_asesores), NO pass-through al Core (ese es
 * `verificar`, GET /:documento). Este es el que alimenta la pantalla de
 * gestión; vinculados primero, luego por nombre.
 */
async function listar(req, res) {
  const registros = await EnsambladoraTecnicoAsesor.findAll({
    order: [['vinculado', 'DESC'], ['nombre', 'ASC']],
  });
  res.json({ success: true, data: registros });
}

/**
 * POST /api/ensambladora/tecnicos
 * body: { documento_identidad, nombre, rol }
 * "Gestión local de usuarios con sincronización a la Ensambladora"
 * (roadmap) -- upsert local + evento usuario.tecnico_asesor_vinculado sin
 * fecha_fin (el Core lo interpreta como vinculación, no desvinculación).
 */
async function vincular(req, res) {
  const { documento_identidad, nombre, rol } = req.body || {};

  if (!documento_identidad || !rol) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'documento_identidad y rol son obligatorios' });
  }
  if (!['tecnico', 'asesor'].includes(rol)) {
    return res.status(400).json({ success: false, code: 'rol_invalido', message: 'rol debe ser tecnico o asesor' });
  }

  const [registro] = await EnsambladoraTecnicoAsesor.upsert({
    documento_identidad,
    nombre: nombre || null,
    rol,
    vinculado: true,
    sync_estado: 'pendiente',
  });

  const fechaInicio = new Date().toISOString().slice(0, 10);

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'usuario.tecnico_asesor_vinculado',
    entidadTipo: 'tecnico_asesor',
    entidadId: registro.id,
    payload: { documento_identidad, nombre, rol, fecha_inicio: fechaInicio },
  });

  await registro.update({ sync_estado: envio.ok ? 'confirmado' : 'error', evento_sync_id: envio.eventId });

  if (!envio.ok) {
    return res.status(502).json({
      success: false,
      code: 'vinculacion_pendiente_de_sincronizar',
      message: 'Quedó registrado localmente pero no se pudo confirmar con la Ensambladora todavía',
      data: registro,
      error_core: envio.error,
    });
  }

  res.status(201).json({ success: true, data: registro });
}

/** POST /api/ensambladora/tecnicos/:documento/desvincular */
async function desvincular(req, res) {
  const { documento } = req.params;

  const registro = await EnsambladoraTecnicoAsesor.findOne({ where: { documento_identidad: documento } });
  if (!registro) {
    return res.status(404).json({ success: false, code: 'no_encontrado', message: 'No hay un técnico/asesor local con ese documento' });
  }

  const fechaFin = new Date().toISOString().slice(0, 10);

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'usuario.tecnico_asesor_vinculado',
    entidadTipo: 'tecnico_asesor',
    entidadId: registro.id,
    payload: { documento_identidad: documento, nombre: registro.nombre, rol: registro.rol, fecha_fin: fechaFin },
  });

  if (!envio.ok) {
    logger.error('[Ensambladora] Error desvinculando técnico', { documento, message: envio.error?.message });
    return res.status(502).json({
      success: false,
      code: 'desvinculacion_no_confirmada',
      message: 'No se pudo confirmar la desvinculación con la Ensambladora',
      error_core: envio.error,
    });
  }

  await registro.update({ vinculado: false });

  res.json({ success: true, data: registro });
}

/** GET /api/ensambladora/tecnicos/:documento -- verificación (pass-through al Core) */
async function verificar(req, res) {
  try {
    const tecnico = await consultarTecnico(req.tenant_id, req.params.documento);
    res.json({ success: true, data: tecnico });
  } catch (error) {
    logger.error('[Ensambladora] Error verificando técnico', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudo verificar el técnico' });
  }
}

module.exports = { listar, vincular, desvincular, verificar };
