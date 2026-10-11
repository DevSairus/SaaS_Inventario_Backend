// backend/src/services/exogena/format1005.service.js
//
// Formato 1005 — IVA descontable.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.21 (F1005 v8, Resolución 000227/2025).
//
// Agrega Purchase por proveedor: IVA pagado (tax_amount) como impuesto
// descontable. ivade = IVA de las devoluciones de clientes aprobadas en el
// año (services/returns/returnFiscalData.js). IVA no descontable art. 490
// (ivavcg) no se rastrea hoy -- se reporta en 0 (opcional en el XSD).
//
// Atributos según XSD: tdoc, nid, dv, apl1, apl2, nom1, nom2, raz, vimp,
// ivade, ivavcg.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { mapSupplierToExogena } = require('./thirdPartyMapper');

async function buildRecords(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const rows = await sequelize.query(
    `SELECT p.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name,
            SUM(p.tax_amount) AS vimp
     FROM "${schema}"."purchases" p
     JOIN "${schema}"."suppliers" s ON s.id = p.supplier_id
     WHERE p.tenant_id = :tenantId AND p.status NOT IN ('draft', 'cancelled')
       AND p.tax_amount > 0
       AND p.purchase_date BETWEEN :from AND :to
     GROUP BY p.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name`,
    { replacements: { tenantId, from, to }, type: QueryTypes.SELECT }
  );

  const skipped = [];
  const records = [];

  // IVA resultante por devoluciones en ventas (ivade), por cliente: el IVA de
  // las devoluciones de clientes aprobadas en el año. Si el tercero también
  // es proveedor, se suma en su mismo registro (una fila por nid).
  const { approvedCustomerReturns } = require('../returns/returnFiscalData');
  const { mapCustomerToExogena } = require('./thirdPartyMapper');
  const ivadeByNid = new Map();
  for (const ret of await approvedCustomerReturns(tenantId, from, to)) {
    if (!(ret.tax_net > 0)) continue;
    if (!(ret.tax_id || ret.customer_tax_id)) {
      skipped.push({ reason: 'cliente_sin_nit', customer_id: ret.customer_id });
      continue;
    }
    const tp = mapCustomerToExogena({ ...ret, tax_id: ret.tax_id || ret.customer_tax_id });
    const key = `${tp.tdoc}|${tp.nid}`;
    if (!ivadeByNid.has(key)) ivadeByNid.set(key, { tp, value: 0 });
    ivadeByNid.get(key).value += ret.tax_net;
  }

  for (const row of rows) {
    if (!row.tax_id) {
      skipped.push({ reason: 'proveedor_sin_nit', supplier_id: row.supplier_id });
      continue;
    }
    const thirdParty = mapSupplierToExogena(row);
    const ivadeKey = `${thirdParty.tdoc}|${thirdParty.nid}`;
    const ivade = ivadeByNid.get(ivadeKey)?.value || 0;
    ivadeByNid.delete(ivadeKey);
    records.push({
      tdoc: thirdParty.tdoc, nid: thirdParty.nid, dv: thirdParty.dv,
      apl1: thirdParty.apl1 || null, apl2: thirdParty.apl2 || null,
      nom1: thirdParty.nom1 || null, nom2: thirdParty.nom2 || null,
      raz: thirdParty.raz || null,
      vimp: Math.round(Number(row.vimp || 0)),
      ivade: Math.round(ivade),
      ivavcg: 0,
    });
  }

  // Clientes con devoluciones que no son proveedores del año: solo ivade.
  for (const { tp, value } of ivadeByNid.values()) {
    records.push({
      tdoc: tp.tdoc, nid: tp.nid, dv: tp.dv,
      apl1: tp.apl1 || null, apl2: tp.apl2 || null,
      nom1: tp.nom1 || null, nom2: tp.nom2 || null,
      raz: tp.raz || null,
      vimp: 0,
      ivade: Math.round(value),
      ivavcg: 0,
    });
  }

  return { records, skipped };
}

module.exports = {
  formatCode: '1005',
  version: 8,
  recordElementName: 'impventas',
  totalValueField: 'vimp',
  buildRecords,
};
