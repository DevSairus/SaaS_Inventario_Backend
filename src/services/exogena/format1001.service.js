// backend/src/services/exogena/format1001.service.js
//
// Formato 1001 — Pagos o abonos en cuenta y retenciones practicadas.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4, Grupo A.
// Anexo técnico: T3.18 (F1001 v10, Resolución 000227/2025).
//
// Agrega Purchase + Expense (con proveedor identificado) por proveedor +
// concepto DIAN. El "concepto" (cpt) NO se adivina: viene de
// ExogenaConceptMapping, mapeado por el contador del tenant contra:
//  - 'purchase:<concepto de retención>' — las compras se separan por el
//    concepto de cada ítem (producto → categoría → proveedor → tipo, misma
//    cadena que services/retentionEngine.service.js): así una compra mixta
//    de repuestos y servicios va a 5007 y 5004 por separado, con su
//    ReteFuente real de cada concepto. Si no hay mapeo para
//    'purchase:<x>', se usa el mapeo general 'purchase' (compatibilidad
//    con lo configurado antes de este cambio).
//  - 'expense:<category>' — un concepto por categoría de gasto.
// Filas sin proveedor o sin concepto mapeado se reportan como `skipped` en
// vez de generarse con datos inventados.
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
const PURCHASE_PREFIX = 'purchase:';
const sourceKeyExpense = (category) => `expense:${category}`;

// 'nomina' se excluye explícitamente: por el Parágrafo 12 del Artículo
// 1.3.5.2.1 de la Resolución 000227/2025 ("Los pagos o abonos en cuenta que
// se realicen por concepto de rentas de trabajo y de pensiones sólo se
// deberán reportar de acuerdo con los parámetros establecidos para el
// Formato 2276"), esos pagos NUNCA van en el 1001 -- reportarlos ahí sería
// duplicar información que ya cubre el Formato 2276.
const EXCLUDED_EXPENSE_CATEGORIES = ['nomina'];

const EXPENSE_CATEGORY_LABELS = {
  arriendo: 'Arriendo', servicios_publicos: 'Servicios públicos', nomina: 'Nómina', mantenimiento: 'Mantenimiento',
  transporte: 'Transporte', impuestos: 'Impuestos', marketing: 'Marketing', insumos_oficina: 'Insumos de oficina',
  seguros: 'Seguros', honorarios: 'Honorarios', comisiones_tecnicos: 'Comisiones a técnicos', otro: 'Otros',
};

/** Concepto DIAN para una fuente, con respaldo 'purchase' para las compras por concepto. */
function resolveConcept(conceptBySourceKey, sourceKey) {
  if (conceptBySourceKey[sourceKey]) return conceptBySourceKey[sourceKey];
  if (String(sourceKey).startsWith(PURCHASE_PREFIX)) return conceptBySourceKey[SOURCE_KEY_PURCHASE] || null;
  return null;
}

// Concepto de retención de cada ítem comprado — misma cadena que el motor de
// retenciones: producto → categoría → proveedor (por defecto) → tipo.
function purchaseItemsSql(schema) {
  return `
    SELECT p.id AS purchase_id, p.supplier_id, pi.subtotal,
           COALESCE(NULLIF(pr.retention_concept, ''), NULLIF(c.retention_concept, ''),
                    NULLIF(s.retention_config->>'default_concept_id', ''),
                    CASE WHEN pr.product_type = 'service' THEN 'servicios' ELSE 'compras' END) AS concept_id
    FROM "${schema}"."purchases" p
    JOIN "${schema}"."suppliers" s ON s.id = p.supplier_id
    JOIN "${schema}"."purchase_items" pi ON pi.purchase_id = p.id
    LEFT JOIN "${schema}"."products" pr ON pr.id = pi.product_id
    LEFT JOIN "${schema}"."categories" c ON c.id = pr.category_id
    WHERE p.tenant_id = :tenantId AND p.status NOT IN ('draft', 'cancelled')
      AND p.purchase_date BETWEEN :from AND :to`;
}

