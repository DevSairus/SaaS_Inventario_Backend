// backend/src/controllers/accounting/withholdingReport.controller.js
//
// 4.2 del análisis contable: "Certificado / reporte de retenciones
// (ReteFuente, ReteICA)". El modelo Sale ya captura retefuente_rate/amount
// y reteica_rate/amount por venta (retención que el CLIENTE practica sobre
// Pitbox al pagarle), pero no había ningún reporte que los agrupara.
//
// Nota de diseño: autoEntries.service.js hoy NO genera línea contable para
// estos valores (no hay cuenta de "Retención en la Fuente a favor" en uso
// en el motor de asientos, aunque el PUC sembrado sí trae la cuenta
// 135520 sin mapear). Conectar eso es un cambio más profundo al motor de
// asientos (nuevo account_mapping + tocar autoEntries + backfill) que se
// deja fuera de este alcance para no arriesgar el cuadre de asientos ya
// operando. Por ahora este reporte lee directo de `sales`, igual que
// `cashflow.controller.js` lee de `payment_history` en vez de la
// contabilidad — mismo patrón ya usado en el sistema para reportes de
// tesorería/gestión que no dependen de que el asiento exista.
//
// Es de solo lectura.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { generateWithholdingExcel } = require('../../services/accounting/reportsExcel.service');
const { generateWithholdingPDF } = require('../../services/accounting/reportsPdf.service');

function generatedByName(req) {
  return [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
}

async function fetchWithholding(req) {
  const { from, to, branch_id, customer_id } = req.query;
  if (!from || !to) {
    const err = new Error('from y to son obligatorios (YYYY-MM-DD)');
    err.statusCode = 400;
    throw err;
  }

  // Sin calificar schema, esto siempre leía "public" -- para un tenant ya
  // cortado a su propio schema el reporte salía vacío sin error visible.
  const schema = getCurrentSchema() || 'public';
  const rows = await sequelize.query(
    `SELECT s.id, s.sale_number, s.sale_date, s.subtotal, s.tax_amount, s.total_amount,
            s.retefuente_rate, s.retefuente_amount, s.reteica_rate, s.reteica_amount,
            c.id AS customer_id, c.business_name, c.first_name, c.last_name, c.tax_id AS customer_tax_id
     FROM "${schema}"."sales" s
     JOIN "${schema}"."customers" c ON c.id = s.customer_id
     WHERE s.tenant_id = :tenantId
       AND s.status = 'completed'
       AND s.sale_date BETWEEN :from AND :to
       AND (s.retefuente_amount > 0 OR s.reteica_amount > 0)
       AND (:branchId::uuid IS NULL OR s.branch_id = :branchId::uuid)
       AND (:customerId::uuid IS NULL OR s.customer_id = :customerId::uuid)
     ORDER BY c.business_name ASC NULLS LAST, s.sale_date ASC`,
    {
      replacements: { tenantId: req.tenant_id, from, to, branchId: branch_id || null, customerId: customer_id || null },
      type: QueryTypes.SELECT,
    }
  );

  const nameOf = (r) => r.business_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Cliente';

  const sales = rows.map((r) => ({
    id: r.id,
    sale_number: r.sale_number,
    sale_date: r.sale_date,
    customer_id: r.customer_id,
    customer_name: nameOf(r),
    customer_tax_id: r.customer_tax_id,
    subtotal: Number(r.subtotal),
    tax_amount: Number(r.tax_amount),
    total_amount: Number(r.total_amount),
    retefuente_rate: Number(r.retefuente_rate),
    retefuente_amount: Number(r.retefuente_amount),
    reteica_rate: Number(r.reteica_rate),
    reteica_amount: Number(r.reteica_amount),
  }));

  const byCustomer = new Map();
  for (const s of sales) {
    if (!byCustomer.has(s.customer_id)) {
      byCustomer.set(s.customer_id, {
        customer_id: s.customer_id,
        customer_name: s.customer_name,
        customer_tax_id: s.customer_tax_id,
        sales: [],
        total_base: 0,
        total_retefuente: 0,
        total_reteica: 0,
      });
    }
    const bucket = byCustomer.get(s.customer_id);
    bucket.sales.push(s);
    bucket.total_base += s.subtotal;
    bucket.total_retefuente += s.retefuente_amount;
    bucket.total_reteica += s.reteica_amount;
  }

  const customers = [...byCustomer.values()].sort((a, b) => a.customer_name.localeCompare(b.customer_name));

  const totals = sales.reduce(
    (acc, s) => ({
      base: acc.base + s.subtotal,
      retefuente: acc.retefuente + s.retefuente_amount,
      reteica: acc.reteica + s.reteica_amount,
    }),
    { base: 0, retefuente: 0, reteica: 0 }
  );

  return {
    from, to, branch_id: branch_id || null, customer_id: customer_id || null,
    customers, sales, totals,
  };
}

// GET /api/accounting/reports/retenciones?from=&to=&customer_id=&branch_id=
exports.withholding = async (req, res) => {
  try {
    const data = await fetchWithholding(req);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error al generar reporte de retenciones',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// GET /api/accounting/reports/retenciones/export?format=excel|pdf&from=&to=&customer_id=&branch_id=
// Si viene customer_id, exporta en formato "certificado" (un solo cliente);
// si no, exporta el consolidado de todos los clientes del período.
exports.withholdingExport = async (req, res) => {
  try {
    const format = req.query.format === 'pdf' ? 'pdf' : 'excel';
    const data = await fetchWithholding(req);
    const name = generatedByName(req);
    const suffix = data.customer_id ? (data.customers[0]?.customer_name || 'certificado') : 'consolidado';

    if (format === 'excel') {
      const buffer = await generateWithholdingExcel(data, req.tenant, {}, name);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Retenciones-${suffix}-${data.from}_${data.to}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    return generateWithholdingPDF(res, data, req.tenant, {}, name);
  } catch (error) {
    console.error('Error exportando reporte de retenciones:', error);
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : 'Error al exportar reporte de retenciones',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
};
