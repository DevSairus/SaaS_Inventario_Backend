// backend/src/services/exogena/format1003.service.js
//
// Formato 1003 — Retenciones en la fuente que le practicaron.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.19 (F1003 v7, Resolución 000227/2025).
//
// Agrega Sale por cliente: valor acumulado sujeto a retención (subtotal) y
// retención en la fuente que el cliente practicó y se registró (payment_history source retention). Nota:
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

async function buildRecords(tenantId, year, _conceptBySourceKey, options = {}) {
  const schema = getCurrentSchema() || 'public';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  // Retención REGISTRADA (lo que el cliente practicó, según sus certificados
  // y la contabilidad), no la estimación de la venta -- ver
  // services/sales/registeredRetentions.js.
  const { registeredRetentionsLateral } = require('../sales/registeredRetentions');
  const rows = await sequelize.query(
    `SELECT s.customer_id, s.customer_tax_id AS tax_id, s.customer_document_type AS document_type,
            c.first_name, c.last_name, c.business_name, s.customer_city_code AS city_code, s.customer_address AS address,
            SUM(s.subtotal) AS valor, SUM(r.retefuente) AS ret
     FROM "${schema}"."sales" s
     LEFT JOIN "${schema}"."customers" c ON c.id = s.customer_id
     CROSS JOIN LATERAL ${registeredRetentionsLateral('s')} r
     WHERE s.tenant_id = :tenantId AND s.status IN ('pending', 'completed')
       AND s.is_consolidated_invoice IS NOT TRUE -- su ingreso está en las remisiones agrupadas
       AND r.retefuente > 0
       AND s.sale_date BETWEEN :from AND :to
     GROUP BY s.customer_id, s.customer_tax_id, s.customer_document_type, c.first_name, c.last_name, c.business_name, s.customer_city_code, s.customer_address`,
    { replacements: { tenantId, from, to }, type: QueryTypes.SELECT }
  );

  // Devoluciones de clientes aprobadas en el año sobre facturas con
  // ReteFuente: bajan la base (valor) y la retención en proporción a lo
  // devuelto (services/returns/returnFiscalData.js). Las de facturas de años
  // anteriores dependen de la opción del tenant (prior_year_returns): 'skip'
  // (por defecto, esa retención ya se declaró) o 'subtract' (se resta este año).
  const { approvedCustomerReturns, isPriorYearDocument } = require('../returns/returnFiscalData');
  const subtractPriorYear = options.prior_year_returns === 'subtract';
  const skipped = [];
  const keyOf = (r) => r.customer_id || `nit:${r.tax_id}`;
  const byCustomer = new Map(rows.map((r) => [keyOf(r), { ...r, valor: Number(r.valor || 0), ret: Number(r.ret || 0) }]));
  for (const ret of await approvedCustomerReturns(tenantId, from, to)) {
    if (!(ret.retefuente_share > 0)) continue;
    if (isPriorYearDocument(ret.sale_date, year) && !subtractPriorYear) continue;
    const key = keyOf(ret);
    if (!byCustomer.has(key)) {
      // Restar sin retenciones del cliente este año dejaría el registro en
      // negativo: se informa para ajustarlo a mano.
      skipped.push({ reason: 'devolucion_sin_retenciones_en_el_ano', customer_id: ret.customer_id, return_number: ret.return_number });
      continue;
    }
    const acc = byCustomer.get(key);
    acc.valor -= ret.base;
    acc.ret -= ret.retefuente_share;
  }

  const records = [];
  for (const row of [...byCustomer.values()].map((r) => ({ ...r, valor: Math.max(r.valor, 0), ret: Math.max(r.ret, 0) }))) {
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
