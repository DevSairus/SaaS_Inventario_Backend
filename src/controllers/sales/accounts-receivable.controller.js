// backend/src/controllers/sales/accounts-receivable.controller.js
const { Sale, SaleItem, Customer, User, OpeningBalance } = require('../../models');
const { Op } = require('sequelize');
const { daysOverdueOf, receivableWhere } = require('../../utils/receivables');
const { saleBalance } = require('../../utils/saleAmounts');
const { normalizeOpeningBalanceAsSaleRow } = require('../../services/accounting/openingBalanceMerge.helper');
const { parsePagination, buildPagination } = require('../../utils/pagination');
const { sequelize } = require('../../config/database');

// Saldos iniciales de cartera (OpeningBalance 'receivable', registrados en
// Contabilidad → Saldos Iniciales) con el mismo shape que una venta. Antes
// existían en contabilidad pero no aparecían en Cuentas por Cobrar.
const pendingOpeningReceivables = async (tenantId, { customer_id, from_date, to_date } = {}) => {
  const where = {
    tenant_id: tenantId,
    type: 'receivable',
    status: 'active',
    payment_status: { [Op.in]: ['pending', 'partial'] },
  };
  if (customer_id) where.customer_id = customer_id === 'none' ? null : customer_id;
  if (from_date || to_date) {
    where.issue_date = {};
    if (from_date) where.issue_date[Op.gte] = from_date;
    if (to_date) where.issue_date[Op.lte] = to_date;
  }
  const rows = await OpeningBalance.findAll({
    where,
    include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'email', 'phone'] }],
    order: [['issue_date', 'ASC']],
  });
  return rows.map(normalizeOpeningBalanceAsSaleRow);
};

// Facturas/remisiones con saldo (más saldos iniciales) y su agrupación por
// cliente. El saldo se calcula en JS (saleBalance), así que los totales
// necesitan todo lo abierto; la paginación se aplica a lo que se envía.
// customer_id='none' = documentos sin cliente.
// Filtro de facturas/remisiones con saldo. customer_id='none' = sin cliente.
// search busca en cliente (nombre o NIT) y número del documento.
const pendingSalesWhere = (req) => {
  const { from_date, to_date, customer_id, search } = req.query;

  const where = {
    tenant_id: req.tenant_id,
    ...receivableWhere(req),
    status: { [Op.in]: ['pending', 'completed'] }, // pending = confirmada, completed = entregada
    payment_status: { [Op.in]: ['pending', 'partial'] } // Solo pendientes o parciales
  };

  if (customer_id) {
    where.customer_id = customer_id === 'none' ? null : customer_id;
  }

  if (from_date && to_date) {
    where.sale_date = { [Op.between]: [from_date, to_date] };
  } else if (from_date) {
    where.sale_date = { [Op.gte]: from_date };
  } else if (to_date) {
    where.sale_date = { [Op.lte]: to_date };
  }

  const term = String(search || '').trim();
  if (term) {
    where[Op.and] = [...(where[Op.and] || []), { [Op.or]: [
      { customer_name: { [Op.iLike]: `%${term}%` } },
      { sale_number: { [Op.iLike]: `%${term}%` } },
      { '$customer.tax_id$': { [Op.iLike]: `%${term}%` } },
    ] }];
  }
  return where;
};

// Saldos iniciales con el mismo filtro de búsqueda (son pocos: se cargan
// una vez al empezar a usar el sistema, así que se filtran en memoria).
const filteredOpeningReceivables = async (req) => {
  const { customer_id, from_date, to_date, search } = req.query;
  const rows = await pendingOpeningReceivables(req.tenant_id, { customer_id, from_date, to_date });
  const needle = String(search || '').toLowerCase().trim();
  if (!needle) return rows;
  return rows.filter(inv =>
    (inv.customer_name || '').toLowerCase().includes(needle) ||
    (inv.customer?.tax_id || '').toLowerCase().includes(needle) ||
    (inv.sale_number || '').toLowerCase().includes(needle)
  );
};

const CUSTOMER_INCLUDE = { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'tax_id', 'email', 'phone'] };
const RECEIVABLE_ATTRIBUTES = [
  'id', 'sale_number', 'sale_date', 'due_date', 'customer_id', 'customer_name', 'total_amount',
  'paid_amount', 'returned_amount', 'payment_status', 'payment_method', 'payment_history', 'document_type'
];

