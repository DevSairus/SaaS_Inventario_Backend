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
const { fetchEntryDetails, fetchEntryIdsBySource } = require('../../services/accounting/entryDetails.service');
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
  // Retenciones REGISTRADAS (las que el cliente practicó y se contabilizaron),
  // no la estimación guardada al crear la venta -- ver
  // services/sales/registeredRetentions.js. Ventas confirmadas: 'pending'
  // (generadas desde OT, aún no entregadas) también cuentan.
  const { registeredRetentionsLateral } = require('../../services/sales/registeredRetentions');
  const rows = await sequelize.query(
    `SELECT s.id, s.sale_number, s.sale_date, s.subtotal, s.tax_amount, s.total_amount,
            r.retefuente AS retefuente_amount, r.reteica AS reteica_amount,
            c.id AS customer_id, c.business_name, c.first_name, c.last_name, c.tax_id AS customer_tax_id
     FROM "${schema}"."sales" s
     JOIN "${schema}"."customers" c ON c.id = s.customer_id
     CROSS JOIN LATERAL ${registeredRetentionsLateral('s')} r
     WHERE s.tenant_id = :tenantId
       AND s.status IN ('pending', 'completed')
       AND s.is_consolidated_invoice IS NOT TRUE
       AND s.sale_date BETWEEN :from AND :to
       AND (r.retefuente > 0 OR r.reteica > 0)
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
    // Tarifa efectiva de lo registrado sobre la base de la venta.
    retefuente_rate: Number(r.subtotal) > 0 ? Math.round(Number(r.retefuente_amount) / Number(r.subtotal) * 10000) / 100 : 0,
    retefuente_amount: Number(r.retefuente_amount),
    reteica_rate: Number(r.subtotal) > 0 ? Math.round(Number(r.reteica_amount) / Number(r.subtotal) * 100000) / 100 : 0,
    reteica_amount: Number(r.reteica_amount),
  }));

  // Devoluciones de clientes aprobadas en el período sobre facturas con
  // retención: la retención de lo devuelto se reversa (en proporción a lo
  // devuelto sobre la factura). Filas NEGATIVAS para que netee en el total
  // por cliente y en el certificado.
  const { approvedCustomerReturns } = require('../../services/returns/returnFiscalData');
  const returns = await approvedCustomerReturns(req.tenant_id, from, to, { customerId: customer_id || null, branchId: branch_id || null });
  for (const r of returns) {
    if (!r.customer_id || !(r.retefuente_share > 0 || r.reteica_share > 0)) continue;
    sales.push({
      id: r.id,
      sale_number: `${r.return_number} (devolución de ${r.sale_number})`,
      sale_date: String(r.approved_at instanceof Date ? r.approved_at.toISOString() : r.approved_at).slice(0, 10),
      customer_id: r.customer_id,
      customer_name: nameOf(r),
      customer_tax_id: r.customer_tax_id || r.tax_id,
      subtotal: -r.base,
      tax_amount: -r.tax_net,
      total_amount: -Number(r.total_amount || 0),
      retefuente_rate: null,
      retefuente_amount: -r.retefuente_share,
      reteica_rate: null,
      reteica_amount: -r.reteica_share,
      is_return: true,
    });
  }

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
      // Este reporte lee de `sales`, no de la contabilidad: se busca el
      // asiento de cada venta (source_type='sale') para anexar su detalle.
      const entryRows = await fetchEntryIdsBySource(req.tenant_id, 'sale', data.sales.map((s) => s.id));
      const entryBySale = new Map();
      for (const e of entryRows) if (!entryBySale.has(e.source_id)) entryBySale.set(e.source_id, e);
      for (const s of data.sales) {
        const e = entryBySale.get(s.id);
        s.entry_id = e?.id || null;
        s.entry_number = e?.entry_number || null;
      }
      data.entry_details = await fetchEntryDetails(req.tenant_id, entryRows.map((e) => e.id));
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
