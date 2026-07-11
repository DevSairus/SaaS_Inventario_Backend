// backend/src/controllers/finance/cashSessions.controller.js
// Apertura y cierre de caja, por sede. El cuadre esperado se calcula
// reutilizando buildCashFlow() (misma fuente que Tesorería): filtra los
// movimientos de payment_history de Ventas/Compras/Gastos de esa sede en la
// fecha de la caja, y los agrupa por método de pago normalizado.
const { CashSession, Branch, User } = require('../../models');
const { buildCashFlow } = require('./cashflow.controller');

const ZERO_BUCKET = { efectivo: 0, tarjeta: 0, transferencia: 0, otro: 0 };

// Los distintos módulos (ventas, compras, gastos, órdenes de trabajo) han
// guardado el método de pago con distinta capitalización/nombre a lo largo
// del tiempo ('Efectivo', 'cash', 'efectivo', 'tarjeta_credito', etc.).
// Se normaliza a 4 baldes fijos para que el cuadre sea consistente.
function normalizeMethod(method) {
  const m = String(method || '').toLowerCase().trim();
  if (['efectivo', 'cash', 'contado'].includes(m)) return 'efectivo';
  if (['tarjeta', 'card', 'credito', 'debito', 'tarjeta_credito', 'tarjeta_debito', 'tarjeta credito', 'tarjeta debito'].includes(m)) return 'tarjeta';
  if (['transferencia', 'transfer', 'nequi', 'daviplata', 'pse', 'bancolombia'].includes(m)) return 'transferencia';
  return 'otro';
}

// Calcula lo que DEBERÍA haber en caja por método de pago: la base de
// apertura (siempre en efectivo) + entradas - salidas de ese día para esa
// sede, agrupadas por método normalizado.
const calculateExpected = async (session) => {
  const dateStr = session.session_date; // 'YYYY-MM-DD' (DATEONLY)
  const cashFlow = await buildCashFlow(session.tenant_id, {
    from_date: dateStr,
    to_date: dateStr,
    branch_id: session.branch_id,
  });

  const expected = { ...ZERO_BUCKET, efectivo: parseFloat(session.opening_amount) || 0 };
  cashFlow.allTransactions.forEach(t => {
    const bucket = normalizeMethod(t.method);
    const signedAmount = t.direction === 'in' ? t.amount : -t.amount;
    expected[bucket] += signedAmount;
  });

  Object.keys(expected).forEach(k => { expected[k] = Math.round(expected[k] * 100) / 100; });
  return { expected, transactionCount: cashFlow.allTransactions.length };
};

// GET /api/cash-sessions/current?branch_id=
const getCurrentSession = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { branch_id } = req.query;
    if (!branch_id) return res.status(400).json({ success: false, message: 'branch_id es requerido' });

    const session = await CashSession.findOne({
      where: { tenant_id, branch_id, status: 'open' },
      include: [{ model: User, as: 'opener', attributes: ['id', 'first_name', 'last_name'] }],
      order: [['opened_at', 'DESC']],
    });

    if (!session) return res.json({ success: true, data: null });

    const { expected, transactionCount } = await calculateExpected(session);
    res.json({ success: true, data: { ...session.toJSON(), live_expected_amounts: expected, transaction_count: transactionCount } });
  } catch (error) {
    console.error('Error obteniendo caja actual:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo caja actual' });
  }
};