// Fila de cartera con saldo y días vencidos.
const toReceivableRow = (invoice, today = new Date()) => {
  // Neto de devoluciones aprobadas (returned_amount).
  const balance = saleBalance(invoice);
  const daysOverdue = daysOverdueOf(invoice, today);
  return {
    id: invoice.id,
    sale_number: invoice.sale_number,
    sale_date: invoice.sale_date,
    due_date: invoice.due_date,
    customer_id: invoice.customer_id,
    customer_name: invoice.customer_name,
    customer: invoice.customer,
    total_amount: parseFloat(invoice.total_amount),
    paid_amount: parseFloat(invoice.paid_amount || 0),
    returned_amount: parseFloat(invoice.returned_amount || 0),
    balance,
    payment_status: invoice.payment_status,
    payment_method: invoice.payment_method,
    days_overdue: Math.max(daysOverdue, 0),
    is_overdue: daysOverdue > 0,
    payment_history: invoice.payment_history || [],
    document_type: invoice.document_type,
    // Saldo inicial: se abona por /accounting/opening-balances/:id/payments.
    is_opening_balance: !!invoice.is_opening_balance
  };
};

const loadPendingReceivables = async (req) => {
  const tenantId = req.tenant_id;
  const { from_date, to_date, customer_id } = req.query;
  const where = pendingSalesWhere(req);

  // Obtener todas las facturas y remisiones pendientes
  const pendingInvoices = await Sale.findAll({
    where,
    include: [CUSTOMER_INCLUDE],
    order: [['sale_date', 'ASC']],
    attributes: RECEIVABLE_ATTRIBUTES,
  });
  pendingInvoices.push(...await pendingOpeningReceivables(tenantId, { customer_id, from_date, to_date }));

  // Calcular totales
  let totalReceivable = 0;
  let totalOverdue = 0;
  const today = new Date();

  const invoicesWithDetails = pendingInvoices.map(invoice => {
    const row = toReceivableRow(invoice, today);
    totalReceivable += row.balance;
    if (row.is_overdue) totalOverdue += row.balance;
    return row;
  });

  // Agrupar por cliente
  const byCustomer = {};
  invoicesWithDetails.forEach(invoice => {
    const customerId = invoice.customer_id || 'sin_cliente';
    if (!byCustomer[customerId]) {
      byCustomer[customerId] = {
        customer_id: invoice.customer_id,
        customer_name: invoice.customer_name,
        customer: invoice.customer,
        invoice_count: 0, // ✅ RENOMBRADO: total_invoices -> invoice_count para consistencia
        total_amount: 0, // ✅ AGREGADO: Total de todas las facturas/remisiones
        paid_amount: 0, // ✅ AGREGADO: Total pagado
        balance: 0, // ✅ RENOMBRADO: total_balance -> balance
        overdue_amount: 0, // ✅ RENOMBRADO: overdue_balance -> overdue_amount
        invoices: []
      };
    }
    byCustomer[customerId].invoice_count++;
    byCustomer[customerId].total_amount += parseFloat(invoice.total_amount);
    byCustomer[customerId].paid_amount += parseFloat(invoice.paid_amount);
    byCustomer[customerId].balance += invoice.balance;
    if (invoice.is_overdue) {
      byCustomer[customerId].overdue_amount += invoice.balance;
    }
    byCustomer[customerId].invoices.push(invoice);
  });

  return {
    summary: {
      total_receivable: totalReceivable,
      total_overdue: totalOverdue,
      total_invoices: pendingInvoices.length,
      total_customers: Object.keys(byCustomer).length
    },
    by_customer: Object.values(byCustomer),
    all_invoices: invoicesWithDetails
  };
};

// Mismas reglas que saleBalance y daysOverdueOf, en SQL para sumar sin traer
// la cartera a memoria. Con due_date (fecha) se vence al día siguiente; sin
// due_date, a los 31 días de la venta.
const SALE_BALANCE_SQL = `GREATEST(GREATEST("Sale"."total_amount" - COALESCE("Sale"."returned_amount", 0), 0) - COALESCE("Sale"."paid_amount", 0), 0)`;
const SALE_OVERDUE_SQL = `(CASE WHEN "Sale"."due_date" IS NOT NULL
  THEN NOW() >= ("Sale"."due_date"::timestamp AT TIME ZONE 'UTC') + INTERVAL '1 day'
  ELSE NOW() >= "Sale"."sale_date" + INTERVAL '31 days' END)`;

