// backend/src/controllers/inventory/accountsPayable.controller.js
const { Purchase, Supplier } = require('../../models/inventory');
const { User } = require('../../models');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');
const { resolveBranchFilter } = require('../../utils/branchFilter');

// Obtener resumen de cuentas por pagar
const getAccountsPayableSummary = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { from_date, to_date, supplier_id } = req.query;

    const where = {
      tenant_id: tenantId,
      status: { [Op.in]: ['confirmed', 'received'] }, // solo compras ya formalizadas
      payment_status: { [Op.in]: ['pending', 'partial'] }
    };

    if (supplier_id) where.supplier_id = supplier_id;

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

    const pendingPurchases = await Purchase.findAll({
      where,
      include: [
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'tax_id', 'email', 'phone']
        }
      ],
      order: [['purchase_date', 'ASC']],
      attributes: [
        'id', 'purchase_number', 'purchase_date', 'due_date', 'supplier_id',
        'total_amount', 'paid_amount', 'payment_status', 'payment_method',
        'payment_history', 'invoice_number', 'status'
      ]
    });

    let totalPayable = 0;
    let totalOverdue = 0;
    const today = new Date();

    const purchasesWithDetails = pendingPurchases.map(purchase => {
      const balance = parseFloat(purchase.total_amount) - parseFloat(purchase.paid_amount || 0);
      // Si hay due_date se usa esa fecha para vencimiento; si no, se cae al
      // mismo criterio de 30 días desde la compra que usa Cartera.
      const referenceDate = purchase.due_date ? new Date(purchase.due_date) : new Date(purchase.purchase_date);
      const daysOverdue = purchase.due_date
        ? Math.floor((today - referenceDate) / (1000 * 60 * 60 * 24))
        : Math.floor((today - referenceDate) / (1000 * 60 * 60 * 24)) - 30;
      const isOverdue = daysOverdue > 0;

      totalPayable += balance;
      if (isOverdue) totalOverdue += balance;

      return {
        id: purchase.id,
        purchase_number: purchase.purchase_number,
        purchase_date: purchase.purchase_date,
        due_date: purchase.due_date,
        invoice_number: purchase.invoice_number,
        supplier_id: purchase.supplier_id,
        supplier: purchase.supplier,
        supplier_name: purchase.supplier?.name || 'Sin proveedor',
        total_amount: parseFloat(purchase.total_amount),
        paid_amount: parseFloat(purchase.paid_amount || 0),
        balance,
        payment_status: purchase.payment_status,
        payment_method: purchase.payment_method,
        days_overdue: Math.max(daysOverdue, 0),
        is_overdue: isOverdue,
        payment_history: purchase.payment_history || [],
        status: purchase.status
      };
    });

    const bySupplier = {};
    purchasesWithDetails.forEach(purchase => {
      const supplierId = purchase.supplier_id || 'sin_proveedor';
      if (!bySupplier[supplierId]) {
        bySupplier[supplierId] = {
          supplier_id: purchase.supplier_id,
          supplier_name: purchase.supplier_name,
          supplier: purchase.supplier,
          purchase_count: 0,
          total_amount: 0,
          paid_amount: 0,
          balance: 0,
          overdue_amount: 0,
          purchases: []
        };
      }
      bySupplier[supplierId].purchase_count++;
      bySupplier[supplierId].total_amount += parseFloat(purchase.total_amount);
      bySupplier[supplierId].paid_amount += parseFloat(purchase.paid_amount);
      bySupplier[supplierId].balance += purchase.balance;
      if (purchase.is_overdue) bySupplier[supplierId].overdue_amount += purchase.balance;
      bySupplier[supplierId].purchases.push(purchase);
    });

    res.json({
      success: true,
      data: {
        summary: {
          total_payable: totalPayable,
          total_overdue: totalOverdue,
          total_purchases: pendingPurchases.length,
          total_suppliers: Object.keys(bySupplier).length
        },
        by_supplier: Object.values(bySupplier),
        all_purchases: purchasesWithDetails
      }
    });
  } catch (error) {
    console.error('Error obteniendo cuentas por pagar:', error);
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
        status: { [Op.in]: ['confirmed', 'received'] },
        payment_status: { [Op.in]: ['pending', 'partial'] }
      },
      order: [['purchase_date', 'DESC']]
    });

    let totalBalance = 0;
    let totalOverdue = 0;
    const today = new Date();

    const purchasesWithDetails = purchases.map(purchase => {
      const balance = parseFloat(purchase.total_amount) - parseFloat(purchase.paid_amount || 0);
      const referenceDate = purchase.due_date ? new Date(purchase.due_date) : new Date(purchase.purchase_date);
      const daysOverdue = purchase.due_date
        ? Math.floor((today - referenceDate) / (1000 * 60 * 60 * 24))
        : Math.floor((today - referenceDate) / (1000 * 60 * 60 * 24)) - 30;
      const isOverdue = daysOverdue > 0;

      totalBalance += balance;
      if (isOverdue) totalOverdue += balance;

      return {
        ...purchase.toJSON(),
        balance,
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

    const balance = parseFloat(purchase.total_amount) - parseFloat(purchase.paid_amount || 0);
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
        status: { [Op.in]: ['confirmed', 'received'] },
        payment_status: { [Op.in]: ['pending', 'partial'] }
      },
      include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'email', 'phone'] }],
      order: [['purchase_date', 'ASC']]
    });

    const today = new Date();
    const aging = { current: [], days_31_60: [], days_61_90: [], over_90: [] };
    const totals = { current: 0, days_31_60: 0, days_61_90: 0, over_90: 0, total: 0 };

    purchases.forEach(purchase => {
      const balance = parseFloat(purchase.total_amount) - parseFloat(purchase.paid_amount || 0);
      const referenceDate = purchase.due_date ? new Date(purchase.due_date) : new Date(purchase.purchase_date);
      const daysOverdue = Math.max(Math.floor((today - referenceDate) / (1000 * 60 * 60 * 24)), 0);

      const purchaseData = {
        id: purchase.id,
        purchase_number: purchase.purchase_number,
        purchase_date: purchase.purchase_date,
        supplier_id: purchase.supplier_id,
        supplier: purchase.supplier,
        total_amount: parseFloat(purchase.total_amount),
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
    const { amount, payment_method, payment_date, notes } = req.body;

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

    const total = parseFloat(purchase.total_amount);
    const alreadyPaid = parseFloat(purchase.paid_amount || 0);
    const remaining = total - alreadyPaid;

    if (remaining <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta compra ya está pagada en su totalidad' });
    }

    const effectiveAmount = Math.min(parseFloat(amount), remaining);
    const paid_amount = alreadyPaid + effectiveAmount;

    let payment_status = 'pending';
    if (paid_amount >= total) payment_status = 'paid';
    else if (paid_amount > 0) payment_status = 'partial';

    const payment_history = [...(purchase.payment_history || [])];
    payment_history.push({
      date: payment_date || new Date(),
      amount: effectiveAmount,
      method: payment_method || purchase.payment_method || 'Efectivo',
      user_id: userId,
      notes: notes || null
    });

    await purchase.update(
      { paid_amount, payment_status, payment_method: payment_method || purchase.payment_method, payment_history },
      { transaction }
    );

    await transaction.commit();

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
  getSupplierAccountsPayable,
  getPaymentHistory,
  getAgingReport,
  registerPayment
};