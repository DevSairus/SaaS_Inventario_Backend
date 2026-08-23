// backend/src/controllers/finance/customerAdvances.controller.js
//
// Anticipos de Clientes: dinero recibido de un cliente sin venta todavía
// contra qué aplicarlo. Ver Anticipos-Clientes-Analisis-y-Plan.md.
//
// Endpoints:
//   POST   /api/customer-advances                    → createAdvance
//   GET    /api/customer-advances                     → listAdvances
//   GET    /api/customer-advances/:id                 → getAdvanceById
//   GET    /api/customers/:id/advances/available       → getAvailableAdvancesForCustomer
//   POST   /api/sales/:id/apply-advance                → applyAdvanceToSale
//   POST   /api/customer-advances/:id/refund           → refundAdvance
//   POST   /api/customer-advances/:id/void             → voidAdvance

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  CustomerAdvance, CustomerAdvanceApplication, Sale, Customer, JournalEntry,
} = require('../../models');
const { generateAdvanceNumber } = require('../../services/finance/advanceNumber.service');
const { getOpenSession, isTreasuryEnabled } = require('../../services/finance/cashSession.service');
const { markAdvanceForAlertCheck } = require('../../middleware/autoCheckAdvanceAlerts.middleware');
const logger = require('../../config/logger');

