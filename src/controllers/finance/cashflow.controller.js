// backend/src/controllers/finance/cashflow.controller.js
// Flujo de Caja: NO es un modelo transaccional nuevo — es una vista que agrega
// los payment_history (abonos ya registrados) de Ventas, Compras y Gastos,
// más los Anticipos de Clientes (recibidos y devueltos, ver
// Anticipos-Clientes-Analisis-y-Plan.md §6). Esas son las fuentes donde el
// sistema hoy registra movimiento real de efectivo/dinero. Si en el futuro
// se agrega un módulo de caja/bancos con transacciones propias, este
// endpoint debería sumarlas aquí también en vez de reemplazarlas.
const { Sale, Purchase, Expense, Supplier, Tenant, WorkOrder, CustomerAdvance, Customer, OpeningBalance, CustomerReturn, SupplierReturn } = require('../../models');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');
const { generateCashFlowPDF } = require('../../services/pdfService');
const { generateCashFlowExcel } = require('../../services/excelService');
const { getAccountingCashFlow } = require('../../services/accounting/cashReconciliation.service');
const { resolveBranchFilter } = require('../../utils/branchFilter');
const { transferableAmount } = require('../../services/workshop/workOrderPayments.service');

// Tolerancia para considerar que Tesorería y Contabilidad "coinciden" —
// 1 peso de redondeo no es una alerta real.
const RECONCILIATION_TOLERANCE = 1;

const DEFAULT_TIMEZONE = 'America/Bogota';
const dateFormatters = new Map();
const localDateFormatter = (timeZone) => {
  if (!dateFormatters.has(timeZone)) {
    // en-CA formatea como YYYY-MM-DD.
    dateFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return dateFormatters.get(timeZone);
};

// Fecha (YYYY-MM-DD) en que ocurrió un movimiento, en la hora local del
// tenant. Antes los instantes se pasaban a fecha UTC: en Colombia (UTC-5)
// todo lo registrado después de las 7 p. m. caía al día siguiente y el cuadre
// de ese día no lo veía.
//  - 'YYYY-MM-DD' o fecha/hora sin zona: ya es fecha local, se toma tal cual.
//  - Instante (Date, o ISO con Z/offset): se convierte a la zona del tenant,
//    salvo medianoche UTC exacta: eso es una fecha sin hora que se guardó
//    como timestamp (new Date('YYYY-MM-DD')), y su fecha es la UTC.
// Columnas DATE/TIMESTAMPTZ llegan como objeto Date (p. ej. received_date del
// anticipo): String(date) daba "Fri Oct 09 ..." -> "Fri".
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}(:?\d{2})?)$/i;
const toDateOnly = (value, timeZone = DEFAULT_TIMEZONE) => {
  if (!value) return null;
  let date = value;
  if (!(value instanceof Date)) {
    const str = String(value).trim();
    if (!INSTANT_RE.test(str)) return str.split('T')[0].split(' ')[0];
    date = new Date(str);
  }
  if (isNaN(date.getTime())) return null;
  const isUtcMidnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  if (isUtcMidnight) return date.toISOString().slice(0, 10);
  return localDateFormatter(timeZone).format(date);
};

// 'YYYY-MM-DD' ± días (para ensanchar el prefiltro SQL). Si no es una fecha
// válida se devuelve igual: el filtro exacto de JS decide.
const shiftDate = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ── Prefiltro por fecha en SQL ───────────────────────────────────────────────
// Sin esto, cada cuadre de caja (un día, una sede) traía TODO el historial de
// pagos del tenant y filtraba en JS. Estas condiciones dejan pasar solo las
// filas con al menos un movimiento cerca del rango: la fecha guardada (o la
// fecha UTC del timestamp) puede diferir en un día de la fecha local que
// calcula toDateOnly, así que el rango se ensancha un día a cada lado. El
// filtro exacto por movimiento sigue siendo el de JS más abajo: esto solo
// descarta filas que de todos modos no aportarían nada.
const dateInRangeSql = (dateExpr, { from_date, to_date }) => [
  from_date ? `${dateExpr} >= ${sequelize.escape(String(from_date))}` : null,
  to_date ? `${dateExpr} <= ${sequelize.escape(String(to_date))}` : null,
].filter(Boolean).join(' AND ');

