// backend/src/controllers/accounting/withholdingPracticed.controller.js
//
// Retenciones PRACTICADAS por el tenant a sus proveedores (ReteFuente,
// ReteIVA, ReteICA), separadas por concepto — la contraparte de
// withholdingReport.controller.js (que cubre las que los clientes le
// practican al tenant). Sirve como soporte para la declaración mensual de
// retención (Formulario 350), para cuadrar con Exógena 1001 y para emitir el
// certificado de retención a cada proveedor.
//
// Fuentes:
//  - purchases.applied_retentions: detalle por concepto (proveedor con
//    conceptos configurados). Compras viejas o de proveedores sin conceptos
//    solo tienen las columnas agregadas por tipo; esas salen con el nombre
//    genérico del tipo como concepto.
//  - expenses: tarifa única por tipo, el concepto se arma con la categoría
//    del gasto. ReteICA en gastos se captura en % (no ‰).
// Mismo criterio de inclusión que Exógena 1001: compras que no estén en
// borrador/anuladas y gastos con proveedor identificado.
//
// Es de solo lectura.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { fetchEntryDetails, fetchEntryIdsBySource } = require('../../services/accounting/entryDetails.service');
const { generateWithholdingPracticedExcel } = require('../../services/accounting/reportsExcel.service');
const { generateWithholdingPracticedPDF } = require('../../services/accounting/reportsPdf.service');

const TYPE_NAMES = { '07': 'ReteFuente', '05': 'ReteIVA', '06': 'ReteICA' };
const TYPE_KEYS = { '07': 'retefuente', '05': 'reteiva', '06': 'reteica' };

