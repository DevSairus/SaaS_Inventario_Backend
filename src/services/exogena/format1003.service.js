// backend/src/services/exogena/format1003.service.js
//
// Formato 1003 — Retenciones en la fuente que le practicaron.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.19 (F1003 v7, Resolución 000227/2025).
//
// Agrega Sale por cliente: valor acumulado sujeto a retención (subtotal) y
// retención en la fuente que el cliente practicó (retefuente_amount). Nota:
// el XSD real de este anexo NO incluye el atributo "cpt" (aunque la tabla de
// prosa del PDF sí lo menciona) -- se sigue el XSD, que es lo que valida la
// DIAN. Por eso este formato no necesita ExogenaConceptMapping.
//
// Atributos según XSD: tdoc, nid, dv, apl1, apl2, nom1, nom2, raz, dir,
// dpto, mcpo, valor, ret.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { mapCustomerToExogena } = require('./thirdPartyMapper');

async function buildRecords(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const rows = await sequelize.query(
    `SELECT s.customer_id, s.customer_tax_id AS tax_id, s.customer_document_type AS document_type,
            c.first_name, c.last_name, c.business_name, s.customer_city_code AS city_code, s.customer_address AS address,
            SUM(s.subtotal) AS valor, SUM(s.retefuente_amount) AS ret
     FROM "${schema}"."sales" s
     LEFT JOIN "${schema}"."customers" c ON c.id = s.customer_id
     WHERE s.tenant_id = :tenantId AND s.status = 'completed'
       AND s.is_consolidated_invoice IS NOT TRUE -- su ingreso está en las remisiones agrupadas
       AND s.retefuente_amount > 0
       AND s.sale_date BETWEEN :from AND :to
     GROUP BY s.customer_id, s.customer_tax_id, s.customer_document_type, c.first_name, c.last_name, c.business_name, s.customer_city_code, s.customer_address`,
    { replacements: { tenantId, from, to }, type: QueryTypes.SELECT }
  );

  const skipped = [];
  const records = [];
  for (const row of rows) {
    if (!row.tax_id) {
      skipped.push({ reason: 'cliente_sin_nit', customer_id: row.customer_id });
      continue;
    }
    // Este anexo llama "mcpo" al municipio (no "mun" como el resto de
    // formatos) -- se renombra aquí en vez de complicar thirdPartyMapper.
    const { mun, ...thirdParty } = mapCustomerToExogena(row);
    records.push({
      ...thirdParty,
      mcpo: mun,
      valor: Math.round(Number(row.valor || 0)),
      ret: Math.round(Number(row.ret || 0)),
    });
  }

  return { records, skipped };
}

module.exports = {
  formatCode: '1003',
  version: 7,
  recordElementName: 'rets',
  totalValueField: 'ret',
  buildRecords,
};
