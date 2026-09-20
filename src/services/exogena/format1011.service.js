// backend/src/services/exogena/format1011.service.js
//
// Formato 1011 — Declaraciones tributarias, rentas exentas, costos y
// deducciones. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo C.
// Anexo técnico: T3.28 (F1011 v6, Resolución 000227/2025).
//
// Es un resumen de la declaración de renta del tenant, no de sus
// transacciones -- no se puede generar desde la operación (confirmado en
// el plan). Se captura 100% a mano vía ExogenaManualRecord.
//
// Particularidad de este formato: NO reporta un tercero -- su llave única
// es solo el "Concepto" (cpt). Se reutiliza ExogenaManualRecord igual (para
// no crear otra tabla más), guardando el código de concepto en
// `third_party_tax_id` (con `third_party_document_type` fijo en '00' como
// placeholder, ya que la columna es NOT NULL pero no aplica aquí) y el
// saldo en `payload.sal`.
//
// Atributos según XSD: cpt, sal.

const { ExogenaManualRecord } = require('../../models');

async function buildRecords(tenantId, year) {
  const rows = await ExogenaManualRecord.findAll({
    where: { tenant_id: tenantId, format_code: '1011', fiscal_year: year },
    order: [['created_at', 'ASC']],
  });

  const records = rows.map((r) => ({
    cpt: r.third_party_tax_id,
    sal: Math.round(Number(r.payload?.sal || 0)),
  }));

  return { records, skipped: [] };
}

module.exports = {
  formatCode: '1011',
  version: 6,
  recordElementName: 'decl',
  totalValueField: 'sal',
  buildRecords,
};
