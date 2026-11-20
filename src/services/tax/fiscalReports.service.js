// backend/src/services/tax/fiscalReports.service.js
//
// Informes para declarar renta SIN contabilidad (personas naturales no
// obligadas a llevar libros, régimen simple, o negocios que aún no usan el
// módulo contable). Todo sale de los documentos operativos — ventas,
// devoluciones, compras, gastos, kardex, cartera y cuentas por pagar —, no
// de los asientos, así que funciona aunque el tenant no tenga plan de cuentas.
//
//   summary(from, to)   ingresos brutos y netos, costo de ventas (kardex y
//                       juego de inventarios), compras, gastos por categoría,
//                       retenciones que le practicaron y que practicó, y
//                       patrimonio al corte (inventario, cartera, activos
//                       fijos, deudas con proveedores).
//   dailyBook(from, to) libro fiscal de operaciones diarias: por día, ventas
//                       sin IVA, IVA generado, compras, gastos.
//
// Montos sin IVA salvo donde se indica. Las remisiones cuentan como ingreso
// (son ventas); la factura consolidada de remisiones no, para no duplicarlas.

'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;

// Ventas que son ingreso: confirmadas, no cotización ni notas, no la factura
// que solo consolida remisiones ya contadas.
const SALE_FILTER = `s.tenant_id = :tenantId
  AND s.status IN ('completed', 'pending')
  AND (s.document_type IS NULL OR s.document_type::text IN ('factura', 'remision'))
  AND s.is_consolidated_invoice IS NOT TRUE`;

// INC de una venta (va en las líneas): no es ingreso, es impuesto.
const INC_OF = (alias) => `COALESCE((SELECT SUM(COALESCE(si.inc_amount, 0)) FROM "${getCurrentSchema() || 'public'}".sale_items si WHERE si.sale_id = ${alias}.id), 0)`;

function q(sql, replacements) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

async function incomeBlock(S, r) {
  // INC por venta (va en las líneas): no es ingreso, es impuesto.
  const [sales] = await q(`
    WITH inc AS (
      SELECT si.sale_id, SUM(COALESCE(si.inc_amount, 0)) AS inc FROM "${S}".sale_items si GROUP BY si.sale_id
    )
    SELECT COUNT(*)::int AS docs,
      COALESCE(SUM(s.total_amount - s.tax_amount - COALESCE(inc.inc, 0)), 0) AS net,
      COALESCE(SUM(s.tax_amount), 0) AS iva,
      COALESCE(SUM(COALESCE(inc.inc, 0)), 0) AS inc,
      COALESCE(SUM(s.total_amount), 0) AS gross_with_tax,
      COALESCE(SUM(s.retefuente_amount), 0) AS retefuente,
      COALESCE(SUM(s.reteiva_amount), 0) AS reteiva,
      COALESCE(SUM(s.reteica_amount), 0) AS reteica,
      COALESCE(SUM(s.net_factura), 0) AS net_factura
    FROM (
      SELECT s.*, CASE WHEN s.document_type::text = 'factura' THEN s.total_amount - s.tax_amount ELSE 0 END AS net_factura
      FROM "${S}".sales s
      WHERE ${SALE_FILTER} AND COALESCE(s.sale_date, s.created_at)::date BETWEEN :from AND :to
    ) s LEFT JOIN inc ON inc.sale_id = s.id`, r);

  // Devoluciones aprobadas (no revertidas) del periodo: restan del ingreso.
  const [returns] = await q(`
    SELECT COUNT(*)::int AS docs,
      COALESCE(SUM(cr.total_amount - COALESCE(cr.tax, 0)), 0) AS net,
      COALESCE(SUM(cr.tax), 0) AS iva
    FROM "${S}".customer_returns cr
    WHERE cr.tenant_id = :tenantId AND cr.status = 'approved' AND cr.reversed_at IS NULL
      AND cr.return_date::date BETWEEN :from AND :to`, r);

  // Notas crédito/débito que NO salen de una devolución (ajustes de precio,
  // descuentos posteriores): las de devolución ya están arriba.
  const notes = await q(`
    SELECT s.document_type::text AS type, COUNT(*)::int AS docs,
      COALESCE(SUM(s.total_amount - s.tax_amount), 0) AS net, COALESCE(SUM(s.tax_amount), 0) AS iva
    FROM "${S}".sales s
    WHERE s.tenant_id = :tenantId AND s.document_type::text IN ('nota_credito', 'nota_debito')
      AND s.status <> 'cancelled' AND s.status <> 'draft'
      AND COALESCE(s.sale_date, s.created_at)::date BETWEEN :from AND :to
      AND NOT EXISTS (SELECT 1 FROM "${S}".customer_returns cr WHERE cr.credit_note_sale_id = s.id)
    GROUP BY s.document_type`, r);
  const note = (t) => notes.find((n) => n.type === t) || { docs: 0, net: 0, iva: 0 };

  const byMonth = await q(`
    SELECT to_char(COALESCE(s.sale_date, s.created_at), 'YYYY-MM') AS month,
      COALESCE(SUM(s.total_amount - s.tax_amount - ${INC_OF('s')}), 0) AS net, COALESCE(SUM(s.tax_amount), 0) AS iva
    FROM "${S}".sales s
    WHERE ${SALE_FILTER} AND COALESCE(s.sale_date, s.created_at)::date BETWEEN :from AND :to
    GROUP BY 1 ORDER BY 1`, r);

  const gross = num(sales.net) + num(note('nota_debito').net);
  const deductions = num(returns.net) + num(note('nota_credito').net);
  return {
    sales_docs: sales.docs,
    gross_income: round2(gross),
    invoiced_income: round2(sales.net_factura),
    debit_notes: round2(note('nota_debito').net),
    returns: round2(returns.net),
    returns_docs: returns.docs,
    credit_notes: round2(note('nota_credito').net),
    net_income: round2(gross - deductions),
    iva_generated: round2(num(sales.iva) + num(note('nota_debito').iva) - num(returns.iva) - num(note('nota_credito').iva)),
    inc_generated: round2(sales.inc),
    // Retenciones que los clientes le practicaron (anticipo de renta/IVA/ICA).
    retentions_suffered: {
      retefuente: round2(sales.retefuente), reteiva: round2(sales.reteiva), reteica: round2(sales.reteica),
      total: round2(num(sales.retefuente) + num(sales.reteiva) + num(sales.reteica)),
    },
    by_month: byMonth.map((m) => ({ month: m.month, net: round2(m.net), iva: round2(m.iva) })),
  };
}

