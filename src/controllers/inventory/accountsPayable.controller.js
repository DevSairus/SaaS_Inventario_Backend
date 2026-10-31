// backend/src/controllers/inventory/accountsPayable.controller.js
const { Purchase, Supplier } = require('../../models/inventory');
const { User } = require('../../models');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');
const { resolveBranchFilter } = require('../../utils/branchFilter');
const { markPurchaseForAlertCheck } = require('../../middleware/autoCheckPayableAlerts.middleware');
const { purchaseNetPayable, purchaseBalance, purchasePaymentStatus, payablePurchaseWhere, round2, purchaseDaysOverdue, purchaseEffectiveDueDate, DEFAULT_PAYABLE_TERM_DAYS } = require('../../utils/purchaseAmounts');
const { parsePagination, buildPagination } = require('../../utils/pagination');

// Obtener resumen de cuentas por pagar
// Saldo a favor con proveedores que quedó sin aplicar al aprobar una
// devolución (no había compras pendientes): se muestra en Cuentas por Pagar
// para aplicarlo (POST /inventory/supplier-returns/:id/apply-credit).
const availableSupplierCredits = async (tenantId) => {
  const { SupplierReturn, Supplier: SupplierModel } = require('../../models');
  const rows = await SupplierReturn.findAll({
    where: {
      tenant_id: tenantId,
      status: 'approved',
      settlement_type: 'credit',
      credit_amount: { [Op.gt]: sequelize.col('credit_applied_amount') },
    },
    include: [{ model: SupplierModel, as: 'supplier', attributes: ['id', 'name'] }],
    attributes: ['id', 'return_number', 'supplier_id', 'credit_amount', 'credit_applied_amount'],
    order: [['approved_at', 'ASC']],
  });
  return rows.map((r) => ({
    supplier_return_id: r.id,
    return_number: r.return_number,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier?.name || 'Proveedor',
    available: round2(Number(r.credit_amount || 0) - Number(r.credit_applied_amount || 0)),
  }));
};

// Filtro de las compras con saldo pendiente (obligaciones reales, sin
// pagar del todo). supplier_id='none' = compras sin proveedor. search
// busca en número de compra, factura del proveedor y nombre del proveedor.
const pendingPayablesWhere = (req) => {
  const tenantId = req.user.tenant_id;
  const { from_date, to_date, supplier_id, search } = req.query;

  const where = {
    tenant_id: tenantId,
    // Solo obligaciones reales: mercancía recibida, o factura del proveedor
    // registrada. Una orden confirmada sin nada de eso es solo un pedido.
    ...payablePurchaseWhere(),
    payment_status: { [Op.in]: ['pending', 'partial'] }
  };

  if (supplier_id) where.supplier_id = supplier_id === 'none' ? null : supplier_id;

  // Para roles no-admin, se ignora el branch_id de query y se fuerza la
  // sede autorizada del usuario.
  const branch_id = resolveBranchFilter(req);
  if (branch_id) where.branch_id = branch_id;

  if (from_date && to_date) {
    where.purchase_date = { [Op.between]: [from_date, to_date] };
  } else if (from_date) {
    where.purchase_date = { [Op.gte]: from_date };
  } else if (to_date) {
    where.purchase_date = { [Op.lte]: to_date };
  }

  const term = String(search || '').trim();
  if (term) {
    where[Op.and] = [...(where[Op.and] || []), { [Op.or]: [
      { purchase_number: { [Op.iLike]: `%${term}%` } },
      { invoice_number: { [Op.iLike]: `%${term}%` } },
      { '$supplier.name$': { [Op.iLike]: `%${term}%` } },
    ] }];
  }
  return where;
};

