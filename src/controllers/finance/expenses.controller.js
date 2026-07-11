// backend/src/controllers/finance/expenses.controller.js
const { Expense, Supplier, Branch, User } = require('../../models');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');

const CATEGORIES = [
  'arriendo', 'servicios_publicos', 'nomina', 'mantenimiento',
  'transporte', 'impuestos', 'marketing', 'insumos_oficina',
  'seguros', 'honorarios', 'otro'
];

/**
 * Generar número de gasto único (GAS-2026-00001)
 */
const generateExpenseNumber = async (tenant_id, transaction = null) => {
  const year = new Date().getFullYear();
  const prefix = `GAS-${year}-`;

  const lastExpense = await Expense.findOne({
    where: { tenant_id, expense_number: { [Op.like]: `${prefix}%` } },
    order: [['expense_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction: transaction || undefined
  });

  let nextNumber = 1;
  if (lastExpense) {
    const lastNumber = parseInt(lastExpense.expense_number.split('-').pop(), 10);
    if (!isNaN(lastNumber)) nextNumber = lastNumber + 1;
  }
  return `${prefix}${String(nextNumber).padStart(5, '0')}`;
};

// Listar gastos con filtros y paginación
const getExpenses = async (req, res) => {
  try {
    const {
      search = '', category, payment_status, branch_id,
      start_date, end_date, sort_by = 'expense_date', sort_order = 'DESC',
      page = 1, limit = 20
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;
    const where = { tenant_id };

    if (category) where.category = category;
    if (payment_status) where.payment_status = payment_status;
    if (branch_id) where.branch_id = branch_id;

    if (search) {
      where[Op.or] = [
        { description: { [Op.iLike]: `%${search}%` } },
        { expense_number: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (start_date) where.expense_date = { ...where.expense_date, [Op.gte]: start_date };
    if (end_date) where.expense_date = { ...where.expense_date, [Op.lte]: end_date };

    const { count, rows } = await Expense.findAndCountAll({
      where,
      include: [
        { model: Supplier, as: 'supplier', attributes: ['id', 'name'] },
        { model: Branch, as: 'branch', attributes: ['id', 'name'] },
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] }
      ],
      order: [[sort_by, sort_order]],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      success: true,
      data: rows,
      pagination: { total: count, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(count / limit) }
    });
  } catch (error) {
    console.error('Error obteniendo gastos:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo gastos' });
  }
};

// Obtener un gasto por id
const getExpenseById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const expense = await Expense.findOne({
      where: { id, tenant_id },
      include: [
        { model: Supplier, as: 'supplier', attributes: ['id', 'name'] },
        { model: Branch, as: 'branch', attributes: ['id', 'name'] },
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'] }
      ]
    });
    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado' });
    res.json({ success: true, data: expense });
  } catch (error) {
    console.error('Error obteniendo gasto:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo el gasto' });
  }
};

// Resumen (para tarjetas del dashboard de gastos)
const getExpensesSummary = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { from_date, to_date, branch_id } = req.query;

    const where = { tenant_id };
    if (branch_id) where.branch_id = branch_id;
    if (from_date && to_date) where.expense_date = { [Op.between]: [from_date, to_date] };
    else if (from_date) where.expense_date = { [Op.gte]: from_date };
    else if (to_date) where.expense_date = { [Op.lte]: to_date };

    const expenses = await Expense.findAll({ where, attributes: ['total_amount', 'paid_amount', 'payment_status', 'category'] });

    let totalAmount = 0, totalPending = 0;
    const byCategory = {};
    expenses.forEach(e => {
      const total = parseFloat(e.total_amount);
      const balance = total - parseFloat(e.paid_amount || 0);
      totalAmount += total;
      if (e.payment_status !== 'paid') totalPending += balance;
      byCategory[e.category] = (byCategory[e.category] || 0) + total;
    });

    res.json({
      success: true,
      data: {
        total_amount: totalAmount,
        total_pending: totalPending,
        total_expenses: expenses.length,
        by_category: byCategory
      }
    });
  } catch (error) {
    console.error('Error obteniendo resumen de gastos:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo resumen de gastos' });
  }
};