// Valor del inventario a una fecha: suma de los costos de los movimientos
// (entradas menos salidas), igual que el saldo valorizado del kardex.
async function inventoryValueAt(S, tenantId, date) {
  const [row] = await q(`
    SELECT COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.total_cost WHEN m.direction = 'out' THEN -m.total_cost ELSE 0 END), 0) AS value
    FROM "${S}".inventory_movements m
    WHERE m.tenant_id = :tenantId AND m.movement_date <= :date`, { tenantId, date });
  return round2(row.value);
}

async function costBlock(S, r) {
  // Costo de lo vendido según el costo de cada línea al venderla (neto de devoluciones).
  const [kardex] = await q(`
    SELECT COALESCE(SUM((si.quantity - COALESCE(ret.rq, 0))
      * CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END), 0) AS cost
    FROM "${S}".sale_items si
    JOIN "${S}".sales s ON s.id = si.sale_id
    LEFT JOIN "${S}".products p ON p.id = si.product_id
    LEFT JOIN (
      SELECT cri.sale_item_id, SUM(cri.quantity) AS rq
      FROM "${S}".customer_return_items cri JOIN "${S}".customer_returns cr ON cr.id = cri.return_id
      WHERE cr.tenant_id = :tenantId AND cr.status = 'approved' AND cr.reversed_at IS NULL
      GROUP BY cri.sale_item_id
    ) ret ON ret.sale_item_id = si.id
    WHERE ${SALE_FILTER} AND COALESCE(s.sale_date, s.created_at)::date BETWEEN :from AND :to
      AND si.product_id IS NOT NULL AND COALESCE(p.product_type, '') <> 'service'`, r);

  // Compras del periodo que entraron al inventario (recibidas), netas de descuento,
  // con flete e impuestos que son costo; menos devoluciones a proveedor.
  const [purchases] = await q(`
    SELECT COUNT(*)::int AS docs,
      COALESCE(SUM(p.subtotal - COALESCE(p.discount_amount, 0) + COALESCE(p.shipping_cost, 0)), 0) AS net,
      COALESCE(SUM(p.tax_amount), 0) AS iva,
      COALESCE(SUM(CASE WHEN p.iva_to_cost THEN p.tax_amount ELSE 0 END), 0) AS iva_to_cost,
      COALESCE(SUM(p.retefuente_amount), 0) AS retefuente,
      COALESCE(SUM(p.reteiva_amount), 0) AS reteiva,
      COALESCE(SUM(p.reteica_amount), 0) AS reteica
    FROM "${S}".purchases p
    WHERE p.tenant_id = :tenantId AND p.status IN ('received', 'partially_received')
      AND p.purchase_date::date BETWEEN :from AND :to`, r);
  const [supplierReturns] = await q(`
    SELECT COALESCE(SUM(sr.total_amount - COALESCE(sr.tax, 0)), 0) AS net
    FROM "${S}".supplier_returns sr
    WHERE sr.tenant_id = :tenantId AND sr.status = 'approved' AND sr.reversed_at IS NULL
      AND sr.return_date::date BETWEEN :from AND :to`, r);

  const dayBefore = new Date(`${r.from}T12:00:00`);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const openingInventory = await inventoryValueAt(S, r.tenantId, dayBefore.toISOString().slice(0, 10));
  const closingInventory = await inventoryValueAt(S, r.tenantId, r.to);
  const netPurchases = round2(num(purchases.net) + num(purchases.iva_to_cost) - num(supplierReturns.net));

  return {
    cost_of_sales: round2(kardex.cost),
    // Juego de inventarios: inicial + compras - final (control cruzado con el kardex).
    inventory_game: {
      opening_inventory: openingInventory,
      net_purchases: netPurchases,
      closing_inventory: closingInventory,
      cost: round2(openingInventory + netPurchases - closingInventory),
    },
    purchases: {
      docs: purchases.docs,
      net: round2(purchases.net),
      supplier_returns: round2(supplierReturns.net),
      iva: round2(purchases.iva),
      iva_to_cost: round2(purchases.iva_to_cost),
    },
    retentions_practiced_purchases: {
      retefuente: round2(purchases.retefuente), reteiva: round2(purchases.reteiva), reteica: round2(purchases.reteica),
    },
  };
}