// Totales y agrupación por cliente: ventas sumadas en la base + saldos
// iniciales (pocos) sumados aquí.
const receivableTotalsByCustomer = async (req) => {
  const groups = await Sale.findAll({
    where: pendingSalesWhere(req),
    include: [{ ...CUSTOMER_INCLUDE, attributes: [] }],
    attributes: [
      'customer_id',
      [sequelize.literal(`(ARRAY_AGG("Sale"."customer_name" ORDER BY "Sale"."sale_date"))[1]`), 'customer_name'],
      [sequelize.fn('COUNT', sequelize.col('Sale.id')), 'invoice_count'],
      [sequelize.fn('SUM', sequelize.col('Sale.total_amount')), 'total_amount'],
      [sequelize.fn('SUM', sequelize.fn('COALESCE', sequelize.col('Sale.paid_amount'), 0)), 'paid_amount'],
      [sequelize.literal(`SUM(${SALE_BALANCE_SQL})`), 'balance'],
      [sequelize.literal(`SUM(CASE WHEN ${SALE_OVERDUE_SQL} THEN ${SALE_BALANCE_SQL} ELSE 0 END)`), 'overdue_amount'],
      [sequelize.fn('MIN', sequelize.col('Sale.sale_date')), 'first_date'],
    ],
    group: ['Sale.customer_id'],
    raw: true,
  });

  const byKey = new Map();
  const keyOf = (id) => id || 'sin_cliente';
  groups.forEach(g => byKey.set(keyOf(g.customer_id), {
    customer_id: g.customer_id,
    customer_name: g.customer_name,
    invoice_count: Number(g.invoice_count) || 0,
    total_amount: Number(g.total_amount) || 0,
    paid_amount: Number(g.paid_amount) || 0,
    balance: Number(g.balance) || 0,
    overdue_amount: Number(g.overdue_amount) || 0,
    first_date: new Date(g.first_date).getTime(),
  }));

  const today = new Date();
  (await filteredOpeningReceivables(req)).forEach(ob => {
    const row = toReceivableRow(ob, today);
    const key = keyOf(row.customer_id);
    if (!byKey.has(key)) {
      byKey.set(key, { customer_id: row.customer_id, customer_name: row.customer_name, invoice_count: 0, total_amount: 0, paid_amount: 0, balance: 0, overdue_amount: 0, first_date: Infinity });
    }
    const g = byKey.get(key);
    g.invoice_count += 1;
    g.total_amount += row.total_amount;
    g.paid_amount += row.paid_amount;
    g.balance += row.balance;
    if (row.is_overdue) g.overdue_amount += row.balance;
    g.first_date = Math.min(g.first_date, new Date(row.sale_date).getTime());
  });

  const customerIds = [...byKey.values()].map(g => g.customer_id).filter(Boolean);
  const customers = customerIds.length
    ? await Customer.findAll({ where: { id: customerIds }, attributes: CUSTOMER_INCLUDE.attributes })
    : [];
  const customerById = new Map(customers.map(c => [c.id, c]));

  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const byCustomer = [...byKey.values()]
    .sort((a, b) => a.first_date - b.first_date)
    .map(({ first_date, ...g }) => ({
      ...g,
      customer: g.customer_id ? customerById.get(g.customer_id) || null : null,
      total_amount: round2(g.total_amount),
      paid_amount: round2(g.paid_amount),
      balance: round2(g.balance),
      overdue_amount: round2(g.overdue_amount),
    }));

  return {
    summary: {
      total_receivable: round2(byCustomer.reduce((t, g) => t + g.balance, 0)),
      total_overdue: round2(byCustomer.reduce((t, g) => t + g.overdue_amount, 0)),
      total_invoices: byCustomer.reduce((t, g) => t + g.invoice_count, 0),
      total_customers: byCustomer.length
    },
    by_customer: byCustomer,
  };
};