// ── POST /customer-advances — recibir un anticipo ───────────────────────────
const createAdvance = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.tenant_id;
    const branch_id = req.branch_id;
    const user_id = req.user_id || req.user?.id;
    const { customer_id, amount, method, received_date, reference_note, triggers_iva } = req.body;

    if (!customer_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El cliente es obligatorio' });
    }
    if (!amount || parseFloat(amount) <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    const customer = await Customer.findOne({ where: { id: customer_id, tenant_id }, transaction });
    if (!customer) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    // Recibir un anticipo mueve efectivo hoy — exige caja abierta, mismo
    // criterio que registerPayment (solo para tenants con Tesorería activa).
    let openSession = null;
    if (await isTreasuryEnabled(tenant_id)) {
      openSession = await getOpenSession(tenant_id, branch_id, transaction);
      if (!openSession) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'No hay una caja abierta en esta sede. Abre la caja antes de registrar anticipos.' });
      }
    }

    const effectiveAmount = parseFloat(amount);
    const advance_number = await generateAdvanceNumber(tenant_id, transaction);

    const advance = await CustomerAdvance.create({
      tenant_id,
      branch_id,
      customer_id,
      advance_number,
      amount: effectiveAmount,
      applied_amount: 0,
      refunded_amount: 0,
      balance: effectiveAmount,
      method: method || 'Efectivo',
      received_date: received_date || new Date(),
      cash_session_id: openSession?.id || null,
      reference_note: reference_note || null,
      triggers_iva: !!triggers_iva,
      status: 'active',
      created_by: user_id,
    }, { transaction });

    await transaction.commit();

    // Asiento contable de la recepción, no bloqueante — mismo patrón
    // fire-and-forget que el resto de generadores automáticos.
    setImmediate(async () => {
      try {
        const { generateAdvanceEntry } = require('../../services/accounting/autoEntries.service');
        await generateAdvanceEntry(advance, tenant_id, user_id);
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de anticipo (${advance.id}): ${err.message}`);
      }
    });
    markAdvanceForAlertCheck(advance.id, tenant_id);

    res.status(201).json({ success: true, message: 'Anticipo registrado exitosamente', data: advance });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error registrando anticipo:', error);
    res.status(500).json({ success: false, message: 'Error registrando anticipo' });
  }
};

// ── GET /customer-advances — listado + filtros ───────────────────────────────
const listAdvances = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const { customer_id, branch_id, status, from_date, to_date, search, limit = 50, offset = 0 } = req.query;

    const where = { tenant_id };
    if (customer_id) where.customer_id = customer_id;
    if (branch_id) where.branch_id = branch_id;
    if (status) where.status = status;
    if (from_date || to_date) {
      where.received_date = {};
      if (from_date) where.received_date[Op.gte] = new Date(`${from_date}T00:00:00`);
      if (to_date) where.received_date[Op.lte] = new Date(`${to_date}T23:59:59`);
    }
    if (search) {
      where[Op.or] = [
        { advance_number: { [Op.iLike]: `%${search}%` } },
        { reference_note: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await CustomerAdvance.findAndCountAll({
      where,
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'phone'] }],
      order: [['received_date', 'DESC']],
      limit: Math.min(parseInt(limit) || 50, 200),
      offset: parseInt(offset) || 0,
    });

    // Resumen agregado — igual criterio que §9 del análisis (cards del informe).
    const summary = await CustomerAdvance.findAll({
      where: { tenant_id, status: { [Op.ne]: 'voided' } },
      attributes: [
        [sequelize.fn('SUM', sequelize.literal(`CASE WHEN status = 'active' THEN balance ELSE 0 END`)), 'active_balance'],
        [sequelize.fn('SUM', sequelize.col('amount')), 'total_received'],
        [sequelize.fn('SUM', sequelize.col('applied_amount')), 'total_applied'],
        [sequelize.fn('SUM', sequelize.col('refunded_amount')), 'total_refunded'],
      ],
      raw: true,
    });

    res.json({ success: true, data: rows, total: count, summary: summary[0] });
  } catch (error) {
    logger.error('Error listando anticipos:', error);
    res.status(500).json({ success: false, message: 'Error listando anticipos' });
  }
};

// ── GET /customer-advances/:id — detalle + aplicaciones (drill-down) ────────
const getAdvanceById = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const { id } = req.params;

    const advance = await CustomerAdvance.findOne({
      where: { id, tenant_id },
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'phone'] },
        {
          model: CustomerAdvanceApplication,
          as: 'applications',
          include: [{ model: Sale, as: 'sale', attributes: ['id', 'sale_number', 'total_amount', 'sale_date'] }],
        },
      ],
    });
    if (!advance) return res.status(404).json({ success: false, message: 'Anticipo no encontrado' });

    const journalEntry = await JournalEntry.findOne({
      where: { tenant_id, source_type: 'customer_advance', source_id: advance.id },
      attributes: ['id', 'entry_number', 'status'],
    });

    res.json({ success: true, data: { ...advance.toJSON(), journal_entry: journalEntry } });
  } catch (error) {
    logger.error('Error obteniendo anticipo:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo anticipo' });
  }
};

// ── GET /customers/:id/advances/available — selector al facturar ────────────
const getAvailableAdvancesForCustomer = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const { id } = req.params;

    const advances = await CustomerAdvance.findAll({
      where: { tenant_id, customer_id: id, status: 'active', balance: { [Op.gt]: 0 } },
      // FIFO: el más viejo primero — mismo criterio conservador que cartera (§5.1).
      order: [['received_date', 'ASC']],
    });

    const total_available = advances.reduce((sum, a) => sum + parseFloat(a.balance), 0);

    res.json({ success: true, data: advances, total_available });
  } catch (error) {
    logger.error('Error obteniendo anticipos disponibles:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo anticipos disponibles' });
  }
};

// ── POST /sales/:id/apply-advance — aplicar uno o varios anticipos a una venta ──
// Body: { applications: [{ advance_id, amount }] }
const applyAdvanceToSale = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenant_id = req.tenant_id;
    const user_id = req.user_id || req.user?.id;
    const applications = Array.isArray(req.body) ? req.body : req.body?.applications;

    if (!applications || !Array.isArray(applications) || applications.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Debe indicar al menos un anticipo a aplicar' });
    }

    // SELECT FOR UPDATE sobre la venta — mismo patrón que registerPayment,
    // evita que dos aplicaciones/pagos concurrentes lean el mismo paid_amount.
    const sale = await Sale.findOne({
      where: { id, tenant_id },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }
    if (sale.status === 'draft') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se puede aplicar un anticipo a una venta en borrador' });
    }
    if (['cancelled'].includes(sale.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta venta está cancelada' });
    }

    const total = parseFloat(sale.total_amount);
    const alreadyPaid = parseFloat(sale.paid_amount || 0);
    const remaining = total - alreadyPaid;
    if (remaining <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta venta ya está pagada en su totalidad' });
    }

    const requestedTotal = applications.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);
    if (requestedTotal <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El monto a aplicar debe ser mayor a 0' });
    }
    if (requestedTotal > remaining + 0.01) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `El total a aplicar (${requestedTotal}) supera el saldo pendiente de la venta (${remaining})` });
    }

    const createdApplications = [];
    const payment_history = [...(sale.payment_history || [])];

    for (const req_app of applications) {
      const appAmount = parseFloat(req_app.amount || 0);
      if (appAmount <= 0) continue;

      // SELECT FOR UPDATE sobre cada anticipo — evita que dos facturas
      // concurrentes gasten el mismo anticipo dos veces (§5 del análisis).
      const advance = await CustomerAdvance.findOne({
        where: { id: req_app.advance_id, tenant_id },
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (!advance) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: `Anticipo ${req_app.advance_id} no encontrado` });
      }
      if (advance.customer_id !== sale.customer_id) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: `El anticipo ${advance.advance_number} no pertenece al cliente de esta venta` });
      }
      if (advance.status !== 'active') {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: `El anticipo ${advance.advance_number} no está disponible (estado: ${advance.status})` });
      }
      if (appAmount > parseFloat(advance.balance) + 0.01) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: `El anticipo ${advance.advance_number} solo tiene ${advance.balance} disponibles` });
      }

      const application = await CustomerAdvanceApplication.create({
        tenant_id,
        advance_id: advance.id,
        sale_id: sale.id,
        amount: appAmount,
        application_date: new Date(),
        status: 'active',
        created_by: user_id,
      }, { transaction });
      createdApplications.push(application);

      const newAppliedAmount = parseFloat(advance.applied_amount) + appAmount;
      const newBalance = parseFloat(advance.amount) - newAppliedAmount - parseFloat(advance.refunded_amount);
      await advance.update({
        applied_amount: newAppliedAmount,
        balance: newBalance,
        status: newBalance <= 0.01 ? 'fully_applied' : 'active',
      }, { transaction });

      payment_history.push({
        payment_id: application.id,
        date: application.application_date,
        amount: appAmount,
        method: 'Anticipo',
        source: 'advance',
        advance_id: advance.id,
        advance_number: advance.advance_number,
        application_id: application.id,
        user_id,
        branch_id: sale.branch_id,
      });
    }

    const paid_amount = alreadyPaid + requestedTotal;
    let payment_status = 'pending';
    if (paid_amount >= total) payment_status = 'paid';
    else if (paid_amount > 0) payment_status = 'partial';

    await sale.update({ paid_amount, payment_status, payment_history }, { transaction });

    await transaction.commit();

    // Asientos contables de cada aplicación, no bloqueantes.
    setImmediate(async () => {
      try {
        const { generateAdvanceApplicationEntry } = require('../../services/accounting/autoEntries.service');
        for (const application of createdApplications) {
          await generateAdvanceApplicationEntry(application, sale, tenant_id, user_id);
        }
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de aplicación de anticipo (venta ${id}): ${err.message}`);
      }
    });
    // Cada anticipo aplicado cambió de saldo (o quedó en 0) — resolver su
    // alerta de antigüedad si ya no aplica.
    for (const application of createdApplications) {
      markAdvanceForAlertCheck(application.advance_id, tenant_id);
    }

    const updatedSale = await Sale.findByPk(id);
    res.json({ success: true, message: 'Anticipo(s) aplicado(s) exitosamente', data: updatedSale });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error aplicando anticipo:', error);
    res.status(500).json({ success: false, message: 'Error aplicando anticipo' });
  }
};