// POST /api/cash-sessions/open  { branch_id, session_date, opening_amount, notes }
const openSession = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;
    const { branch_id, session_date, opening_amount, notes } = req.body;

    if (!branch_id) return res.status(400).json({ success: false, message: 'Selecciona una sede' });
    if (!session_date) return res.status(400).json({ success: false, message: 'Falta la fecha de apertura' });
    if (opening_amount === undefined || opening_amount === null || isNaN(parseFloat(opening_amount)) || parseFloat(opening_amount) < 0) {
      return res.status(400).json({ success: false, message: 'La base de apertura debe ser un monto válido' });
    }

    const branch = await Branch.findOne({ where: { id: branch_id, tenant_id } });
    if (!branch) return res.status(404).json({ success: false, message: 'Sede no encontrada' });

    const existing = await CashSession.findOne({ where: { tenant_id, branch_id, status: 'open' } });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Ya hay una caja abierta en ${branch.name} desde el ${existing.session_date}. Ciérrala antes de abrir una nueva.`,
      });
    }

    const session = await CashSession.create({
      tenant_id,
      branch_id,
      session_date,
      status: 'open',
      opening_amount: parseFloat(opening_amount),
      opening_notes: notes || null,
      opened_by: user_id,
      opened_at: new Date(),
    });

    res.status(201).json({ success: true, data: session });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya hay una caja abierta en esa sede.' });
    }
    console.error('Error abriendo caja:', error);
    res.status(500).json({ success: false, message: 'Error abriendo caja' });
  }
};

// GET /api/cash-sessions/:id/summary  — vista previa del cuadre ANTES de cerrar
const getSessionSummary = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;

    const session = await CashSession.findOne({ where: { id, tenant_id } });
    if (!session) return res.status(404).json({ success: false, message: 'Caja no encontrada' });

    const { expected, transactionCount } = await calculateExpected(session);
    res.json({
      success: true,
      data: {
        session,
        expected_amounts: expected,
        transaction_count: transactionCount,
      },
    });
  } catch (error) {
    console.error('Error calculando cuadre de caja:', error);
    res.status(500).json({ success: false, message: 'Error calculando cuadre de caja' });
  }
};

// POST /api/cash-sessions/:id/close  { counted_amounts: {efectivo, tarjeta, transferencia, otro}, notes }
const closeSession = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;
    const { id } = req.params;
    const { counted_amounts, notes } = req.body;

    const session = await CashSession.findOne({ where: { id, tenant_id } });
    if (!session) return res.status(404).json({ success: false, message: 'Caja no encontrada' });
    if (session.status === 'closed') {
      return res.status(400).json({ success: false, message: 'Esta caja ya está cerrada' });
    }

    const counted = { ...ZERO_BUCKET };
    Object.keys(ZERO_BUCKET).forEach(k => {
      const v = counted_amounts ? parseFloat(counted_amounts[k]) : NaN;
      counted[k] = isNaN(v) ? 0 : v;
    });

    // Se recalcula el esperado en el momento del cierre (no se confía en lo
    // que mandó el frontend), para reflejar cualquier movimiento de último
    // minuto y evitar manipulación del cuadre.
    const { expected } = await calculateExpected(session);

    const differences = {};
    Object.keys(ZERO_BUCKET).forEach(k => {
      differences[k] = Math.round((counted[k] - expected[k]) * 100) / 100;
    });

    await session.update({
      status: 'closed',
      expected_amounts: expected,
      counted_amounts: counted,
      differences,
      closing_notes: notes || null,
      closed_by: user_id,
      closed_at: new Date(),
    });

    // Asiento contable en borrador si hubo sobrante/faltante (no bloqueante:
    // si falla, solo se loguea — el cierre de caja ya quedó guardado igual)
    setImmediate(async () => {
      try {
        const { generateCashSessionEntry } = require('../../services/accounting/autoEntries.service');
        await generateCashSessionEntry(session, tenant_id, user_id);
      } catch (err) {
        require('../../config/logger').warn(`[accounting] Error generando asiento de cierre de caja ${session.id}: ${err.message}`);
      }
    });

    res.json({ success: true, data: session });
  } catch (error) {
    console.error('Error cerrando caja:', error);
    res.status(500).json({ success: false, message: 'Error cerrando caja' });
  }
};

// GET /api/cash-sessions?branch_id=&from_date=&to_date=&status=
const listSessions = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { branch_id, from_date, to_date, status } = req.query;

    const where = { tenant_id };
    if (branch_id) where.branch_id = branch_id;
    if (status) where.status = status;
    if (from_date || to_date) {
      const { Op } = require('sequelize');
      where.session_date = {};
      if (from_date) where.session_date[Op.gte] = from_date;
      if (to_date) where.session_date[Op.lte] = to_date;
    }

    const sessions = await CashSession.findAll({
      where,
      include: [
        { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
        { model: User, as: 'opener', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'closer', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['session_date', 'DESC'], ['opened_at', 'DESC']],
      limit: 100,
    });

    res.json({ success: true, data: sessions });
  } catch (error) {
    console.error('Error listando cajas:', error);
    res.status(500).json({ success: false, message: 'Error listando cajas' });
  }
};

// GET /api/cash-sessions/:id
const getSessionById = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;

    const session = await CashSession.findOne({
      where: { id, tenant_id },
      include: [
        { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
        { model: User, as: 'opener', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'closer', attributes: ['id', 'first_name', 'last_name'] },
      ],
    });
    if (!session) return res.status(404).json({ success: false, message: 'Caja no encontrada' });

    res.json({ success: true, data: session });
  } catch (error) {
    console.error('Error obteniendo caja:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo caja' });
  }
};

module.exports = { getCurrentSession, openSession, getSessionSummary, closeSession, listSessions, getSessionById };