const EXPENSE_LABELS = {
  arriendo: 'Arriendos', servicios_publicos: 'Servicios públicos', nomina: 'Nómina y salarios',
  mantenimiento: 'Mantenimiento y reparaciones', transporte: 'Transporte y fletes', impuestos: 'Impuestos',
  marketing: 'Publicidad', insumos_oficina: 'Papelería e insumos', seguros: 'Seguros', honorarios: 'Honorarios',
  comisiones_tecnicos: 'Comisiones', otro: 'Otros gastos',
};

async function expenseBlock(S, r) {
  // Fletes de compras (purchase_id) ya están en el costo: no son gasto.
  const rows = await q(`
    SELECT e.category, COUNT(*)::int AS docs,
      COALESCE(SUM(COALESCE(e.subtotal, e.total_amount - COALESCE(e.tax_amount, 0))), 0) AS net,
      COALESCE(SUM(e.tax_amount), 0) AS iva,
      COALESCE(SUM(e.retefuente_amount), 0) AS retefuente,
      COALESCE(SUM(e.reteiva_amount), 0) AS reteiva,
      COALESCE(SUM(e.reteica_amount), 0) AS reteica
    FROM "${S}".expenses e
    WHERE e.tenant_id = :tenantId AND e.purchase_id IS NULL
      AND e.expense_date::date BETWEEN :from AND :to
    GROUP BY e.category ORDER BY net DESC`, r);
  const sum = (k) => round2(rows.reduce((acc, x) => acc + num(x[k]), 0));
  return {
    by_category: rows.map((x) => ({ category: x.category, label: EXPENSE_LABELS[x.category] || x.category, docs: x.docs, net: round2(x.net), iva: round2(x.iva) })),
    total: sum('net'),
    iva: sum('iva'),
    retentions_practiced: { retefuente: sum('retefuente'), reteiva: sum('reteiva'), reteica: sum('reteica') },
  };
}

// Pagos de un documento hasta una fecha (payment_history [{date, amount}]).
const PAID_UNTIL = (alias) => `(SELECT COALESCE(SUM((ph->>'amount')::numeric), 0)
  FROM jsonb_array_elements(COALESCE(${alias}.payment_history, '[]'::jsonb)) ph
  WHERE (ph->>'date') IS NOT NULL AND LEFT(ph->>'date', 10)::date <= :to)`;

