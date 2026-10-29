// backend/src/controllers/posTickets.controller.js
// Tirillas para impresora POS (ver services/pos/posTicket.service.js).
const { Sale, SaleItem, Customer, Product, Vehicle, Tenant, Receipt, CashSession, Branch, User } = require('../models');
const { buildSaleTicket, buildReceiptTicket, buildCashSessionTicket, findReceiptByPayment } = require('../services/pos/posTicket.service');
const logger = require('../config/logger');

const loadTenant = (req) => Tenant.findByPk(req.tenant_id || req.user.tenant_id);

// GET /api/pos-tickets/sale/:id
const getSaleTicket = async (req, res) => {
  try {
    const tenantId = req.tenant_id || req.user.tenant_id;
    const sale = await Sale.findOne({
      where: { id: req.params.id, tenant_id: tenantId },
      include: [
        { model: Customer, as: 'customer' },
        { model: SaleItem, as: 'items', include: [{ model: Product, as: 'product', include: [{ model: Vehicle, as: 'vehicle' }] }] },
      ],
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (!['factura', 'remision'].includes(sale.document_type)) {
      return res.status(400).json({ success: false, message: 'La tirilla solo está disponible para facturas y remisiones' });
    }
    const tenant = await loadTenant(req);
    res.json({ success: true, data: await buildSaleTicket(sale, tenant) });
  } catch (error) {
    logger.error('Error generando tirilla de venta:', error);
    res.status(500).json({ success: false, message: 'Error generando la tirilla de la venta' });
  }
};

// GET /api/pos-tickets/receipt/:id
// GET /api/pos-tickets/payment/:paymentId   (recibo del pago recién registrado)
const getReceiptTicket = async (req, res) => {
  try {
    const tenantId = req.tenant_id || req.user.tenant_id;
    const receipt = req.params.paymentId
      ? await findReceiptByPayment(tenantId, req.params.paymentId)
      : await Receipt.findOne({ where: { id: req.params.id, tenant_id: tenantId } });
    if (!receipt) return res.status(404).json({ success: false, message: 'Recibo no encontrado' });
    const tenant = await loadTenant(req);
    res.json({ success: true, data: await buildReceiptTicket(receipt, tenant) });
  } catch (error) {
    logger.error('Error generando tirilla de recibo:', error);
    res.status(500).json({ success: false, message: 'Error generando la tirilla del recibo' });
  }
};

// GET /api/pos-tickets/cash-session/:id
const getCashSessionTicket = async (req, res) => {
  try {
    const tenantId = req.tenant_id || req.user.tenant_id;
    const session = await CashSession.findOne({
      where: { id: req.params.id, tenant_id: tenantId },
      include: [
        { model: Branch, as: 'branch', attributes: ['id', 'name', 'address'] },
        { model: User, as: 'opener', attributes: ['id', 'first_name', 'last_name'] },
        { model: User, as: 'closer', attributes: ['id', 'first_name', 'last_name'] },
      ],
    });
    if (!session) return res.status(404).json({ success: false, message: 'Caja no encontrada' });
    const tenant = await loadTenant(req);
    res.json({ success: true, data: await buildCashSessionTicket(session, tenant) });
  } catch (error) {
    logger.error('Error generando tirilla de caja:', error);
    res.status(500).json({ success: false, message: 'Error generando la tirilla de la caja' });
  }
};

module.exports = { getSaleTicket, getReceiptTicket, getCashSessionTicket };