// ── POST /customer-advances/:id/refund — devolver un anticipo (total o parcial) ──
const refundAdvance = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenant_id = req.tenant_id;
    const branch_id = req.branch_id;
    const user_id = req.user_id || req.user?.id;
    const { amount, method, reason } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    const advance = await CustomerAdvance.findOne({
      where: { id, tenant_id },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!advance) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Anticipo no encontrado' });
    }
    if (advance.status === 'voided') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Este anticipo está anulado' });
    }

    const refundAmount = parseFloat(amount);
    if (refundAmount > parseFloat(advance.balance) + 0.01) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `Solo hay ${advance.balance} disponibles para devolver` });
    }

    // Devolver dinero sale de caja hoy — exige caja abierta, igual que recibir el anticipo.
    let openSession = null;
    if (await isTreasuryEnabled(tenant_id)) {
      openSession = await getOpenSession(tenant_id, branch_id, transaction);
      if (!openSession) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'No hay una caja abierta en esta sede. Abre la caja antes de devolver anticipos.' });
      }
    }

    const refund_id = require('crypto').randomUUID();
    const refund_date = new Date();
    const effectiveMethod = method || advance.method || 'Efectivo';
    const refund_history = [...(advance.refund_history || []), {
      refund_id,
      amount: refundAmount,
      date: refund_date,
      method: effectiveMethod,
      user_id,
      reason: reason || null,
    }];

    const newRefundedAmount = parseFloat(advance.refunded_amount) + refundAmount;
    const newBalance = parseFloat(advance.amount) - parseFloat(advance.applied_amount) - newRefundedAmount;

    await advance.update({
      refunded_amount: newRefundedAmount,
      balance: newBalance,
      status: newBalance <= 0.01 ? 'fully_refunded' : 'active',
      refund_history,
    }, { transaction });

    await transaction.commit();

    setImmediate(async () => {
      try {
        const { generateAdvanceRefundEntry } = require('../../services/accounting/autoEntries.service');
        await generateAdvanceRefundEntry(
          { id: refund_id, amount: refundAmount, method: effectiveMethod, refund_date },
          advance,
          tenant_id,
          user_id
        );
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de devolución de anticipo (${id}): ${err.message}`);
      }
    });
    markAdvanceForAlertCheck(advance.id, tenant_id);

    res.json({ success: true, message: 'Anticipo devuelto exitosamente', data: advance });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error devolviendo anticipo:', error);
    res.status(500).json({ success: false, message: 'Error devolviendo anticipo' });
  }
};

// ── POST /customer-advances/:id/void — anular por error de digitación ───────
// Solo antes de que tenga aplicaciones o devoluciones (simétrico a voidSale.js).
const voidAdvance = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenant_id = req.tenant_id;
    const user_id = req.user_id || req.user?.id;
    const { reason } = req.body;

    if (!reason) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El motivo es obligatorio' });
    }

    const advance = await CustomerAdvance.findOne({
      where: { id, tenant_id },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!advance) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Anticipo no encontrado' });
    }
    if (advance.status === 'voided') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Este anticipo ya está anulado' });
    }
    if (parseFloat(advance.applied_amount) > 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se puede anular: este anticipo ya tiene aplicaciones. Debe revertirlas primero.' });
    }
    if (parseFloat(advance.refunded_amount) > 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se puede anular: este anticipo ya tiene devoluciones registradas.' });
    }

    await advance.update({
      status: 'voided',
      balance: 0,
      voided_at: new Date(),
      voided_by: user_id,
      voided_reason: reason,
    }, { transaction });

    await transaction.commit();

    setImmediate(async () => {
      try {
        const { reverseSourceEntries } = require('../../services/accounting/autoEntries.service');
        await reverseSourceEntries('customer_advance', advance.id, tenant_id, user_id, `Anticipo ${advance.advance_number} anulado — ${reason}`);
      } catch (err) {
        logger.warn(`[accounting] Error reversando asiento de anticipo anulado (${id}): ${err.message}`);
      }
    });

    res.json({ success: true, message: 'Anticipo anulado exitosamente', data: advance });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error anulando anticipo:', error);
    res.status(500).json({ success: false, message: 'Error anulando anticipo' });
  }
};

module.exports = {
  createAdvance,
  listAdvances,
  getAdvanceById,
  getAvailableAdvancesForCustomer,
  applyAdvanceToSale,
  refundAdvance,
  voidAdvance,
};