async function equityBlock(S, r) {
  const inventory = await inventoryValueAt(S, r.tenantId, r.to);

  const [receivables] = await q(`
    SELECT COALESCE(SUM(GREATEST(s.total_amount - COALESCE(s.returned_amount, 0) - COALESCE(s.total_retentions, 0) - ${PAID_UNTIL('s')}, 0)), 0) AS balance,
      COUNT(*) FILTER (WHERE s.total_amount - COALESCE(s.returned_amount, 0) - COALESCE(s.total_retentions, 0) - ${PAID_UNTIL('s')} > 0.5)::int AS docs
    FROM "${S}".sales s
    WHERE ${SALE_FILTER} AND COALESCE(s.sale_date, s.created_at)::date <= :to`, r);

  const [payablePurchases] = await q(`
    SELECT COALESCE(SUM(GREATEST(p.total_amount - COALESCE(p.total_retentions, 0) - COALESCE(p.returned_amount, 0) - ${PAID_UNTIL('p')}, 0)), 0) AS balance
    FROM "${S}".purchases p
    WHERE p.tenant_id = :tenantId AND p.status IN ('received', 'partially_received')
      AND p.purchase_date::date <= :to`, r);
  const [payableExpenses] = await q(`
    SELECT COALESCE(SUM(GREATEST(e.total_amount - COALESCE(e.total_retentions, 0) - ${PAID_UNTIL('e')}, 0)), 0) AS balance
    FROM "${S}".expenses e
    WHERE e.tenant_id = :tenantId AND e.expense_date::date <= :to`, r);

  // Activos fijos vigentes al corte, a su costo histórico (la depreciación
  // fiscal se toma del módulo de activos si se lleva).
  let fixedAssets = 0;
  try {
    const [fa] = await q(`
      SELECT COALESCE(SUM(COALESCE(fa.fiscal_cost, fa.acquisition_cost)), 0) AS cost
      FROM "${S}".fixed_assets fa
      WHERE fa.tenant_id = :tenantId AND fa.acquisition_date <= :to
        AND (fa.disposal_date IS NULL OR fa.disposal_date > :to)`, r);
    fixedAssets = round2(fa.cost);
  } catch { /* tenant sin módulo de activos */ }

  const assets = round2(inventory + num(receivables.balance) + fixedAssets);
  const liabilities = round2(num(payablePurchases.balance) + num(payableExpenses.balance));
  return {
    cut_date: r.to,
    inventory,
    receivables: round2(receivables.balance),
    receivables_docs: receivables.docs,
    fixed_assets_cost: fixedAssets,
    // Caja y bancos no se pueden reconstruir sin contabilidad: se digitan en pantalla.
    known_assets: assets,
    payables_suppliers: round2(payablePurchases.balance),
    payables_expenses: round2(payableExpenses.balance),
    known_liabilities: liabilities,
  };
}

async function summary(tenantId, { from, to }) {
  const S = getCurrentSchema() || 'public';
  const r = { tenantId, from, to };
  const [income, cost, expenses, equity] = await Promise.all([
    incomeBlock(S, r), costBlock(S, r), expenseBlock(S, r), equityBlock(S, r),
  ]);
  const grossProfit = round2(income.net_income - cost.cost_of_sales);
  return {
    period: { from, to },
    income,
    cost,
    expenses,
    result: {
      net_income: income.net_income,
      cost_of_sales: cost.cost_of_sales,
      gross_profit: grossProfit,
      expenses: expenses.total,
      operating_profit: round2(grossProfit - expenses.total),
    },
    retentions_practiced: {
      retefuente: round2(cost.retentions_practiced_purchases.retefuente + expenses.retentions_practiced.retefuente),
      reteiva: round2(cost.retentions_practiced_purchases.reteiva + expenses.retentions_practiced.reteiva),
      reteica: round2(cost.retentions_practiced_purchases.reteica + expenses.retentions_practiced.reteica),
    },
    equity,
  };
}

