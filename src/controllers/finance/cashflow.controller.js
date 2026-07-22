// backend/src/controllers/finance/cashflow.controller.js
// Flujo de Caja: NO es un modelo transaccional nuevo — es una vista que agrega
// los payment_history (abonos ya registrados) de Ventas, Compras y Gastos.
// Esas tres fuentes son los únicos puntos donde el sistema hoy registra
// movimiento real de efectivo/dinero. Si en el futuro se agrega un módulo de
// caja/bancos con transacciones propias, este endpoint debería sumarlas aquí
// también en vez de reemplazarlas.
const { Sale, Purchase, Expense, Supplier, Tenant, WorkOrder } = require('../../models');
const { Op } = require('sequelize');
const { generateCashFlowPDF } = require('../../services/pdfService');
const { generateCashFlowExcel } = require('../../services/excelService');
const { getAccountingCashFlow } = require('../../services/accounting/cashReconciliation.service');

// Tolerancia para considerar que Tesorería y Contabilidad "coinciden" —
// 1 peso de redondeo no es una alerta real.
const RECONCILIATION_TOLERANCE = 1;

const toDateOnly = (value) => {
  if (!value) return null;
  return String(value).split('T')[0].split(' ')[0];
};

// Arma el objeto { summary, by_day, transactions } a partir de Ventas,
// Compras y Gastos. Usado tanto por el JSON de la pantalla como por el PDF,
// para que ambos siempre muestren exactamente los mismos números.
const buildCashFlow = async (tenant_id, { from_date, to_date, branch_id } = {}) => {
  const [sales, purchases, expenses, pendingWorkOrders] = await Promise.all([
    Sale.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 } },
      attributes: ['id', 'sale_number', 'customer_name', 'payment_history', 'branch_id']
    }),
    Purchase.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 } },
      include: [{ model: Supplier, as: 'supplier', attributes: ['name'] }],
      attributes: ['id', 'purchase_number', 'payment_history', 'branch_id']
    }),
    Expense.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 } },
      attributes: ['id', 'expense_number', 'description', 'category', 'payment_history', 'branch_id']
    }),
    // Abonos cobrados en una OT ANTES de facturarla (sale_id null) — antes
    // eran invisibles para el cuadre de caja aunque fuera dinero real
    // recibido. Solo `sale_id: null`: una vez facturada, estos mismos abonos
    // se trasladan a Sale.payment_history (ver generateSale) y ya se cuentan
    // por ese lado — incluir ambos duplicaría el monto.
    WorkOrder.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 }, sale_id: null },
      attributes: ['id', 'order_number', 'payment_history'],
    }),
  ]);

  let transactions = [];

  sales.forEach(s => {
    (s.payment_history || []).forEach(p => {
      transactions.push({
        date: toDateOnly(p.date),
        amount: parseFloat(p.amount) || 0,
        direction: 'in',
        source: 'sale',
        reference: s.sale_number,
        detail: s.customer_name,
        method: p.method || null,
        branch_id: p.branch_id || s.branch_id,
        cash_session_id: p.cash_session_id || null,
      });
    });
  });

  pendingWorkOrders.forEach(w => {
    (w.payment_history || []).forEach(p => {
      transactions.push({
        date: toDateOnly(p.date),
        amount: parseFloat(p.amount) || 0,
        direction: 'in',
        source: 'work_order',
        reference: w.order_number,
        detail: 'Abono a OT (sin facturar aún)',
        method: p.method || null,
        // WorkOrder no tiene sede propia — la única fuente de sede es la
        // que quedó guardada en el propio pago (ver registerPayment).
        branch_id: p.branch_id || null,
        cash_session_id: p.cash_session_id || null,
      });
    });
  });

  purchases.forEach(p => {
    (p.payment_history || []).forEach(pay => {
      transactions.push({
        date: toDateOnly(pay.date),
        amount: parseFloat(pay.amount) || 0,
        direction: 'out',
        source: 'purchase',
        reference: p.purchase_number,
        detail: p.supplier?.name || 'Proveedor',
        method: pay.method || null,
        branch_id: p.branch_id
      });
    });
  });

  expenses.forEach(e => {
    (e.payment_history || []).forEach(pay => {
      transactions.push({
        date: toDateOnly(pay.date),
        amount: parseFloat(pay.amount) || 0,
        direction: 'out',
        source: 'expense',
        reference: e.expense_number,
        detail: e.description,
        category: e.category,
        method: pay.method || null,
        branch_id: e.branch_id
      });
    });
  });

  // Filtros de fecha / sede sobre los movimientos ya aplanados
  if (from_date) transactions = transactions.filter(t => t.date && t.date >= from_date);
  if (to_date) transactions = transactions.filter(t => t.date && t.date <= to_date);
  if (branch_id) transactions = transactions.filter(t => t.branch_id === branch_id);

  let totalIn = 0, totalOut = 0;
  const byDayMap = {};

  transactions.forEach(t => {
    if (t.direction === 'in') totalIn += t.amount;
    else totalOut += t.amount;

    const day = t.date || 'sin_fecha';
    if (!byDayMap[day]) byDayMap[day] = { date: day, in: 0, out: 0, net: 0 };
    if (t.direction === 'in') byDayMap[day].in += t.amount;
    else byDayMap[day].out += t.amount;
    byDayMap[day].net = byDayMap[day].in - byDayMap[day].out;
  });

  const byDay = Object.values(byDayMap).sort((a, b) => a.date.localeCompare(b.date));

  const sortedTransactions = [...transactions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return {
    summary: {
      total_in: totalIn,
      total_out: totalOut,
      net: totalIn - totalOut,
      total_transactions: transactions.length
    },
    by_day: byDay,
    transactions: sortedTransactions,
    allTransactions: transactions // sin recortar — lo usa el PDF
  };
};

