// backend/src/services/exogena/format1007.service.js
//
// Formato 1007 — Ingresos recibidos en el año.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.20 (F1007 v9, Resolución 000227/2025).
//
// Agrega Sale por cliente. Solo existe un source_key ('sale'): a diferencia
// del 1001, el perfil típico de tenant Pitbox (taller/concesionario) tiene
// una sola actividad económica principal, así que un único concepto de
// ingreso alcanza -- igual se resuelve vía ExogenaConceptMapping (no se
// hardcodea), por si el tenant necesita separar por actividad más adelante.
//
// Atributos según XSD: cpt, tdoc, nid, apl1, apl2, nom1, nom2, raz, pais,
// ibru, dred.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { mapCustomerToExogena } = require('./thirdPartyMapper');

const SOURCE_KEY_SALE = 'sale';

async function fetchSourceKeys() {
  return [SOURCE_KEY_SALE];
}

async function buildRecords(tenantId, year, conceptBySourceKey) {
  const cpt = conceptBySourceKey[SOURCE_KEY_SALE];
  const schema = getCurrentSchema() || 'public';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const rows = await sequelize.query(
    `SELECT s.customer_id, s.customer_tax_id AS tax_id, s.customer_document_type AS document_type,
            c.first_name, c.last_name, c.business_name,
            SUM(s.subtotal) AS ibru, SUM(s.discount_amount) AS dred
     FROM "${schema}"."sales" s
     LEFT JOIN "${schema}"."customers" c ON c.id = s.customer_id
     WHERE s.tenant_id = :tenantId AND s.status = 'completed'
       AND s.is_consolidated_invoice IS NOT TRUE -- su ingreso está en las remisiones agrupadas
       AND s.sale_date BETWEEN :from AND :to
     GROUP BY s.customer_id, s.customer_tax_id, s.customer_document_type, c.first_name, c.last_name, c.business_name`,
    { replacements: { tenantId, from, to }, type: QueryTypes.SELECT }
  );

  const skipped = [];
  if (!cpt) {
    return { records: [], skipped: [{ reason: 'sin_concepto_mapeado', source_key: SOURCE_KEY_SALE }] };
  }

  const records = [];
  for (const row of rows) {
    if (!row.tax_id) {
      skipped.push({ reason: 'cliente_sin_nit', customer_id: row.customer_id });
      continue;
    }
    const { mun, ...thirdParty } = mapCustomerToExogena(row);
    records.push({
      cpt,
      tdoc: thirdParty.tdoc, nid: thirdParty.nid,
      apl1: thirdParty.apl1 || null, apl2: thirdParty.apl2 || null,
      nom1: thirdParty.nom1 || null, nom2: thirdParty.nom2 || null,
      raz: thirdParty.raz || null,
      pais: thirdParty.pais,
      ibru: Math.round(Number(row.ibru || 0)),
      dred: Math.round(Number(row.dred || 0)),
    });
  }

  return { records, skipped };
}

module.exports = {
  formatCode: '1007',
  version: 9,
  recordElementName: 'ingresos',
  totalValueField: 'ibru',
  fetchSourceKeys,
  buildRecords,
};