// Crear gasto
const createExpense = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const {
      category, description, supplier_id, expense_date, due_date,
      total_amount, payment_method, is_recurring, receipt_url, notes,
      branch_id, paid_now
    } = req.body;

    if (!category || !CATEGORIES.includes(category)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Categoría inválida' });
    }
    if (!description || !total_amount || parseFloat(total_amount) <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Descripción y monto son obligatorios' });
    }

    const expense_number = await generateExpenseNumber(tenant_id, transaction);

    // Si se marca "pagar ahora", el gasto nace ya pagado en su totalidad
    const initialPaidAmount = paid_now ? parseFloat(total_amount) : 0;
    const initialStatus = paid_now ? 'paid' : 'pending';
    const initialHistory = paid_now
      ? [{ date: expense_date || new Date(), amount: parseFloat(total_amount), method: payment_method || 'Efectivo', user_id: req.user.id, notes: 'Pago al momento de registrar el gasto' }]
      : [];

    const expense = await Expense.create({
      tenant_id,
      branch_id: branch_id || req.branch_id || null,
      expense_number,
      category,
      description,
      supplier_id: supplier_id || null,
      expense_date: expense_date || new Date(),
      due_date: due_date || null,
      total_amount: parseFloat(total_amount),
      payment_method: payment_method || null,
      payment_status: initialStatus,
      paid_amount: initialPaidAmount,
      payment_history: initialHistory,
      is_recurring: !!is_recurring,
      receipt_url: receipt_url || null,
      notes: notes || null,
      created_by: req.user.id
    }, { transaction });

    await transaction.commit();

    // Asiento contable en borrador (no bloqueante: si falla, solo se loguea)
    setImmediate(async () => {
      try {
        const { generateExpenseEntry } = require('../../services/accounting/autoEntries.service');
        await generateExpenseEntry(expense, tenant_id, req.user.id);
      } catch (err) {
        require('../../config/logger').warn(`[accounting] Error generando asiento de gasto ${expense.id}: ${err.message}`);
      }
    });

    const created = await Expense.findByPk(expense.id, {
      include: [{ model: Supplier, as: 'supplier' }, { model: Branch, as: 'branch' }]
    });

    res.status(201).json({ success: true, message: 'Gasto registrado exitosamente', data: created });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    console.error('Error creando gasto:', error);
    res.status(500).json({ success: false, message: 'Error registrando el gasto' });
  }
};

// Actualizar gasto (solo datos descriptivos; los pagos van por registerPayment)
const updateExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const expense = await Expense.findOne({ where: { id, tenant_id } });
    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado' });

    const {
      category, description, supplier_id, expense_date, due_date,
      total_amount, is_recurring, receipt_url, notes, branch_id
    } = req.body;

    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: 'Categoría inválida' });
    }
    // No permitir bajar el total por debajo de lo ya pagado
    if (total_amount !== undefined && parseFloat(total_amount) < parseFloat(expense.paid_amount || 0)) {
      return res.status(400).json({ success: false, message: 'El monto no puede ser menor a lo ya pagado' });
    }

    await expense.update({
      category: category ?? expense.category,
      description: description ?? expense.description,
      supplier_id: supplier_id !== undefined ? supplier_id : expense.supplier_id,
      expense_date: expense_date ?? expense.expense_date,
      due_date: due_date !== undefined ? due_date : expense.due_date,
      total_amount: total_amount !== undefined ? parseFloat(total_amount) : expense.total_amount,
      is_recurring: is_recurring !== undefined ? !!is_recurring : expense.is_recurring,
      receipt_url: receipt_url !== undefined ? receipt_url : expense.receipt_url,
      notes: notes !== undefined ? notes : expense.notes,
      branch_id: branch_id !== undefined ? branch_id : expense.branch_id
    });

    res.json({ success: true, message: 'Gasto actualizado', data: expense });
  } catch (error) {
    console.error('Error actualizando gasto:', error);
    res.status(500).json({ success: false, message: 'Error actualizando el gasto' });
  }
};

// Eliminar gasto (solo si no tiene pagos registrados)
const deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const expense = await Expense.findOne({ where: { id, tenant_id } });
    if (!expense) return res.status(404).json({ success: false, message: 'Gasto no encontrado' });
    if (parseFloat(expense.paid_amount || 0) > 0) {
      return res.status(400).json({ success: false, message: 'No se puede eliminar un gasto con pagos registrados' });
    }
    await expense.destroy();
    res.json({ success: true, message: 'Gasto eliminado' });
  } catch (error) {
    console.error('Error eliminando gasto:', error);
    res.status(500).json({ success: false, message: 'Error eliminando el gasto' });
  }
};

// Registrar un abono sobre un gasto pendiente/parcial
const registerPayment = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const userId = req.user.id;
    const { amount, payment_method, payment_date, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    const expense = await Expense.findOne({
      where: { id, tenant_id },
      lock: transaction.LOCK.UPDATE,
      transaction
    });
    if (!expense) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Gasto no encontrado' });
    }

    const total = parseFloat(expense.total_amount);
    const alreadyPaid = parseFloat(expense.paid_amount || 0);
    const remaining = total - alreadyPaid;

    if (remaining <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Este gasto ya está pagado en su totalidad' });
    }

    const effectiveAmount = Math.min(parseFloat(amount), remaining);
    const paid_amount = alreadyPaid + effectiveAmount;

    let payment_status = 'pending';
    if (paid_amount >= total) payment_status = 'paid';
    else if (paid_amount > 0) payment_status = 'partial';

    const payment_history = [...(expense.payment_history || [])];
    payment_history.push({
      date: payment_date || new Date(),
      amount: effectiveAmount,
      method: payment_method || expense.payment_method || 'Efectivo',
      user_id: userId,
      notes: notes || null
    });

    await expense.update(
      { paid_amount, payment_status, payment_method: payment_method || expense.payment_method, payment_history },
      { transaction }
    );

    await transaction.commit();

    res.json({ success: true, message: 'Pago registrado exitosamente', data: expense });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    console.error('Error registrando pago de gasto:', error);
    res.status(500).json({ success: false, message: 'Error registrando el pago' });
  }
};

module.exports = {
  CATEGORIES,
  getExpenses,
  getExpenseById,
  getExpensesSummary,
  createExpense,
  updateExpense,
  deleteExpense,
  registerPayment
};