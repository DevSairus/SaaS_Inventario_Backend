// backend/src/services/exogena/format1010.service.js
//
// Formato 1010 — Información de socios, accionistas, comuneros y/o
// cooperados. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo C.
// Anexo técnico: T3.17 (F1010 v9, Resolución 000227/2025).
//
// Fuente: ExogenaShareholder (nuevo modelo -- Pitbox no tenía ningún
// registro de composición societaria del tenant). El contador captura la
// composición vigente a 31 de diciembre de cada año vía el CRUD de
// ExogenaPage.jsx.
//
// El atributo "por" (porcentaje de participación) usa una codificación
// entera + posición decimal (ver anexo técnico): en vez de "12.78915" se
// diligencia por=1278915 y dec=5. Aquí se usa siempre 6 decimales de
// precisión (dec=6) por simplicidad -- matemáticamente equivalente a
// cualquier cantidad de decimales menor, solo con ceros de más al final.
//
// Atributos según XSD: tdoc, nid, dv, apl1, apl2, nom1, nom2, raz, dir,
// dpto, mun, pais, valnom, valprm, por, dec.

const { ExogenaShareholder } = require('../../models');
const { calculateNitDv } = require('../../utils/nitDv');
const { splitDeptMun } = require('./thirdPartyMapper');

const PERCENTAGE_DECIMALS = 6;

async function buildRecords(tenantId, year) {
  const rows = await ExogenaShareholder.findAll({
    where: { tenant_id: tenantId, fiscal_year: year },
    order: [['created_at', 'ASC']],
  });

  const records = rows.map((r) => {
    const { dpto, mun } = splitDeptMun(r.city_code);
    const isCompany = Boolean(r.business_name);
    return {
      tdoc: r.document_type,
      nid: r.tax_id,
      dv: r.document_type === '31' ? calculateNitDv(r.tax_id) : null,
      ...(isCompany
        ? { raz: r.business_name }
        : { nom1: r.first_name || null, apl1: r.last_name || null }),
      dir: r.address || null,
      dpto,
      mun,
      pais: r.country_code,
      valnom: Math.round(Number(r.nominal_value || 0)),
      valprm: Math.round(Number(r.premium_value || 0)),
      por: Math.round(Number(r.participation_percentage) * 10 ** PERCENTAGE_DECIMALS),
      dec: PERCENTAGE_DECIMALS,
    };
  });

  return { records, skipped: [] };
}

module.exports = {
  formatCode: '1010',
  version: 9,
  recordElementName: 'socios',
  totalValueField: 'valnom',
  buildRecords,
};
