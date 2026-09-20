// backend/src/services/exogena/format1001.service.js
//
// Formato 1001 — Pagos o abonos en cuenta y retenciones practicadas.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.18 (F1001 v10, Resolución 000227/2025).
//
// Agrega Purchase + Expense (con proveedor identificado) por proveedor +
// concepto DIAN. El "concepto" (cpt) NO se adivina: viene de
// ExogenaConceptMapping, mapeado por el contador del tenant contra
// 'purchase' (compras de bienes) y 'expense:<category>' (un concepto por
// categoría de gasto). Filas sin proveedor o sin concepto mapeado se
// reportan como `skipped` en vez de generarse con datos inventados.
//
// Atributos según XSD (no según la tabla de prosa, que en algún anexo trae
// texto desactualizado respecto al esquema real que valida la DIAN):
// cpt, tdoc, nid, apl1, apl2, nom1, nom2, raz, dir, dpto, mun, pais,
// pago, pnded, ided, inded, retp, reta, comun, ndom.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { mapSupplierToExogena } = require('./thirdPartyMapper');

const SOURCE_KEY_PURCHASE = 'purchase';
const sourceKeyExpense = (category) => `expense:${category}`;

// 'nomina' se excluye explícitamente: por el Parágrafo 12 del Artículo
// 1.3.5.2.1 de la Resolución 000227/2025 ("Los pagos o abonos en cuenta que
// se realicen por concepto de rentas de trabajo y de pensiones sólo se
// deberán reportar de acuerdo con los parámetros establecidos para el
// Formato 2276"), esos pagos NUNCA van en el 1001 -- reportarlos ahí sería
// duplicar información que ya cubre el Formato 2276.
const EXCLUDED_EXPENSE_CATEGORIES = ['nomina'];

async function fetchSourceKeys(tenantId) {
  const schema = getCurrentSchema() || 'public';
  const categories = await sequelize.query(
    `SELECT DISTINCT category FROM "${schema}"."expenses" WHERE tenant_id = :tenantId AND supplier_id IS NOT NULL`,
    { replacements: { tenantId }, type: QueryTypes.SELECT }
  );
  const keys = [
    SOURCE_KEY_PURCHASE,
    ...categories
      .filter((c) => !EXCLUDED_EXPENSE_CATEGORIES.includes(c.category))
      .map((c) => sourceKeyExpense(c.category)),
  ];
  return keys;
}

async function fetchRows(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const purchaseRows = await sequelize.query(
    `SELECT p.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address,
            '${SOURCE_KEY_PURCHASE}' AS source_key,
            SUM(p.subtotal) AS pago, SUM(p.retefuente_amount) AS retp, SUM(p.reteiva_amount) AS comun
     FROM "${schema}"."purchases" p
     JOIN "${schema}"."suppliers" s ON s.id = p.supplier_id
     WHERE p.tenant_id = :tenantId AND p.status NOT IN ('draft', 'cancelled')
       AND p.purchase_date BETWEEN :from AND :to
     GROUP BY p.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address`,
    { replacements: { tenantId, from, to }, type: QueryTypes.SELECT }
  );

  const expenseRows = await sequelize.query(
    `SELECT e.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address,
            ('expense:' || e.category) AS source_key,
            SUM(e.subtotal) AS pago, SUM(e.retefuente_amount) AS retp, SUM(e.reteiva_amount) AS comun
     FROM "${schema}"."expenses" e
     JOIN "${schema}"."suppliers" s ON s.id = e.supplier_id
     WHERE e.tenant_id = :tenantId AND e.supplier_id IS NOT NULL
       AND e.category NOT IN (:excludedCategories)
       AND e.expense_date BETWEEN :from AND :to
     GROUP BY e.supplier_id, s.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address, e.category`,
    { replacements: { tenantId, from, to, excludedCategories: EXCLUDED_EXPENSE_CATEGORIES }, type: QueryTypes.SELECT }
  );

  return [...purchaseRows, ...expenseRows];
}

/**
 * @returns {{ records: Array<object>, skipped: Array<object> }}
 */
async function buildRecords(tenantId, year, conceptBySourceKey) {
  const rows = await fetchRows(tenantId, year);
  const skipped = [];

  // Agrupa por (proveedor, concepto) -- la llave única del formato exige
  // que no se repita (cpt, tdoc, nid) por año, así que dos source_keys que
  // mapeen al mismo concepto para el mismo proveedor deben sumarse juntas.
  const byKey = new Map();

  for (const row of rows) {
    const cpt = conceptBySourceKey[row.source_key];
    if (!cpt) {
      skipped.push({ reason: 'sin_concepto_mapeado', source_key: row.source_key, supplier_id: row.supplier_id });
      continue;
    }
    if (!row.tax_id) {
      skipped.push({ reason: 'proveedor_sin_nit', supplier_id: row.supplier_id });
      continue;
    }

    const thirdParty = mapSupplierToExogena(row);
    const key = `${cpt}|${thirdParty.tdoc}|${thirdParty.nid}`;
    if (!byKey.has(key)) {
      byKey.set(key, { cpt, ...thirdParty, pago: 0, pnded: 0, ided: 0, inded: 0, retp: 0, reta: 0, comun: 0, ndom: 0 });
    }
    const acc = byKey.get(key);
    acc.pago += Number(row.pago || 0);
    acc.retp += Number(row.retp || 0);
    acc.comun += Number(row.comun || 0);
  }

  const records = [...byKey.values()].map((r) => ({
    ...r,
    pago: Math.round(r.pago),
    pnded: Math.round(r.pnded),
    ided: Math.round(r.ided),
    inded: Math.round(r.inded),
    retp: Math.round(r.retp),
    reta: Math.round(r.reta),
    comun: Math.round(r.comun),
    ndom: Math.round(r.ndom),
  }));

  return { records, skipped };
}

module.exports = {
  formatCode: '1001',
  version: 10,
  recordElementName: 'pagos',
  totalValueField: 'pago',
  fetchSourceKeys,
  buildRecords,
};