const EXPENSE_CATEGORY_LABELS = {
  arriendo: 'Arriendo', servicios_publicos: 'Servicios públicos', nomina: 'Nómina', mantenimiento: 'Mantenimiento',
  transporte: 'Transporte', impuestos: 'Impuestos', marketing: 'Marketing', insumos_oficina: 'Insumos de oficina',
  seguros: 'Seguros', honorarios: 'Honorarios', comisiones_tecnicos: 'Comisiones a técnicos', otro: 'Otros',
};

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function fetchWithholdingPracticed(req) {
  const { from, to, branch_id, supplier_id } = req.query;
  if (!from || !to) {
    const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
    err.statusCode = 400;
    throw err;
  }

  const schema = getCurrentSchema() || 'public';
  const replacements = { tenantId: req.tenant_id, from, to, branchId: branch_id || null, supplierId: supplier_id || null };

  const purchases = await sequelize.query(
    `SELECT p.id, p.purchase_number AS doc_number, p.invoice_number, p.purchase_date AS doc_date,
            p.subtotal, p.tax_amount,
            p.retefuente_rate, p.retefuente_amount, p.reteiva_rate, p.reteiva_amount,
            p.reteica_rate, p.reteica_amount, p.applied_retentions,
            s.id AS supplier_id, s.name AS supplier_name, s.business_name AS supplier_business_name,
            s.tax_id AS supplier_tax_id, s.address AS supplier_address, s.city AS supplier_city
     FROM "${schema}"."purchases" p
     JOIN "${schema}"."suppliers" s ON s.id = p.supplier_id
     WHERE p.tenant_id = :tenantId
       AND p.status NOT IN ('draft', 'cancelled')
       AND p.purchase_date BETWEEN :from AND :to
       AND COALESCE(p.total_retentions, 0) > 0
       AND (:branchId::uuid IS NULL OR p.branch_id = :branchId::uuid)
       AND (:supplierId::uuid IS NULL OR p.supplier_id = :supplierId::uuid)
     ORDER BY p.purchase_date ASC, p.purchase_number ASC`,
    { replacements, type: QueryTypes.SELECT }
  );

  const expenses = await sequelize.query(
    `SELECT e.id, e.expense_number AS doc_number, e.expense_date AS doc_date, e.category, e.description,
            e.subtotal, e.tax_amount,
            e.retefuente_rate, e.retefuente_amount, e.reteiva_rate, e.reteiva_amount,
            e.reteica_rate, e.reteica_amount,
            s.id AS supplier_id, s.name AS supplier_name, s.business_name AS supplier_business_name,
            s.tax_id AS supplier_tax_id, s.address AS supplier_address, s.city AS supplier_city
     FROM "${schema}"."expenses" e
     JOIN "${schema}"."suppliers" s ON s.id = e.supplier_id
     WHERE e.tenant_id = :tenantId
       AND e.expense_date BETWEEN :from AND :to
       AND COALESCE(e.total_retentions, 0) > 0
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
       AND (:supplierId::uuid IS NULL OR e.supplier_id = :supplierId::uuid)
     ORDER BY e.expense_date ASC, e.expense_number ASC`,
    { replacements, type: QueryTypes.SELECT }
  );

  const supplierOf = (r) => ({
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_business_name || r.supplier_name || 'Proveedor',
    supplier_tax_id: r.supplier_tax_id || '',
    supplier_address: r.supplier_address || '',
    supplier_city: r.supplier_city || '',
  });

  // Una fila por (documento, concepto de retención).
  const lines = [];

  for (const p of purchases) {
    const base = {
      source: 'purchase',
      doc_id: p.id,
      doc_number: p.doc_number,
      doc_reference: p.invoice_number || '',
      doc_date: p.doc_date,
      ...supplierOf(p),
    };
    const detail = Array.isArray(p.applied_retentions) ? p.applied_retentions : [];
    if (detail.length > 0) {
      for (const l of detail) {
        if (!TYPE_NAMES[l.code] || !(Number(l.amount) > 0)) continue;
        lines.push({
          ...base,
          code: l.code,
          type_name: TYPE_NAMES[l.code],
          concept: l.concept || TYPE_NAMES[l.code],
          rate: Number(l.rate),
          rate_unit: l.code === '06' ? '‰' : '%',
          base: round2(l.base),
          amount: round2(l.amount),
        });
      }
    } else {
      const legacy = [
        { code: '07', rate: p.retefuente_rate, amount: p.retefuente_amount, base: p.subtotal },
        { code: '05', rate: p.reteiva_rate, amount: p.reteiva_amount, base: p.tax_amount },
        { code: '06', rate: p.reteica_rate, amount: p.reteica_amount, base: p.subtotal },
      ];
      for (const l of legacy) {
        if (!(Number(l.amount) > 0)) continue;
        lines.push({
          ...base,
          code: l.code,
          type_name: TYPE_NAMES[l.code],
          concept: `${TYPE_NAMES[l.code]} compras`,
          rate: Number(l.rate),
          rate_unit: l.code === '06' ? '‰' : '%',
          base: round2(l.base),
          amount: round2(l.amount),
        });
      }
    }
  }

  for (const e of expenses) {
    const base = {
      source: 'expense',
      doc_id: e.id,
      doc_number: e.doc_number,
      doc_reference: e.description || '',
      doc_date: e.doc_date,
      ...supplierOf(e),
    };
    const categoryLabel = EXPENSE_CATEGORY_LABELS[e.category] || e.category || 'Gasto';
    const items = [
      { code: '07', rate: e.retefuente_rate, amount: e.retefuente_amount, base: e.subtotal, unit: '%' },
      { code: '05', rate: e.reteiva_rate, amount: e.reteiva_amount, base: e.tax_amount, unit: '%' },
      // Gastos capturan ReteICA en %; se muestra en ‰ como en compras.
      { code: '06', rate: Number(e.reteica_rate) * 10, amount: e.reteica_amount, base: e.subtotal, unit: '‰' },
    ];
    for (const l of items) {
      if (!(Number(l.amount) > 0)) continue;
      lines.push({
        ...base,
        code: l.code,
        type_name: TYPE_NAMES[l.code],
        concept: `${TYPE_NAMES[l.code]} gastos — ${categoryLabel}`,
        rate: round2(l.rate),
        rate_unit: l.unit,
        base: round2(l.base),
        amount: round2(l.amount),
      });
    }
  }

  lines.sort((a, b) => String(a.doc_date).localeCompare(String(b.doc_date)) || String(a.doc_number).localeCompare(String(b.doc_number)));

  // ── Por concepto (tipo + concepto + tarifa) ──
  const conceptKey = (l) => `${l.code}|${l.concept}|${l.rate}`;
  const byConceptMap = new Map();
  for (const l of lines) {
    const k = conceptKey(l);
    if (!byConceptMap.has(k)) {
      byConceptMap.set(k, { code: l.code, type_name: l.type_name, concept: l.concept, rate: l.rate, rate_unit: l.rate_unit, base: 0, amount: 0, documents: 0, suppliers: new Set() });
    }
    const c = byConceptMap.get(k);
    c.base += l.base;
    c.amount += l.amount;
    c.documents += 1;
    c.suppliers.add(l.supplier_id);
  }
  const typeOrder = { '07': 0, '05': 1, '06': 2 };
  const by_concept = [...byConceptMap.values()]
    .map((c) => ({ ...c, base: round2(c.base), amount: round2(c.amount), suppliers: c.suppliers.size }))
    .sort((a, b) => typeOrder[a.code] - typeOrder[b.code] || a.concept.localeCompare(b.concept) || a.rate - b.rate);

  // ── Por proveedor → concepto ──
  const bySupplierMap = new Map();
  for (const l of lines) {
    if (!bySupplierMap.has(l.supplier_id)) {
      bySupplierMap.set(l.supplier_id, {
        supplier_id: l.supplier_id,
        supplier_name: l.supplier_name,
        supplier_tax_id: l.supplier_tax_id,
        supplier_address: l.supplier_address,
        supplier_city: l.supplier_city,
        concepts: new Map(),
        totals: { retefuente: 0, reteiva: 0, reteica: 0, total: 0 },
      });
    }
    const s = bySupplierMap.get(l.supplier_id);
    const k = conceptKey(l);
    if (!s.concepts.has(k)) s.concepts.set(k, { code: l.code, type_name: l.type_name, concept: l.concept, rate: l.rate, rate_unit: l.rate_unit, base: 0, amount: 0 });
    const c = s.concepts.get(k);
    c.base += l.base;
    c.amount += l.amount;
    s.totals[TYPE_KEYS[l.code]] += l.amount;
    s.totals.total += l.amount;
  }
  const by_supplier = [...bySupplierMap.values()]
    .map((s) => ({
      ...s,
      concepts: [...s.concepts.values()]
        .map((c) => ({ ...c, base: round2(c.base), amount: round2(c.amount) }))
        .sort((a, b) => typeOrder[a.code] - typeOrder[b.code] || a.concept.localeCompare(b.concept)),
      totals: Object.fromEntries(Object.entries(s.totals).map(([k, v]) => [k, round2(v)])),
    }))
    .sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));

  const totals = lines.reduce((acc, l) => {
    acc[TYPE_KEYS[l.code]] += l.amount;
    acc.total += l.amount;
    return acc;
  }, { retefuente: 0, reteiva: 0, reteica: 0, total: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });

  return {
    from,
    to,
    branch_id: branch_id || null,
    supplier_id: supplier_id || null,
    lines,
    by_concept,
    by_supplier,
    totals,
  };
}