const getCashFlow = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { from_date, to_date, branch_id } = req.query;

    const cashFlow = await buildCashFlow(tenant_id, { from_date, to_date, branch_id });

    res.json({
      success: true,
      data: {
        summary: cashFlow.summary,
        by_day: cashFlow.by_day,
        transactions: cashFlow.transactions.slice(0, 100)
      }
    });
  } catch (error) {
    console.error('Error obteniendo flujo de caja:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo flujo de caja' });
  }
};

// Cuadre de caja en PDF — mismos filtros que la pantalla, pero con TODOS
// los movimientos del periodo (no solo los 100 más recientes).
const getCashFlowPDF = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { from_date, to_date, branch_id } = req.query;

    const [tenant, cashFlow] = await Promise.all([
      Tenant.findByPk(tenant_id),
      buildCashFlow(tenant_id, { from_date, to_date, branch_id })
    ]);

    const generatedByName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email;

    await generateCashFlowPDF(
      res,
      { summary: cashFlow.summary, by_day: cashFlow.by_day, transactions: cashFlow.allTransactions },
      tenant,
      { from_date, to_date },
      generatedByName
    );
  } catch (error) {
    console.error('Error generando PDF de cuadre de caja:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error generando PDF de cuadre de caja' });
  }
};

// Cuadre de caja en Excel — mismos filtros y misma fuente de datos que el PDF.
const getCashFlowExcel = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { from_date, to_date, branch_id } = req.query;

    const [tenant, cashFlow] = await Promise.all([
      Tenant.findByPk(tenant_id),
      buildCashFlow(tenant_id, { from_date, to_date, branch_id })
    ]);

    const generatedByName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email;

    const buffer = await generateCashFlowExcel(
      { summary: cashFlow.summary, by_day: cashFlow.by_day, transactions: cashFlow.allTransactions },
      tenant,
      { from_date, to_date },
      generatedByName
    );

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Cuadre-de-Caja-${from_date || ''}_${to_date || ''}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Error generando Excel de cuadre de caja:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error generando Excel de cuadre de caja' });
  }
};

// GET /api/cashflow/reconciliation
// Conecta la vista de Tesorería (payment_history) con la vista de
// Contabilidad (asientos posteados en Caja/Bancos) para el hallazgo 3.5:
// hoy son dos fuentes de verdad separadas y nada avisa si divergen. Este
// endpoint las calcula juntas, con los mismos filtros, y expone si
// coinciden o no — total y día por día — en vez de dejarlo para una
// auditoría manual.
const getCashFlowReconciliation = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { from_date, to_date, branch_id } = req.query;

    const [treasury, accounting] = await Promise.all([
      buildCashFlow(tenant_id, { from_date, to_date, branch_id }),
      getAccountingCashFlow(tenant_id, { from_date, to_date, branch_id }),
    ]);

    const diff_in = Math.round((treasury.summary.total_in - accounting.summary.total_in) * 100) / 100;
    const diff_out = Math.round((treasury.summary.total_out - accounting.summary.total_out) * 100) / 100;
    const diff_net = Math.round((treasury.summary.net - accounting.summary.net) * 100) / 100;
    const matches = Math.abs(diff_in) <= RECONCILIATION_TOLERANCE && Math.abs(diff_out) <= RECONCILIATION_TOLERANCE;

    // Une los días de ambas vistas (aunque uno de los dos no tenga movimiento
    // ese día) para poder señalar EN QUÉ día específico aparece la diferencia,
    // no solo el total del rango.
    const dayMap = {};
    treasury.by_day.forEach((d) => {
      dayMap[d.date] = { date: d.date, treasury_in: d.in, treasury_out: d.out, accounting_in: 0, accounting_out: 0 };
    });
    accounting.by_day.forEach((d) => {
      if (!dayMap[d.date]) dayMap[d.date] = { date: d.date, treasury_in: 0, treasury_out: 0, accounting_in: 0, accounting_out: 0 };
      dayMap[d.date].accounting_in = d.in;
      dayMap[d.date].accounting_out = d.out;
    });

    const by_day = Object.values(dayMap)
      .map((d) => ({
        ...d,
        diff_in: Math.round((d.treasury_in - d.accounting_in) * 100) / 100,
        diff_out: Math.round((d.treasury_out - d.accounting_out) * 100) / 100,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((d) => Math.abs(d.diff_in) > RECONCILIATION_TOLERANCE || Math.abs(d.diff_out) > RECONCILIATION_TOLERANCE);

    res.json({
      success: true,
      data: {
        treasury: treasury.summary,
        accounting: accounting.summary,
        pending_draft: accounting.pending_draft,
        accounts_used: accounting.accounts_used,
        difference: { in: diff_in, out: diff_out, net: diff_net },
        matches,
        days_with_difference: by_day,
      },
    });
  } catch (error) {
    console.error('Error generando conciliación de flujo de caja:', error);
    res.status(500).json({ success: false, message: 'Error generando conciliación de flujo de caja' });
  }
};

module.exports = { getCashFlow, getCashFlowPDF, getCashFlowExcel, getCashFlowReconciliation, buildCashFlow };