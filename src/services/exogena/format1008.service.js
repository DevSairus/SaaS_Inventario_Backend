// backend/src/services/exogena/format1008.service.js
//
// Formato 1008 — Saldo de cuentas por cobrar (deudores) al 31 de diciembre.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo B.
// Anexo técnico: T3.24 (F1008 v7, Resolución 000227/2025).
//
// Concepto 1315 "El valor total del saldo de las cuentas por cobrar a
// clientes" (Artículo 1.3.5.7.1, tabla de conceptos ítem 1) -- es el único
// concepto que aplica al perfil de tenants de Pitbox (talleres/
// concesionarios): no manejan pasivos por cálculo actuarial, seguros, etc.
// No se pide mapeo de concepto al usuario porque no hay ambigüedad aquí (a
// diferencia de 1001/1007).
//
// Nota sobre el umbral de 12 UVT: la Resolución permite reportar individual
// incluso por debajo del umbral ("el informante podrá optar por reportar...
// con una cuantía menor a la exigida", Parágrafo 3), así que no es
// obligatorio agrupar los saldos menores bajo "CUANTÍAS MENORES" -- se deja
// fuera de esta fase (ver limitación equivalente en format1009.service.js).
//
// Atributos según XSD: cpt, tdoc, nid, dv, apl1, apl2, nom1, nom2, raz, dir,
// dpto, mun, pais, sal.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { mapCustomerToExogena } = require('./thirdPartyMapper');

const CONCEPT_ACCOUNTS_RECEIVABLE = '1315';

async function buildRecords(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const cutoff = `${year}-12-31`;

  const rows = await sequelize.query(
    `SELECT s.customer_id, s.customer_tax_id AS tax_id, s.customer_document_type AS document_type,
            c.first_name, c.last_name, c.business_name, s.customer_city_code AS city_code, s.customer_address AS address,
            SUM(s.total_amount - s.paid_amount) AS sal
     FROM "${schema}"."sales" s
     LEFT JOIN "${schema}"."customers" c ON c.id = s.customer_id
     WHERE s.tenant_id = :tenantId AND s.status = 'completed'
       AND s.is_consolidated_invoice IS NOT TRUE -- su ingreso está en las remisiones agrupadas
       AND s.payment_status IN ('pending', 'partial')
       AND s.sale_date <= :cutoff
     GROUP BY s.customer_id, s.customer_tax_id, s.customer_document_type, c.first_name, c.last_name, c.business_name, s.customer_city_code, s.customer_address
     HAVING SUM(s.total_amount - s.paid_amount) > 0`,
    { replacements: { tenantId, cutoff }, type: QueryTypes.SELECT }
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
      cpt: CONCEPT_ACCOUNTS_RECEIVABLE,
      ...thirdParty,
      sal: Math.round(Number(row.sal || 0)),
    });
  }

  return { records, skipped };
}

module.exports = {
  formatCode: '1008',
  version: 7,
  recordElementName: 'saldoscc',
  totalValueField: 'sal',
  buildRecords,
};