async function fetchSourceKeys(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const y = Number(year) || new Date().getFullYear();
  const replacements = { tenantId, from: `${y}-01-01`, to: `${y}-12-31` };
  const [concepts, categories] = await Promise.all([
    sequelize.query(`SELECT DISTINCT concept_id FROM (${purchaseItemsSql(schema)}) x ORDER BY concept_id`, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(
      `SELECT DISTINCT category FROM "${schema}"."expenses" WHERE tenant_id = :tenantId AND supplier_id IS NOT NULL`,
      { replacements: { tenantId }, type: QueryTypes.SELECT }
    ),
  ]);
  return [
    ...concepts.map((c) => `${PURCHASE_PREFIX}${c.concept_id}`),
    ...categories
      .filter((c) => !EXCLUDED_EXPENSE_CATEGORIES.includes(c.category))
      .map((c) => sourceKeyExpense(c.category)),
  ];
}

/** Nombres legibles de las fuentes, para el panel de conceptos. */
async function describeSourceKeys(tenantId, keys) {
  const { Tenant } = require('../../models');
  const { resolveFiscalProfile } = require('../retentionEngine.service');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['tax_config'] });
  const conceptNames = new Map(resolveFiscalProfile(tenant?.tax_config || {}).concepts.map((c) => [c.id, c.name]));
  const labels = {};
  for (const key of keys) {
    if (key === SOURCE_KEY_PURCHASE) labels[key] = 'Compras (todas, mapeo general)';
    else if (key.startsWith(PURCHASE_PREFIX)) labels[key] = `Compras — ${conceptNames.get(key.slice(PURCHASE_PREFIX.length)) || key.slice(PURCHASE_PREFIX.length)}`;
    else if (key.startsWith('expense:')) labels[key] = `Gastos — ${EXPENSE_CATEGORY_LABELS[key.slice(8)] || key.slice(8)}`;
    else labels[key] = key;
  }
  return labels;
}

const SUPPLIER_COLS = 's.tax_id, s.document_type, s.person_type, s.name, s.business_name, s.city_code, s.address';

/**
 * Compras repartidas por concepto: pago = subtotal de los ítems de ese
 * concepto; retp = ReteFuente del detalle (applied_retentions) de ese
 * concepto, y lo que no tenga detalle se reparte por base; comun (ReteIVA)
 * se reparte en proporción a la base.
 */
