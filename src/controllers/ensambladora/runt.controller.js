// backend/src/controllers/ensambladora/runt.controller.js
//
// Ojo: esto NO es el runt.controller.js real de Pitbox (el que habla
// directo con el sitio del RUNT resolviendo captcha). Esto solo avisa a
// la Ensambladora que un CSA necesita un reporte de matrícula/traspaso --
// quién lo tramita de verdad con el RUNT es el equipo de la Ensambladora,
// con su propia herramienta. Ver LEEME de esta fase.
const { EnsambladoraRuntSolicitud } = require('../../models');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');

async function solicitarReporte(req, res) {
  const { vin, tipo_reporte, datos_tramite } = req.body || {};

  if (!vin || !tipo_reporte) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin y tipo_reporte son obligatorios' });
  }
  if (!['matricula', 'traspaso'].includes(tipo_reporte)) {
    return res.status(400).json({ success: false, code: 'tipo_reporte_invalido', message: 'tipo_reporte debe ser matricula o traspaso' });
  }

  const solicitud = await EnsambladoraRuntSolicitud.create({
    vin,
    tipo_reporte,
    datos_tramite: datos_tramite || {},
    sync_estado: 'pendiente',
  });

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'runt.solicitud_reporte',
    entidadTipo: 'runt_solicitud',
    entidadId: solicitud.id,
    payload: { vin, tipo_reporte, datos_tramite },
  });

  await solicitud.update({ sync_estado: envio.ok ? 'confirmado' : 'error', evento_sync_id: envio.eventId });

  if (!envio.ok) {
    return res.status(502).json({
      success: false,
      code: 'solicitud_pendiente_de_sincronizar',
      message: 'La solicitud quedó registrada localmente pero no se pudo confirmar con la Ensambladora todavía',
      data: solicitud,
      error_core: envio.error,
    });
  }

  res.status(201).json({ success: true, data: solicitud });
}

module.exports = { solicitarReporte };
