// backend/src/services/exogena/format1004.service.js
//
// Formato 1004 — Descuentos tributarios solicitados.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.29 (F1004 v8, Resolución 000227/2025).
//
// Pitbox no registra descuentos tributarios en ningún módulo (confirmado en
// el plan: "probablemente no, requiere un campo/módulo nuevo"). En vez de
// inventar un módulo completo de descuentos tributarios (crédito fiscal por
// inversión, IVA en bienes de capital, etc. -- materia de la declaración de
// renta, no de la operación diaria), este formato se alimenta 100% de
// ExogenaManualRecord: el contador captura los registros a mano (ver
// exogena.controller.js#manualRecords) y aquí solo se traducen al XML.
//
// Atributos según XSD: cpt, tdoc, tdoc, nit, pap, sap, pno, ono, raz, dir,
// dpto, mun, pais, email, vdesc, vdescsol.

const { ExogenaManualRecord } = require('../../models');

async function buildRecords(tenantId, year) {
  const rows = await ExogenaManualRecord.findAll({
    where: { tenant_id: tenantId, format_code: '1004', fiscal_year: year },
    order: [['created_at', 'ASC']],
  });

  const records = rows.map((r) => ({
    tdoc: r.third_party_document_type,
    nit: r.third_party_tax_id,
    ...r.payload,
  }));

  return { records, skipped: [] };
}

module.exports = {
  formatCode: '1004',
  version: 8,
  recordElementName: 'descuentos',
  totalValueField: 'vdesc',
  buildRecords,
};