async function fetchPurchaseRows(tenantId, from, to) {
  const schema = getCurrentSchema() || 'public';
  const replacements = { tenantId, from, to };
  const [items, purchases] = await Promise.all([
    sequelize.query(purchaseItemsSql(schema), { replacements, type: QueryTypes.SELECT }),
    sequelize.query(
      `SELECT p.id, p.supplier_id, p.retefuente_amount, p.reteiva_amount, p.applied_retentions, ${SUPPLIER_COLS}
       FROM "${schema}"."purchases" p
       JOIN "${schema}"."suppliers" s ON s.id = p.supplier_id
       WHERE p.tenant_id = :tenantId AND p.status NOT IN ('draft', 'cancelled')
         AND p.purchase_date BETWEEN :from AND :to`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  const basesByPurchase = new Map();
  for (const it of items) {
    if (!basesByPurchase.has(it.purchase_id)) basesByPurchase.set(it.purchase_id, new Map());
    const m = basesByPurchase.get(it.purchase_id);
    m.set(it.concept_id, (m.get(it.concept_id) || 0) + Number(it.subtotal || 0));
  }

  // Reparte `amount` entre los conceptos en proporción a su base; el último
  // toma el remanente para que la suma sea exacta.
  const spread = (bases, amount) => {
    const out = new Map();
    const entries = [...bases.entries()];
    const total = entries.reduce((s, [, b]) => s + b, 0);
    let assigned = 0;
    entries.forEach(([k, b], idx) => {
      const v = idx === entries.length - 1 ? amount - assigned : (total > 0 ? Math.round(amount * (b / total) * 100) / 100 : 0);
      assigned += v;
      out.set(k, v);
    });
    return out;
  };

  const rows = [];
  for (const p of purchases) {
    const bases = basesByPurchase.get(p.id);
    if (!bases || bases.size === 0) continue;
    const retp = new Map([...bases.keys()].map((k) => [k, 0]));

    // ReteFuente con detalle por concepto (compras registradas con el motor).
    const lines = (Array.isArray(p.applied_retentions) ? p.applied_retentions : []).filter((l) => l.code === '07');
    let matched = 0;
    for (const l of lines) {
      const amount = Number(l.amount || 0);
      if (l.concept_id && retp.has(l.concept_id)) {
        retp.set(l.concept_id, retp.get(l.concept_id) + amount);
        matched += amount;
      }
    }
    const remainder = Math.round((Number(p.retefuente_amount || 0) - matched) * 100) / 100;
    if (remainder > 0.004) {
      for (const [k, v] of spread(bases, remainder)) retp.set(k, retp.get(k) + v);
    }
    const comun = spread(bases, Number(p.reteiva_amount || 0));

    for (const [conceptId, base] of bases) {
      rows.push({
        supplier_id: p.supplier_id, tax_id: p.tax_id, document_type: p.document_type, person_type: p.person_type,
        name: p.name, business_name: p.business_name, city_code: p.city_code, address: p.address,
        source_key: `${PURCHASE_PREFIX}${conceptId}`,
        pago: base,
        retp: retp.get(conceptId) || 0,
        comun: comun.get(conceptId) || 0,
      });
    }
  }
  return rows;
}

async function fetchRows(tenantId, year) {
  const schema = getCurrentSchema() || 'public';
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const purchaseRows = await fetchPurchaseRows(tenantId, from, to);

  const expenseRows = await sequelize.query(
    `SELECT e.supplier_id, ${SUPPLIER_COLS},
            ('expense:' || e.category) AS source_key,
            SUM(e.subtotal) AS pago, SUM(e.retefuente_amount) AS retp, SUM(e.reteiva_amount) AS comun
     FROM "${schema}"."expenses" e
     JOIN "${schema}"."suppliers" s ON s.id = e.supplier_id
     WHERE e.tenant_id = :tenantId AND e.supplier_id IS NOT NULL
       AND e.category NOT IN (:excludedCategories)
       AND e.expense_date BETWEEN :from AND :to
     GROUP BY e.supplier_id, ${SUPPLIER_COLS}, e.category`,
    { replacements: { tenantId, from, to, excludedCategories: EXCLUDED_EXPENSE_CATEGORIES }, type: QueryTypes.SELECT }
  );

  return [...purchaseRows, ...expenseRows];
}

/** Totales por fuente (pago y ReteFuente) para mostrar en el panel de conceptos. */
async function summarizeSourceKeys(tenantId, year) {
  const rows = await fetchRows(tenantId, year);
  const out = {};
  for (const r of rows) {
    if (!out[r.source_key]) out[r.source_key] = { pago: 0, retp: 0, suppliers: new Set() };
    out[r.source_key].pago += Number(r.pago || 0);
    out[r.source_key].retp += Number(r.retp || 0);
    out[r.source_key].suppliers.add(r.supplier_id);
  }
  for (const k of Object.keys(out)) {
    out[k] = { pago: Math.round(out[k].pago), retp: Math.round(out[k].retp), suppliers: out[k].suppliers.size };
  }
  return out;
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
    const cpt = resolveConcept(conceptBySourceKey, row.source_key);
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
  describeSourceKeys,
  resolveConcept,
  fetchPurchaseRows,
  purchaseItemsSql,
  summarizeSourceKeys,
  buildRecords,
};
