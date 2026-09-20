// backend/src/services/exogena/format1647.service.js
//
// Formato 1647 — Ingresos recibidos para terceros.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo C.
// Anexo técnico: T3.26 (F1647 v2, Resolución 000227/2025).
//
// Hoy no hay ningún concepto de "cobro por cuenta de un tercero" en el
// modelo de datos de Pitbox (confirmado en el plan) -- se captura 100% a
// mano vía ExogenaManualRecord. El "tercero" de quien se recibe el ingreso
// vive en las columnas third_party_document_type/third_party_tax_id; el
// tercero PARA QUIEN se recibió el ingreso (el beneficiario real) vive en
// el payload, junto con los montos.
//
// El concepto (con) es fijo en 4070 por la Resolución (Artículo 1.3.5.9.1:
// "...con el concepto 4070"), así que no se pide mapeo al usuario.
//
// payload esperado: { apl1, apl2, nom1, nom2, raz, pais, vtotal, ving, vret,
//   tdoc2, nid2i, apl1i, apl2i, nom1i, nom2i, razi, dir, cdpt, cmcp, paist }
//
// Atributos según XSD: con, tdoc, nid, dv, apl1, apl2, nom1, nom2, raz,
// pais, vtotal, ving, vret, tdoc2, nid2i, apl1i, apl2i, nom1i, nom2i, razi,
// dir, cdpt, cmcp, paist.

const { ExogenaManualRecord } = require('../../models');
const { calculateNitDv } = require('../../utils/nitDv');

const CONCEPT_THIRD_PARTY_INCOME = '4070';

async function buildRecords(tenantId, year) {
  const rows = await ExogenaManualRecord.findAll({
    where: { tenant_id: tenantId, format_code: '1647', fiscal_year: year },
    order: [['created_at', 'ASC']],
  });

  const records = rows.map((r) => {
    const p = r.payload || {};
    return {
      con: CONCEPT_THIRD_PARTY_INCOME,
      tdoc: r.third_party_document_type,
      nid: r.third_party_tax_id,
      dv: r.third_party_document_type === '31' ? calculateNitDv(r.third_party_tax_id) : null,
      apl1: p.apl1 || null,
      apl2: p.apl2 || null,
      nom1: p.nom1 || null,
      nom2: p.nom2 || null,
      raz: p.raz || null,
      pais: p.pais || '169',
      vtotal: Math.round(Number(p.vtotal || 0)),
      ving: Math.round(Number(p.ving || 0)),
      vret: Math.round(Number(p.vret || 0)),
      tdoc2: p.tdoc2,
      nid2i: p.nid2i,
      apl1i: p.apl1i || null,
      apl2i: p.apl2i || null,
      nom1i: p.nom1i || null,
      nom2i: p.nom2i || null,
      razi: p.razi || null,
      dir: p.dir || null,
      cdpt: p.cdpt || null,
      cmcp: p.cmcp || null,
      paist: p.paist || '169',
    };
  });

  return { records, skipped: [] };
}

module.exports = {
  formatCode: '1647',
  version: 2,
  recordElementName: 'ingresos',
  totalValueField: 'vtotal',
  buildRecords,
};