// GET /api/accounting/reports/retenciones-practicadas?from=&to=&supplier_id=&branch_id=
exports.withholdingPracticed = async (req, res) => {
  try {
    const data = await fetchWithholdingPracticed(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar reporte de retenciones practicadas',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/accounting/reports/retenciones-practicadas/export?format=excel|pdf&from=&to=&supplier_id=&branch_id=
// Con supplier_id el PDF sale en formato "certificado de retención" para ese
// proveedor; sin él, consolidado.
exports.withholdingPracticedExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchWithholdingPracticed(req);
    const name = generatedByName(req);
    const suffix = data.supplier_id ? (data.by_supplier[0]?.supplier_name || 'certificado') : 'consolidado';

    if (format === 'excel') {
      // Asiento de cada documento, para la hoja "Detalle de Asientos".
      const [purchaseEntries, expenseEntries] = await Promise.all([
        fetchEntryIdsBySource(req.tenant_id, 'purchase', data.lines.filter((l) => l.source === 'purchase').map((l) => l.doc_id)),
        fetchEntryIdsBySource(req.tenant_id, 'expense', data.lines.filter((l) => l.source === 'expense').map((l) => l.doc_id)),
      ]);
      const entryByDoc = new Map();
      for (const e of [...purchaseEntries, ...expenseEntries]) if (!entryByDoc.has(e.source_id)) entryByDoc.set(e.source_id, e);
      for (const l of data.lines) {
        const e = entryByDoc.get(l.doc_id);
        l.entry_id = e?.id || null;
        l.entry_number = e?.entry_number || null;
      }
      data.entry_details = await fetchEntryDetails(req.tenant_id, [...entryByDoc.values()].map((e) => e.id));

      const buffer = await generateWithholdingPracticedExcel(data, req.tenant, {}, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Retenciones-Practicadas-${encodeURIComponent(suffix)}-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateWithholdingPracticedPDF(res, data, req.tenant, {}, name);
  } catch (error) {
    console.error('Error exportando retenciones practicadas:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar retenciones practicadas',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
};

exports.fetchWithholdingPracticed = fetchWithholdingPracticed;
