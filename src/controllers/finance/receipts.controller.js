// backend/src/controllers/finance/receipts.controller.js
// Consulta y reimpresión de Recibos de Caja — el documento formal que
// respalda cada pago/abono de Ventas y Taller (ver services/finance/receiptNumber.service
// y los hooks en sales.controller.js / workOrders.controller.js#registerPayment).
const { Op } = require('sequelize');
const { Receipt, Sale, Customer, SaleItem, WorkOrder, Tenant, JournalEntry, CashSession } = require('../../models');

// GET /api/receipts?from_date=&to_date=&branch_id=&source_type=&cash_session_id=&search=
const listReceipts = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { from_date, to_date, branch_id, source_type, cash_session_id, search, limit = 50, offset = 0 } = req.query;

    const where = { tenant_id };
    if (branch_id) where.branch_id = branch_id;
    if (source_type) where.source_type = source_type;
    if (cash_session_id) where.cash_session_id = cash_session_id;
    if (from_date || to_date) {
      where.payment_date = {};
      if (from_date) where.payment_date[Op.gte] = new Date(`${from_date}T00:00:00`);
      if (to_date) where.payment_date[Op.lte] = new Date(`${to_date}T23:59:59`);
    }
    if (search) {
      where[Op.or] = [
        { receipt_number: { [Op.iLike]: `%${search}%` } },
        { reference: { [Op.iLike]: `%${search}%` } },
        { customer_name: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await Receipt.findAndCountAll({
      where,
      order: [['payment_date', 'DESC']],
      limit: Math.min(parseInt(limit) || 50, 200),
      offset: parseInt(offset) || 0,
    });

    res.json({ success: true, data: rows, total: count });
  } catch (error) {
    console.error('Error listando recibos:', error);
    res.status(500).json({ success: false, message: 'Error listando recibos' });
  }
};

// GET /api/receipts/:id — detalle con trazabilidad hacia el asiento contable
// y la sesión de caja (ambos ya vinculados por payment_id/cash_session_id).
const getReceiptById = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;

    const receipt = await Receipt.findOne({ where: { id, tenant_id } });
    if (!receipt) return res.status(404).json({ success: false, message: 'Recibo no encontrado' });

    const [journalEntry, cashSession] = await Promise.all([
      JournalEntry.findOne({
        where: { tenant_id, source_type: 'payment', source_id: receipt.payment_id },
        attributes: ['id', 'entry_number', 'status'],
      }),
      receipt.cash_session_id
        ? CashSession.findByPk(receipt.cash_session_id, { attributes: ['id', 'session_date', 'status'] })
        : null,
    ]);

    res.json({ success: true, data: { ...receipt.toJSON(), journal_entry: journalEntry, cash_session: cashSession } });
  } catch (error) {
    console.error('Error obteniendo recibo:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo recibo' });
  }
};

// GET /api/receipts/:id/pdf — reutiliza los generadores de PDF ya existentes
// (Ventas/Taller), alimentados con los datos guardados en Receipt en vez de
// query-params o índices calculados como antes.
const getReceiptPdf = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { id } = req.params;

    const receipt = await Receipt.findOne({ where: { id, tenant_id } });
    if (!receipt) return res.status(404).json({ success: false, message: 'Recibo no encontrado' });

    const payment = {
      payment_id: receipt.payment_id,
      receipt_number: receipt.receipt_number,
      amount: parseFloat(receipt.amount),
      method: receipt.method,
      date: receipt.payment_date,
      notes: null,
    };

    let pdfBuffer;
    if (receipt.source_type === 'sale') {
      const { generatePaymentReceiptPDFBuffer } = require('../../services/pdfService');
      const sale = await Sale.findOne({
        where: { id: receipt.source_id, tenant_id },
        include: [{ model: Customer, as: 'customer' }, { model: SaleItem, as: 'items' }],
      });
      if (!sale) return res.status(404).json({ success: false, message: 'Venta asociada no encontrada' });
      const tenant = await Tenant.findByPk(tenant_id);
      pdfBuffer = await generatePaymentReceiptPDFBuffer(sale, tenant, payment);
    } else {
      const { generatePaymentReceiptBuffer } = require('../../services/workshopPdfService');
      const order = await WorkOrder.findOne({ where: { id: receipt.source_id, tenant_id } });
      if (!order) return res.status(404).json({ success: false, message: 'Orden asociada no encontrada' });
      const tenant = await Tenant.findByPk(tenant_id);
      pdfBuffer = await generatePaymentReceiptBuffer(order, tenant, payment);
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${receipt.receipt_number}.pdf"`,
      'Content-Length': pdfBuffer.length,
      'Cache-Control': 'no-store',
    });
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generando PDF del recibo:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error generando PDF del recibo' });
  }
};

module.exports = { listReceipts, getReceiptById, getReceiptPdf };