// Mismas reglas que purchaseBalance / purchaseEffectiveDueDate /
// purchaseDaysOverdue (utils/purchaseAmounts.js), en SQL para sumar sin
// traer las compras a memoria.
const BALANCE_SQL = `GREATEST(GREATEST("Purchase"."total_amount" - COALESCE("Purchase"."total_retentions", 0), 0) - COALESCE("Purchase"."paid_amount", 0) - COALESCE("Purchase"."returned_amount", 0), 0)`;
const OVERDUE_SQL = `(COALESCE("Purchase"."due_date", "Purchase"."purchase_date" + ${DEFAULT_PAYABLE_TERM_DAYS}) < CURRENT_DATE)`;

const PAYABLE_ATTRIBUTES = [
  'id', 'purchase_number', 'purchase_date', 'due_date', 'supplier_id',
  'total_amount', 'total_retentions', 'paid_amount', 'returned_amount', 'payment_status', 'payment_method',
  'payment_history', 'invoice_number', 'status'
];
const SUPPLIER_INCLUDE = { model: Supplier, as: 'supplier', attributes: ['id', 'name', 'tax_id', 'email', 'phone'] };

// Fila de cuentas por pagar con saldo, vencimiento y días vencidos.
const toPayableRow = (purchase, today = new Date()) => {
  const balance = purchaseBalance(purchase); // neto de retenciones
  // due_date o, si falta, compra + 30 días (misma regla que las alertas).
  const daysOverdue = purchaseDaysOverdue(purchase, today);
  return {
    id: purchase.id,
    purchase_number: purchase.purchase_number,
    purchase_date: purchase.purchase_date,
    due_date: purchase.due_date,
    // Vencimiento usado para el cálculo (due_date o compra + 30 días).
    effective_due_date: purchaseEffectiveDueDate(purchase),
    invoice_number: purchase.invoice_number,
    supplier_id: purchase.supplier_id,
    supplier: purchase.supplier,
    supplier_name: purchase.supplier?.name || 'Sin proveedor',
    total_amount: parseFloat(purchase.total_amount),
    total_retentions: parseFloat(purchase.total_retentions || 0),
    net_payable: purchaseNetPayable(purchase),
    paid_amount: parseFloat(purchase.paid_amount || 0),
    balance,
    payment_status: purchase.payment_status,
    payment_method: purchase.payment_method,
    days_overdue: Math.max(daysOverdue, 0),
    is_overdue: daysOverdue > 0,
    payment_history: purchase.payment_history || [],
    status: purchase.status
  };
};

// Totales y agrupación por proveedor, sumados en la base (antes se traían
// todas las compras abiertas y se sumaban en JS).
const payableTotalsBySupplier = async (req) => {
  const groups = await Purchase.findAll({
    where: pendingPayablesWhere(req),
    include: [{ ...SUPPLIER_INCLUDE, attributes: [] }],
    attributes: [
      'supplier_id',
      [sequelize.fn('COUNT', sequelize.col('Purchase.id')), 'purchase_count'],
      [sequelize.fn('SUM', sequelize.col('Purchase.total_amount')), 'total_amount'],
      [sequelize.fn('SUM', sequelize.fn('COALESCE', sequelize.col('Purchase.paid_amount'), 0)), 'paid_amount'],
      [sequelize.literal(`SUM(${BALANCE_SQL})`), 'balance'],
      [sequelize.literal(`SUM(CASE WHEN ${OVERDUE_SQL} THEN ${BALANCE_SQL} ELSE 0 END)`), 'overdue_amount'],
      [sequelize.fn('MIN', sequelize.col('Purchase.purchase_date')), 'first_date'],
    ],
    group: ['Purchase.supplier_id'],
    order: [[sequelize.literal('first_date'), 'ASC']],
    raw: true,
  });

  const supplierIds = groups.map(g => g.supplier_id).filter(Boolean);
  const suppliers = supplierIds.length
    ? await Supplier.findAll({ where: { id: supplierIds }, attributes: SUPPLIER_INCLUDE.attributes })
    : [];
  const supplierById = new Map(suppliers.map(sp => [sp.id, sp]));

  let totalPayable = 0;
  let totalOverdue = 0;
  let totalPurchases = 0;
  const bySupplier = groups.map(g => {
    const supplier = g.supplier_id ? supplierById.get(g.supplier_id) || null : null;
    const row = {
      supplier_id: g.supplier_id,
      supplier_name: supplier?.name || 'Sin proveedor',
      supplier,
      purchase_count: Number(g.purchase_count) || 0,
      total_amount: round2(Number(g.total_amount) || 0),
      paid_amount: round2(Number(g.paid_amount) || 0),
      balance: round2(Number(g.balance) || 0),
      overdue_amount: round2(Number(g.overdue_amount) || 0),
    };
    totalPayable += row.balance;
    totalOverdue += row.overdue_amount;
    totalPurchases += row.purchase_count;
    return row;
  });

  return {
    summary: {
      total_payable: round2(totalPayable),
      total_overdue: round2(totalOverdue),
      total_purchases: totalPurchases,
      total_suppliers: bySupplier.length
    },
    by_supplier: bySupplier,
  };
};