// Obtener resumen de cartera
// GET /accounts-receivable/summary?from_date=&to_date=&customer_id=&lite=
// lite=true: totales y agrupación por cliente calculados en la base, sin los
// documentos (que se piden paginados a /accounts-receivable/documents). Sin
// lite (Dashboard, Reportes) se mantiene la respuesta completa de antes.
const getAccountsReceivableSummary = async (req, res) => {
  try {
    if (req.query.lite === 'true') {
      const { summary, by_customer } = await receivableTotalsByCustomer(req);
      return res.json({ success: true, data: { summary, by_customer } });
    }
    const { summary, by_customer, all_invoices } = await loadPendingReceivables(req);
    res.json({ success: true, data: { summary, by_customer, all_invoices } });
  } catch (error) {
    console.error('Error obteniendo cartera:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo cartera',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

// GET /accounts-receivable/documents?page=&limit=&search=&customer_id=&from_date=&to_date=
// Documentos con saldo pendiente, por fecha de venta. Las ventas se paginan
// en la base; los saldos iniciales (pocos) se intercalan por fecha: para la
// página N se toman las primeras N*limit ventas (solo id y fecha), se mezclan
// con los saldos iniciales y se corta la página.
const MAX_DEPTH = 10000;
const listReceivableDocuments = async (req, res) => {
  try {
    const pg = parsePagination(req.query);
    const depth = pg.offset + pg.limit;
    if (depth > MAX_DEPTH) {
      return res.status(400).json({ success: false, message: 'Página demasiado lejana: acota la búsqueda con un rango de fechas' });
    }
    const where = pendingSalesWhere(req);
    const keyInclude = [{ ...CUSTOMER_INCLUDE, attributes: [] }];
    const [saleKeys, saleTotal, openings] = await Promise.all([
      Sale.findAll({ where, include: keyInclude, attributes: ['id', 'sale_date'], order: [['sale_date', 'ASC'], ['id', 'ASC']], limit: depth, subQuery: false, raw: true }),
      Sale.count({ where, include: keyInclude }),
      filteredOpeningReceivables(req),
    ]);
    openings.sort((a, b) => new Date(a.sale_date) - new Date(b.sale_date));

    const merged = [];
    let i = 0;
    let j = 0;
    while (merged.length < depth && (i < saleKeys.length || j < openings.length)) {
      const s = saleKeys[i];
      const o = openings[j];
      if (s && (!o || new Date(s.sale_date) <= new Date(o.sale_date))) { merged.push({ id: s.id }); i++; }
      else { merged.push({ opening: o }); j++; }
    }
    const pageItems = merged.slice(pg.offset, depth);

    const saleIds = pageItems.filter(x => x.id).map(x => x.id);
    const sales = saleIds.length
      ? await Sale.findAll({ where: { id: saleIds }, include: [CUSTOMER_INCLUDE], attributes: RECEIVABLE_ATTRIBUTES })
      : [];
    const saleById = new Map(sales.map(sale => [sale.id, sale]));
    const today = new Date();
    const data = pageItems
      .map(x => (x.opening ? x.opening : saleById.get(x.id)))
      .filter(Boolean)
      .map(inv => toReceivableRow(inv, today));

    res.json({ success: true, data, pagination: buildPagination(pg, saleTotal + openings.length) });
  } catch (error) {
    console.error('Error listando cartera:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo cartera' });
  }
};

// Obtener cartera por cliente específico
const getCustomerAccountsReceivable = async (req, res) => {
  try {
    const { customerId } = req.params;
    const tenantId = req.tenant_id;

    const customer = await Customer.findOne({
      where: { id: customerId, tenant_id: tenantId }
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado'
      });
    }

    const invoices = await Sale.findAll({
      where: {
        tenant_id: tenantId,
        customer_id: customerId,
        ...receivableWhere(req),
        status: { [Op.in]: ['pending', 'completed'] }, // pending = confirmada, completed = entregada
        payment_status: { [Op.in]: ['pending', 'partial'] }
      },
      include: [
        {
          model: SaleItem,
          as: 'items',
          attributes: ['product_name', 'quantity', 'unit_price', 'total']
        }
      ],
      order: [['sale_date', 'DESC']]
    });
    invoices.push(...await pendingOpeningReceivables(tenantId, { customer_id: customerId }));

    let totalBalance = 0;
    let totalOverdue = 0;
    const today = new Date();

    const invoicesWithDetails = invoices.map(invoice => {
      const balance = saleBalance(invoice);
      const daysOverdue = daysOverdueOf(invoice, today);
      const isOverdue = daysOverdue > 0;

      totalBalance += balance;
      if (isOverdue) {
        totalOverdue += balance;
      }

      return {
        ...invoice.toJSON(),
        balance,
        days_overdue: Math.max(daysOverdue, 0),
        is_overdue: isOverdue
      };
    });

    res.json({
      success: true,
      data: {
        customer: {
          id: customer.id,
          name: `${customer.first_name} ${customer.last_name}`.trim(),
          tax_id: customer.tax_id,
          email: customer.email,
          phone: customer.phone
        },
        summary: {
          total_balance: totalBalance,
          total_overdue: totalOverdue,
          total_invoices: invoices.length
        },
        invoices: invoicesWithDetails
      }
    });
  } catch (error) {
    console.error('Error obteniendo cartera del cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo cartera del cliente',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

// Obtener historial de pagos de una factura
const getPaymentHistory = async (req, res) => {
  try {
    const { saleId } = req.params;
    const tenantId = req.tenant_id;

    const sale = await Sale.findOne({
      where: { id: saleId, tenant_id: tenantId },
      include: [
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'email', 'phone']
        }
      ]
    });

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    const balance = saleBalance(sale);
    const paymentHistory = sale.payment_history || [];

    // Enriquecer historial con información de usuarios (una sola query)
    const userIds = [...new Set(paymentHistory.map(p => p.user_id).filter(Boolean))];
    const users = userIds.length > 0
      ? await User.findAll({
          where: { id: userIds },
          attributes: ['id', 'first_name', 'last_name', 'email']
        })
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
        sale: {
          id: sale.id,
          sale_number: sale.sale_number,
          sale_date: sale.sale_date,
          customer_name: sale.customer_name,
          customer: sale.customer,
          total_amount: parseFloat(sale.total_amount),
          paid_amount: parseFloat(sale.paid_amount || 0),
          returned_amount: parseFloat(sale.returned_amount || 0),
          balance,
          payment_status: sale.payment_status
        },
        payment_history: enrichedHistory
      }
    });
  } catch (error) {
    console.error('Error obteniendo historial de pagos:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo historial de pagos',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

// Obtener reporte de antigüedad de saldos
const getAgingReport = async (req, res) => {
  try {
    const tenantId = req.tenant_id;

    const invoices = await Sale.findAll({
      where: {
        tenant_id: tenantId,
        ...receivableWhere(req),
        status: { [Op.in]: ['pending', 'completed'] }, // pending = confirmada, completed = entregada
        payment_status: { [Op.in]: ['pending', 'partial'] }
      },
      include: [
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'email', 'phone']
        }
      ],
      order: [['sale_date', 'ASC']]
    });
    invoices.push(...await pendingOpeningReceivables(tenantId));

    const today = new Date();
    const aging = {
      current: [], // 0-30 días
      days_31_60: [], // 31-60 días
      days_61_90: [], // 61-90 días
      over_90: [] // Más de 90 días
    };

    let totals = {
      current: 0,
      days_31_60: 0,
      days_61_90: 0,
      over_90: 0,
      total: 0
    };

    invoices.forEach(invoice => {
      const balance = saleBalance(invoice);
      const daysOverdue = daysOverdueOf(invoice, today);

      const invoiceData = {
        id: invoice.id,
        sale_number: invoice.sale_number,
        sale_date: invoice.sale_date,
        due_date: invoice.due_date,
        customer_id: invoice.customer_id,
        customer_name: invoice.customer_name,
        customer: invoice.customer,
        total_amount: parseFloat(invoice.total_amount),
        paid_amount: parseFloat(invoice.paid_amount || 0),
        balance,
        days_overdue: Math.max(daysOverdue, 0),
        document_type: invoice.document_type, // ✅ AGREGADO: Incluir tipo de documento
        is_opening_balance: !!invoice.is_opening_balance
      };

      totals.total += balance;

      if (daysOverdue <= 30) {
        aging.current.push(invoiceData);
        totals.current += balance;
      } else if (daysOverdue <= 60) {
        aging.days_31_60.push(invoiceData);
        totals.days_31_60 += balance;
      } else if (daysOverdue <= 90) {
        aging.days_61_90.push(invoiceData);
        totals.days_61_90 += balance;
      } else {
        aging.over_90.push(invoiceData);
        totals.over_90 += balance;
      }
    });

    res.json({
      success: true,
      data: {
        aging,
        totals,
        total_invoices: invoices.length
      }
    });
  } catch (error) {
    console.error('Error obteniendo reporte de antigüedad:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo reporte de antigüedad',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

module.exports = {
  getAccountsReceivableSummary,
  listReceivableDocuments,
  getCustomerAccountsReceivable,
  getPaymentHistory,
  getAgingReport
};