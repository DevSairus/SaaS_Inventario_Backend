// backend/src/utils/radianAcceptance.js
/**
 * Anexo FE v1.9 §6.5.5.6 y §6.5.5.7 (efectos de la Aceptación expresa 033 y
 * de la Aceptación tácita 034): "No se pueden expedir notas crédito o débito
 * una vez generado este evento". La DIAN rechazaría la nota, así que se
 * bloquea antes de crearla (y de mover inventario/contabilidad).
 */
'use strict';

const ACCEPTED_RADIAN_STATUSES = ['033_received', '034'];

/** Motivo por el que la factura ya no admite notas, o null si sí las admite. */
function notesBlockedReason(invoice) {
  if (!invoice || !ACCEPTED_RADIAN_STATUSES.includes(invoice.radian_status)) return null;
  const how = invoice.radian_status === '034' ? 'aceptación tácita (034)' : 'aceptación expresa del cliente (033)';
  return `Esta factura ya tiene ${how} registrada en RADIAN: la DIAN no permite emitir notas crédito ni débito sobre ella.`;
}

module.exports = { ACCEPTED_RADIAN_STATUSES, notesBlockedReason };