// GET /accounts-payable/summary?from_date=&to_date=&supplier_id=&lite=
// lite=true: solo totales y agrupación por proveedor, sin las compras (que
// se piden paginadas a /accounts-payable/documents). Sin lite se mantiene la
// respuesta completa de antes (compras anidadas + all_purchases).
const getAccountsPayableSummary = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const lite = req.query.lite === 'true';
    const { summary, by_supplier } = await payableTotalsBySupplier(req);

    let full = {};
    if (!lite) {
      const purchases = await Purchase.findAll({
        where: pendingPayablesWhere(req),
        include: [SUPPLIER_INCLUDE],
        order: [['purchase_date', 'ASC'], ['id', 'ASC']],
        attributes: PAYABLE_ATTRIBUTES,
      });
      const today = new Date();
      const allPurchases = purchases.map(p => toPayableRow(p, today));
      const keyOf = (id) => id || 'sin_proveedor';
      const nested = {};
      allPurchases.forEach(p => { (nested[keyOf(p.supplier_id)] ||= []).push(p); });
      full = {
        by_supplier: by_supplier.map(sp => ({ ...sp, purchases: nested[keyOf(sp.supplier_id)] || [] })),
        all_purchases: allPurchases,
      };
    }

    res.json({
      success: true,
      data: {
        summary,
        by_supplier,
        ...full,
        supplier_credits: await availableSupplierCredits(tenantId)
      }
    });
  } catch (error) {
    console.error('Error obteniendo cuentas por pagar:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo cuentas por pagar' });
  }
};

// GET /accounts-payable/documents?page=&limit=&search=&supplier_id=&from_date=&to_date=
// Compras con saldo pendiente, paginadas en la base (mismo orden que /summary).
const listPayableDocuments = async (req, res) => {
  try {
    const pg = parsePagination(req.query);
    const { rows, count } = await Purchase.findAndCountAll({
      where: pendingPayablesWhere(req),
      include: [SUPPLIER_INCLUDE],
      order: [['purchase_date', 'ASC'], ['id', 'ASC']],
      attributes: PAYABLE_ATTRIBUTES,
      limit: pg.limit,
      offset: pg.offset,
      subQuery: false,
    });
    const today = new Date();
    res.json({ success: true, data: rows.map(p => toPayableRow(p, today)), pagination: buildPagination(pg, count) });
  } catch (error) {
    console.error('Error listando cuentas por pagar:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo cuentas por pagar' });
  }
};