async function dailyBook(tenantId, { from, to }) {
  const S = getCurrentSchema() || 'public';
  const r = { tenantId, from, to };
  const rows = await q(`
    WITH days AS (
      SELECT d::date AS day FROM generate_series(:from::date, :to::date, interval '1 day') d
    ),
    sales AS (
      SELECT COALESCE(s.sale_date, s.created_at)::date AS day, COUNT(*)::int AS docs,
        SUM(s.total_amount - s.tax_amount - ${INC_OF('s')}) AS net, SUM(s.tax_amount) AS iva, SUM(s.total_amount) AS total
      FROM "${S}".sales s WHERE ${SALE_FILTER} AND COALESCE(s.sale_date, s.created_at)::date BETWEEN :from AND :to
      GROUP BY 1
    ),
    notes AS (
      -- Notas crédito/débito que no salen de una devolución (como en el resumen).
      SELECT COALESCE(s.sale_date, s.created_at)::date AS day,
        SUM(CASE WHEN s.document_type::text = 'nota_debito' THEN s.total_amount - s.tax_amount ELSE 0 END) AS debit_net,
        SUM(CASE WHEN s.document_type::text = 'nota_credito' THEN s.total_amount - s.tax_amount ELSE 0 END) AS credit_net
      FROM "${S}".sales s
      WHERE s.tenant_id = :tenantId AND s.document_type::text IN ('nota_credito', 'nota_debito')
        AND s.status NOT IN ('cancelled', 'draft')
        AND COALESCE(s.sale_date, s.created_at)::date BETWEEN :from AND :to
        AND NOT EXISTS (SELECT 1 FROM "${S}".customer_returns cr WHERE cr.credit_note_sale_id = s.id)
      GROUP BY 1
    ),
    rets AS (
      SELECT cr.return_date::date AS day, SUM(cr.total_amount - COALESCE(cr.tax, 0)) AS net
      FROM "${S}".customer_returns cr
      WHERE cr.tenant_id = :tenantId AND cr.status = 'approved' AND cr.reversed_at IS NULL AND cr.return_date::date BETWEEN :from AND :to
      GROUP BY 1
    ),
    purch AS (
      SELECT p.purchase_date::date AS day, SUM(p.subtotal - COALESCE(p.discount_amount, 0) + COALESCE(p.shipping_cost, 0)) AS net, SUM(p.tax_amount) AS iva
      FROM "${S}".purchases p
      WHERE p.tenant_id = :tenantId AND p.status IN ('received', 'partially_received') AND p.purchase_date::date BETWEEN :from AND :to
      GROUP BY 1
    ),
    exp AS (
      SELECT e.expense_date::date AS day, SUM(COALESCE(e.subtotal, e.total_amount - COALESCE(e.tax_amount, 0))) AS net
      FROM "${S}".expenses e
      WHERE e.tenant_id = :tenantId AND e.purchase_id IS NULL AND e.expense_date::date BETWEEN :from AND :to
      GROUP BY 1
    )
    SELECT days.day, COALESCE(sales.docs, 0) AS sales_docs, COALESCE(sales.net, 0) AS sales_net, COALESCE(sales.iva, 0) AS sales_iva,
      COALESCE(rets.net, 0) + COALESCE(notes.credit_net, 0) AS returns_net, COALESCE(notes.debit_net, 0) AS debit_net,
      COALESCE(purch.net, 0) AS purchases_net, COALESCE(purch.iva, 0) AS purchases_iva,
      COALESCE(exp.net, 0) AS expenses_net
    FROM days
    LEFT JOIN sales ON sales.day = days.day LEFT JOIN rets ON rets.day = days.day LEFT JOIN notes ON notes.day = days.day
    LEFT JOIN purch ON purch.day = days.day LEFT JOIN exp ON exp.day = days.day
    WHERE sales.day IS NOT NULL OR rets.day IS NOT NULL OR notes.day IS NOT NULL OR purch.day IS NOT NULL OR exp.day IS NOT NULL
    ORDER BY days.day`, r);
  const out = rows.map((x) => ({
    date: String(x.day instanceof Date ? x.day.toISOString() : x.day).slice(0, 10),
    sales_docs: x.sales_docs,
    // Ventas sin IVA ni INC, más notas débito; "devoluciones" incluye notas crédito sueltas.
    sales_net: round2(num(x.sales_net) + num(x.debit_net)),
    sales_iva: round2(x.sales_iva),
    returns_net: round2(x.returns_net),
    income_net: round2(num(x.sales_net) + num(x.debit_net) - num(x.returns_net)),
    purchases_net: round2(x.purchases_net),
    purchases_iva: round2(x.purchases_iva),
    expenses_net: round2(x.expenses_net),
  }));
  const tot = (k) => round2(out.reduce((a, d) => a + num(d[k]), 0));
  return {
    period: { from, to },
    days: out,
    totals: {
      sales_net: tot('sales_net'), sales_iva: tot('sales_iva'), returns_net: tot('returns_net'), income_net: tot('income_net'),
      purchases_net: tot('purchases_net'), purchases_iva: tot('purchases_iva'), expenses_net: tot('expenses_net'),
    },
  };
}

module.exports = { summary, dailyBook, inventoryValueAt };