// Algún elemento de un historial JSONB (payment_history / refund_history) en el rango.
const historyInRangeSql = (alias, column, range) => `EXISTS (
  SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("${alias}"."${column}") = 'array' THEN "${alias}"."${column}" ELSE '[]'::jsonb END) AS h(e)
  WHERE ${dateInRangeSql(`split_part(split_part(h.e->>'date', 'T', 1), ' ', 1) COLLATE "C"`, range)})`;

// Columna timestamp en el rango (por su fecha UTC).
const columnInRangeSql = (alias, column, range) =>
  dateInRangeSql(`to_char("${alias}"."${column}" AT TIME ZONE 'UTC', 'YYYY-MM-DD') COLLATE "C"`, range);

const historyInRange = (alias, column, range) =>
  (range.from_date || range.to_date ? [sequelize.literal(historyInRangeSql(alias, column, range))] : []);

// Arma el objeto { summary, by_day, transactions } a partir de Ventas,
// Compras y Gastos. Usado tanto por el JSON de la pantalla como por el PDF,
// para que ambos siempre muestren exactamente los mismos números.
const buildCashFlow = async (tenant_id, { from_date, to_date, branch_id } = {}) => {
  const range = {
    from_date: from_date ? shiftDate(String(from_date), -1) : null,
    to_date: to_date ? shiftDate(String(to_date), 1) : null,
  };
  const filtered = Boolean(from_date || to_date);
  const [tenant, sales, purchases, expenses, pendingWorkOrders, advances, openingBalances, returnRefunds, supplierRefunds] = await Promise.all([
    Tenant.findByPk(tenant_id, { attributes: ['id', 'business_config'] }),
    Sale.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 }, [Op.and]: historyInRange('Sale', 'payment_history', range) },
      attributes: ['id', 'sale_number', 'customer_name', 'payment_history', 'branch_id']
    }),
    Purchase.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 }, [Op.and]: historyInRange('Purchase', 'payment_history', range) },
      include: [{ model: Supplier, as: 'supplier', attributes: ['name'] }],
      attributes: ['id', 'purchase_number', 'payment_history', 'branch_id']
    }),
    Expense.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 }, [Op.and]: historyInRange('Expense', 'payment_history', range) },
      attributes: ['id', 'expense_number', 'description', 'category', 'payment_history', 'branch_id']
    }),
    // Abonos cobrados en una OT ANTES de facturarla (sale_id null) — antes
    // eran invisibles para el cuadre de caja aunque fuera dinero real
    // recibido. Solo `sale_id: null`: una vez facturada, estos mismos abonos
    // se trasladan a Sale.payment_history (ver generateSale) y ya se cuentan
    // por ese lado — incluir ambos duplicaría el monto.
    WorkOrder.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 }, sale_id: null, [Op.and]: historyInRange('WorkOrder', 'payment_history', range) },
      attributes: ['id', 'order_number', 'payment_history'],
    }),
    // Anticipos de clientes: el ingreso de caja ocurre el día que se RECIBE
    // el anticipo, no el día que se aplica a una factura (ver
    // Anticipos-Clientes-Analisis-y-Plan.md §6). No se filtran por 'voided'
    // en SQL porque un anticipo anulado nunca movió caja real — se excluye
    // abajo junto con el resto del armado de transacciones.
    CustomerAdvance.findAll({
      // Entra si se recibió en el rango o si alguna devolución cae en él.
      where: {
        tenant_id,
        status: { [Op.ne]: 'voided' },
        ...(filtered && { [Op.and]: [sequelize.literal(`((${columnInRangeSql('CustomerAdvance', 'received_date', range)}) OR ${historyInRangeSql('CustomerAdvance', 'refund_history', range)})`)] }),
      },
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] }],
      attributes: ['id', 'advance_number', 'amount', 'received_date', 'method', 'branch_id', 'cash_session_id', 'refund_history', 'reassigned_from_id', 'customer_return_id'],
    }),
    // Abonos a saldos iniciales (Contabilidad → Saldos Iniciales): cobros de
    // cartera vieja (entrada) o pagos a proveedores (salida).
    OpeningBalance.findAll({
      where: { tenant_id, paid_amount: { [Op.gt]: 0 }, [Op.and]: historyInRange('OpeningBalance', 'payment_history', range) },
      include: [
        { model: Customer, as: 'customer', attributes: ['first_name', 'last_name', 'business_name'] },
        { model: Supplier, as: 'supplier', attributes: ['name'] },
      ],
      attributes: ['id', 'type', 'reference', 'branch_id', 'payment_history'],
    }),
    // Dinero devuelto al cliente por la parte ya pagada de una devolución
    // (settlement_type 'refund', ver approveCustomerReturn).
    // Una devolución reversada conserva su reintegro original (ya ocurrió) y
    // suma el movimiento inverso (reversal_*).
    CustomerReturn.findAll({
      where: {
        tenant_id, status: { [Op.in]: ['approved', 'reversed'] }, settlement_type: 'refund', refund_amount: { [Op.gt]: 0 },
        // Reintegro o su reversión dentro del rango.
        ...(filtered && { [Op.and]: [sequelize.literal(`((${columnInRangeSql('CustomerReturn', 'refund_date', range)}) OR (${columnInRangeSql('CustomerReturn', 'reversed_at', range)}))`)] }),
      },
      include: [{ model: Customer, as: 'customer', attributes: ['first_name', 'last_name', 'business_name'] }],
      attributes: ['id', 'return_number', 'refund_amount', 'refund_method', 'refund_date', 'refund_branch_id', 'refund_cash_session_id',
        'status', 'reversal_amount', 'reversal_method', 'reversed_at', 'reversal_branch_id', 'reversal_cash_session_id'],
    }),
    // Dinero que el proveedor reintegró por la parte ya pagada de una
    // devolución (settlement_type 'refund', ver approveSupplierReturn).
    SupplierReturn.findAll({
      where: {
        tenant_id, status: { [Op.in]: ['approved', 'reversed'] }, settlement_type: 'refund', refund_amount: { [Op.gt]: 0 },
        // Reintegro o su reversión dentro del rango.
        ...(filtered && { [Op.and]: [sequelize.literal(`((${columnInRangeSql('SupplierReturn', 'refund_date', range)}) OR (${columnInRangeSql('SupplierReturn', 'reversed_at', range)}))`)] }),
      },
      include: [{ model: Supplier, as: 'supplier', attributes: ['name'] }],
      attributes: ['id', 'return_number', 'refund_amount', 'refund_method', 'refund_date', 'refund_branch_id', 'refund_cash_session_id',
        'status', 'reversal_amount', 'reversal_method', 'reversed_at', 'reversal_branch_id', 'reversal_cash_session_id'],
    }),
  ]);

  const timeZone = tenant?.business_config?.timezone || DEFAULT_TIMEZONE;
  const dateOf = (value) => toDateOnly(value, timeZone);

  let transactions = [];

  sales.forEach(s => {
    // No son dinero que entre a caja ese día: las retenciones registradas en
    // cartera, ni la aplicación de un anticipo (su entrada ya se contó el día
    // en que se recibió, más abajo -- sumarla otra vez la duplicaba).
    (s.payment_history || []).filter(p => p.source !== 'retention' && p.source !== 'advance').forEach(p => {
      transactions.push({
        date: dateOf(p.date),
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
      // Lo que pasó a anticipo del cliente (excedente al facturar, OT
      // cancelada) ya se cuenta por el lado de anticipos, con la misma fecha.
      const amount = transferableAmount(p);
      if (amount <= 0) return;
      transactions.push({
        date: dateOf(p.date),
        amount,
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

  advances.forEach(a => {
    const customerName = a.customer
      ? (a.customer.business_name || `${a.customer.first_name || ''} ${a.customer.last_name || ''}`.trim())
      : 'Cliente';

    // Entrada: dinero que SÍ entró a caja/banco el día que se recibió el
    // anticipo. NO se vuelve a sumar el día que se aplica a una factura —
    // esa plata ya se contó aquí (ver §6 del análisis: sumarla otra vez
    // sería doble conteo).
    // Un anticipo nacido de una reasignación no es dinero nuevo: ya se contó
    // en el anticipo de origen. Tampoco el saldo a favor de una devolución
    // (customer_return_id): ese dinero entró con el pago de la venta.
    if (!a.reassigned_from_id && !a.customer_return_id) transactions.push({
      date: dateOf(a.received_date),
      amount: parseFloat(a.amount) || 0,
      direction: 'in',
      source: 'customer_advance',
      reference: a.advance_number,
      detail: `Anticipo de ${customerName}`,
      method: a.method || null,
      branch_id: a.branch_id,
      cash_session_id: a.cash_session_id || null,
    });

    // Salida: cada devolución de anticipo es un movimiento de caja de salida
    // en la fecha en que se devolvió, igual que un gasto.
    (a.refund_history || []).forEach(r => {
      transactions.push({
        date: dateOf(r.date),
        amount: parseFloat(r.amount) || 0,
        direction: 'out',
        source: 'customer_advance_refund',
        reference: a.advance_number,
        detail: `Devolución de anticipo a ${customerName}`,
        method: r.method || a.method || null,
        branch_id: r.branch_id || a.branch_id,
        cash_session_id: r.cash_session_id || null,
      });
    });
  });

  openingBalances.forEach(ob => {
    const isReceivable = ob.type === 'receivable';
    const party = isReceivable
      ? (ob.customer?.business_name || `${ob.customer?.first_name || ''} ${ob.customer?.last_name || ''}`.trim() || 'Cliente')
      : (ob.supplier?.name || 'Proveedor');
    (ob.payment_history || []).forEach(pay => {
      transactions.push({
        date: dateOf(pay.date),
        amount: parseFloat(pay.amount) || 0,
        direction: isReceivable ? 'in' : 'out',
        source: isReceivable ? 'opening_receivable' : 'opening_payable',
        reference: ob.reference || 'Saldo inicial',
        detail: party,
        method: pay.method || null,
        branch_id: pay.branch_id || ob.branch_id,
        cash_session_id: pay.cash_session_id || null,
      });
    });
  });

  returnRefunds.forEach(r => {
    const customerName = r.customer
      ? (r.customer.business_name || `${r.customer.first_name || ''} ${r.customer.last_name || ''}`.trim())
      : 'Cliente';
    transactions.push({
      date: dateOf(r.refund_date),
      amount: parseFloat(r.refund_amount) || 0,
      direction: 'out',
      source: 'customer_return_refund',
      reference: r.return_number,
      detail: `Reintegro por devolución a ${customerName}`,
      method: r.refund_method || null,
      branch_id: r.refund_branch_id,
      cash_session_id: r.refund_cash_session_id || null,
    });
    if (r.status === 'reversed' && Number(r.reversal_amount) > 0) {
      transactions.push({
        date: dateOf(r.reversed_at),
        amount: parseFloat(r.reversal_amount) || 0,
        direction: 'in',
        source: 'customer_return_reversal',
        reference: r.return_number,
        detail: `Reversión de devolución: ${customerName} reintegra el dinero`,
        method: r.reversal_method || null,
        branch_id: r.reversal_branch_id,
        cash_session_id: r.reversal_cash_session_id || null,
      });
    }
  });

  supplierRefunds.forEach(r => {
    transactions.push({
      date: dateOf(r.refund_date),
      amount: parseFloat(r.refund_amount) || 0,
      direction: 'in',
      source: 'supplier_return_refund',
      reference: r.return_number,
      detail: `Reintegro de ${r.supplier?.name || 'proveedor'} por devolución`,
      method: r.refund_method || null,
      branch_id: r.refund_branch_id,
      cash_session_id: r.refund_cash_session_id || null,
    });
    if (r.status === 'reversed' && Number(r.reversal_amount) > 0) {
      transactions.push({
        date: dateOf(r.reversed_at),
        amount: parseFloat(r.reversal_amount) || 0,
        direction: 'out',
        source: 'supplier_return_reversal',
        reference: r.return_number,
        detail: `Reversión de devolución: se le devuelve el reintegro a ${r.supplier?.name || 'proveedor'}`,
        method: r.reversal_method || null,
        branch_id: r.reversal_branch_id,
        cash_session_id: r.reversal_cash_session_id || null,
      });
    }
  });

  purchases.forEach(p => {
    // Saldo a favor de una devolución aplicado a la compra: no es dinero
    // que salga (ver supplierReturns.controller.js#applySupplierCredit).
    (p.payment_history || []).filter(pay => pay.source !== 'supplier_credit').forEach(pay => {
      transactions.push({
        date: dateOf(pay.date),
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
        date: dateOf(pay.date),
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
    const { from_date, to_date } = req.query;
    const branch_id = resolveBranchFilter(req);

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
    const { from_date, to_date } = req.query;
    const branch_id = resolveBranchFilter(req);

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
    const { from_date, to_date } = req.query;
    const branch_id = resolveBranchFilter(req);

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
    const { from_date, to_date } = req.query;
    const branch_id = resolveBranchFilter(req);

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

module.exports = { getCashFlow, getCashFlowPDF, getCashFlowExcel, getCashFlowReconciliation, buildCashFlow, toDateOnly, shiftDate };