// Obtener cuentas por pagar de un proveedor específico
const getSupplierAccountsPayable = async (req, res) => {
  try {
    const { supplierId } = req.params;
    const tenantId = req.user.tenant_id;

    const supplier = await Supplier.findOne({ where: { id: supplierId, tenant_id: tenantId } });
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
    }

    const purchases = await Purchase.findAll({
      where: {
        tenant_id: tenantId,
        supplier_id: supplierId,
        ...payablePurchaseWhere(),
        payment_status: { [Op.in]: ['pending', 'partial'] }
      },
      order: [['purchase_date', 'DESC']]
    });

    let totalBalance = 0;
    let totalOverdue = 0;
    const today = new Date();

    const purchasesWithDetails = purchases.map(purchase => {
      const balance = purchaseBalance(purchase); // neto de retenciones
      const daysOverdue = purchaseDaysOverdue(purchase, today);
      const isOverdue = daysOverdue > 0;

      totalBalance += balance;
      if (isOverdue) totalOverdue += balance;

      return {
        ...purchase.toJSON(),
        balance,
        effective_due_date: purchaseEffectiveDueDate(purchase),
        days_overdue: Math.max(daysOverdue, 0),
        is_overdue: isOverdue
      };
    });

    res.json({
      success: true,
      data: {
        supplier: {
          id: supplier.id,
          name: supplier.name,
          tax_id: supplier.tax_id,
          email: supplier.email,
          phone: supplier.phone
        },
        summary: {
          total_balance: totalBalance,
          total_overdue: totalOverdue,
          total_purchases: purchases.length
        },
        purchases: purchasesWithDetails
      }
    });
  } catch (error) {
    console.error('Error obteniendo cuentas por pagar del proveedor:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo cuentas por pagar del proveedor' });
  }
};

// Historial de pagos de una compra
const getPaymentHistory = async (req, res) => {
  try {
    const { purchaseId } = req.params;
    const tenantId = req.user.tenant_id;

    const purchase = await Purchase.findOne({
      where: { id: purchaseId, tenant_id: tenantId },
      include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'email', 'phone'] }]
    });

    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    const balance = purchaseBalance(purchase); // neto de retenciones
    const paymentHistory = purchase.payment_history || [];

    const userIds = [...new Set(paymentHistory.map(p => p.user_id).filter(Boolean))];
    const users = userIds.length > 0
      ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'first_name', 'last_name'] })
      : [];
    const usersMap = Object.fromEntries(users.map(u => [u.id, u]));

    const enrichedHistory = paymentHistory.map((payment) => {
      const user = payment.user_id ? usersMap[payment.user_id] : null;
      const userName = user ? `${user.first_name} ${user.last_name}`.trim() : 'Usuario desconocido';
      return { ...payment, user_name: userName };
    });

    res.json({
      success: true,
      data: {
        purchase: {
          id: purchase.id,
          purchase_number: purchase.purchase_number,
          purchase_date: purchase.purchase_date,
          supplier: purchase.supplier,
          total_amount: parseFloat(purchase.total_amount),
          total_retentions: parseFloat(purchase.total_retentions || 0),
          net_payable: purchaseNetPayable(purchase),
          paid_amount: parseFloat(purchase.paid_amount || 0),
          balance,
          payment_status: purchase.payment_status
        },
        payment_history: enrichedHistory
      }
    });
  } catch (error) {
    console.error('Error obteniendo historial de pagos:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo historial de pagos' });
  }
};

// Reporte de antigüedad de saldos por pagar
const getAgingReport = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    const purchases = await Purchase.findAll({
      where: {
        tenant_id: tenantId,
        ...payablePurchaseWhere(),
        payment_status: { [Op.in]: ['pending', 'partial'] }
      },
      include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'email', 'phone'] }],
      order: [['purchase_date', 'ASC']]
    });

    const today = new Date();
    const aging = { current: [], days_31_60: [], days_61_90: [], over_90: [] };
    const totals = { current: 0, days_31_60: 0, days_61_90: 0, over_90: 0, total: 0 };

    purchases.forEach(purchase => {
      const balance = purchaseBalance(purchase); // neto de retenciones
      const daysOverdue = Math.max(purchaseDaysOverdue(purchase, today), 0);

      const purchaseData = {
        id: purchase.id,
        purchase_number: purchase.purchase_number,
        purchase_date: purchase.purchase_date,
        supplier_id: purchase.supplier_id,
        supplier: purchase.supplier,
        total_amount: parseFloat(purchase.total_amount),
        total_retentions: parseFloat(purchase.total_retentions || 0),
        net_payable: purchaseNetPayable(purchase),
        paid_amount: parseFloat(purchase.paid_amount || 0),
        balance,
        days_overdue: daysOverdue
      };

      totals.total += balance;

      if (daysOverdue <= 30) { aging.current.push(purchaseData); totals.current += balance; }
      else if (daysOverdue <= 60) { aging.days_31_60.push(purchaseData); totals.days_31_60 += balance; }
      else if (daysOverdue <= 90) { aging.days_61_90.push(purchaseData); totals.days_61_90 += balance; }
      else { aging.over_90.push(purchaseData); totals.over_90 += balance; }
    });

    res.json({ success: true, data: { aging, totals, total_purchases: purchases.length } });
  } catch (error) {
    console.error('Error obteniendo reporte de antigüedad:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo reporte de antigüedad' });
  }
};

