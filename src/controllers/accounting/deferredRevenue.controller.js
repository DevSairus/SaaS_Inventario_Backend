// backend/src/controllers/accounting/deferredRevenue.controller.js
// Ingresos diferidos: lista y amortización manual (el job diario hace lo mismo).
const { DeferredRevenue, ChartOfAccount, Sale, Customer } = require('../../models');
const { amortizeDue } = require('../../services/accounting/deferredRevenue.service');
const logger = require('../../config/logger');

// GET /api/accounting/deferred-revenues?status=
exports.list = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.status) where.status = req.query.status;
    const rows = await DeferredRevenue.findAll({ where, order: [['start_date', 'DESC'], ['created_at', 'DESC']] });
    const accIds = [...new Set(rows.flatMap((r) => [r.liability_account_id, r.revenue_account_id]))];
    const [accounts, sales, customers] = await Promise.all([
      accIds.length ? ChartOfAccount.findAll({ where: { id: accIds }, attributes: ['id', 'code', 'name'] }) : [],
      rows.length ? Sale.findAll({ where: { id: rows.map((r) => r.sale_id) }, attributes: ['id', 'sale_number', 'dian_invoice_number', 'sale_date'] }) : [],
      rows.length ? Customer.findAll({ where: { id: rows.map((r) => r.customer_id).filter(Boolean) }, attributes: ['id', 'first_name', 'last_name', 'business_name'] }) : [],
    ]);
    const acc = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
    const sale = new Map(sales.map((s) => [s.id, s]));
    const cust = new Map(customers.map((c) => [c.id, c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ')]));
    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r.toJSON(),
        liability_account: acc.get(r.liability_account_id),
        revenue_account: acc.get(r.revenue_account_id),
        sale_number: sale.get(r.sale_id)?.dian_invoice_number || sale.get(r.sale_id)?.sale_number,
        customer_name: cust.get(r.customer_id) || null,
        pending_amount: Math.round((Number(r.total_amount) - Number(r.amortized_amount)) * 100) / 100,
      })),
    });
  } catch (error) {
    logger.error(`Error listando ingresos diferidos: ${error.message}`);
    res.status(500).json({ success: false, message: 'Error listando los ingresos diferidos' });
  }
};

// POST /api/accounting/deferred-revenues/amortize -- { id? } (sin id: todos los vencidos)
exports.amortize = async (req, res) => {
  try {
    const results = await amortizeDue(req.tenant_id, { deferralId: req.body?.id || null, userId: req.user?.id });
    const entries = results.reduce((s, r) => s + (r.entries || 0), 0);
    const errors = results.filter((r) => r.error);
    res.json({
      success: true,
      message: entries ? `Se generaron ${entries} asiento(s) de amortización en borrador` : 'No había meses pendientes por amortizar',
      data: { entries, errors },
    });
  } catch (error) {
    logger.error(`Error amortizando ingresos diferidos: ${error.message}`);
    res.status(500).json({ success: false, message: 'Error amortizando los ingresos diferidos' });
  }
};
