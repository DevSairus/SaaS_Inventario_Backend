// backend/src/services/exogena/format1006.service.js
//
// Formato 1006 — IVA generado e Impuesto Nacional al Consumo.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.22 (F1006 v8, Resolución 000227/2025).
//
// Agrega Sale por cliente: IVA generado (tax_amount). El Impuesto Nacional
// al Consumo (icon) no se rastrea hoy como impuesto separado en Sale (no
// existe columna dedicada), así que se reporta en 0 -- si el tenant vende
// bienes/servicios sujetos a INC (ej. algunos servicios de parqueadero,
// comidas), este valor debe corregirse a mano por ahora.
//
// Atributos según XSD: tdoc, nid, dv, apl1, apl2, nom1, nom2, raz, imp,
// iva, icon.

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
            c.first_name, c.last_name, c.business_name,
            SUM(s.tax_amount) AS imp
     FROM "${schema}"."sales" s
     LEFT JOIN "${schema}"."customers" c ON c.id = s.customer_id
     WHERE s.tenant_id = :tenantId AND s.status = 'completed'
       AND s.is_consolidated_invoice IS NOT TRUE -- su ingreso está en las remisiones agrupadas
       AND s.tax_amount > 0
       AND s.sale_date BETWEEN :from AND :to
     GROUP BY s.customer_id, s.customer_tax_id, s.customer_document_type, c.first_name, c.last_name, c.business_name`,
    { replacements: { tenantId, from, to }, type: QueryTypes.SELECT }
  );

  const skipped = [];
  const records = [];
  for (const row of rows) {
    if (!row.tax_id) {
      skipped.push({ reason: 'cliente_sin_nit', customer_id: row.customer_id });
      continue;
    }
    const thirdParty = mapCustomerToExogena(row);
    records.push({
      tdoc: thirdParty.tdoc, nid: thirdParty.nid, dv: thirdParty.dv,
      apl1: thirdParty.apl1 || null, apl2: thirdParty.apl2 || null,
      nom1: thirdParty.nom1 || null, nom2: thirdParty.nom2 || null,
      raz: thirdParty.raz || null,
      imp: Math.round(Number(row.imp || 0)),
      iva: 0,
      icon: 0,
    });
  }

  return { records, skipped };
}

module.exports = {
  formatCode: '1006',
  version: 8,
  recordElementName: 'impoventas',
  totalValueField: 'imp',
  buildRecords,
};