// Registrar un abono a proveedor sobre una compra
const registerPayment = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenantId = req.user.tenant_id;
    const userId = req.user.id;
    const { amount, payment_method, payment_date, notes, bank_account_id } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    // SELECT FOR UPDATE: evita que dos pagos concurrentes lean el mismo paid_amount
    const purchase = await Purchase.findOne({
      where: { id, tenant_id: tenantId },
      lock: transaction.LOCK.UPDATE,
      transaction
    });
    if (!purchase) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }
    if (purchase.status === 'draft' || purchase.status === 'cancelled') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se puede registrar un pago en una compra en borrador o cancelada' });
    }

    // Lo que se le debe al proveedor es el neto de retenciones (ver
    // utils/purchaseAmounts.js); antes se usaba total_amount.
    const alreadyPaid = parseFloat(purchase.paid_amount || 0);
    const remaining = purchaseBalance(purchase);

    if (remaining <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta compra ya está pagada en su totalidad' });
    }

    const effectiveAmount = round2(Math.min(parseFloat(amount), remaining));
    const paid_amount = round2(alreadyPaid + effectiveAmount);
    const payment_status = purchasePaymentStatus(purchase, paid_amount);

    const payment = {
      id: require('crypto').randomUUID(),
      date: payment_date || new Date(),
      amount: effectiveAmount,
      method: payment_method || purchase.payment_method || 'Efectivo',
      bank_account_id: bank_account_id || null,
      user_id: userId,
      notes: notes || null,
      journal_entry_id: null,
    };
    const payment_history = [...(purchase.payment_history || []), payment];

    await purchase.update(
      { paid_amount, payment_status, payment_method: payment_method || purchase.payment_method, payment_history },
      { transaction }
    );

    await transaction.commit();

    // Asiento del pago (débito proveedores / crédito caja-bancos). No
    // bloqueante: si falla (ej. falta un mapeo), el pago queda registrado y
    // el asiento se puede generar después; se loguea.
    try {
      const { recordPurchasePaymentEntries } = require('../../services/inventory/purchasePayments.service');
      await recordPurchasePaymentEntries(purchase.id, tenantId, userId);
    } catch (e) {
      require('../../config/logger').warn(`[accounting] Asiento de pago a proveedor (compra ${id}): ${e.message}`);
    }

    // 🔔 Verificación automática de alertas de cuentas por pagar
    markPurchaseForAlertCheck(res, id, tenantId);

    const updatedPurchase = await Purchase.findByPk(id, {
      include: [{ model: Supplier, as: 'supplier' }]
    });

    res.json({ success: true, message: 'Pago registrado exitosamente', data: updatedPurchase });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    console.error('Error registrando pago a proveedor:', error);
    res.status(500).json({ success: false, message: 'Error registrando el pago' });
  }
};

module.exports = {
  getAccountsPayableSummary,
  listPayableDocuments,
  getSupplierAccountsPayable,
  getPaymentHistory,
  getAgingReport,
  registerPayment
};