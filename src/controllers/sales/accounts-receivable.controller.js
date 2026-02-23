// backend/src/controllers/sales/accounts-receivable.controller.js
const { Sale, SaleItem, Customer, User } = require('../../models');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');

// Obtener resumen de cartera
const getAccountsReceivableSummary = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { from_date, to_date, customer_id } = req.query;

    const where = {
      tenant_id: tenantId,
      document_type: { [Op.in]: ['factura', 'remision'] }, // Facturas Y remisiones
      status: { [Op.in]: ['pending', 'completed'] }, // pending = confirmada, completed = entregada
      payment_status: { [Op.in]: ['pending', 'partial'] } // Solo pendientes o parciales
    };

    if (customer_id) {
      where.customer_id = customer_id;
    }

    if (from_date && to_date) {
      where.sale_date = { [Op.between]: [from_date, to_date] };
    } else if (from_date) {
      where.sale_date = { [Op.gte]: from_date };
    } else if (to_date) {
      where.sale_date = { [Op.lte]: to_date };
    }

    // Obtener todas las facturas y remisiones pendientes
    const pendingInvoices = await Sale.findAll({
      where,
      include: [
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'tax_id', 'email', 'phone']
        }
      ],
      order: [['sale_date', 'ASC']],
      attributes: [
        'id',
        'sale_number',
        'sale_date',
        'customer_id',
        'customer_name',
        'total_amount',
        'paid_amount',
        'payment_status',
        'payment_method',
        'payment_history',
        'document_type' // ✅ AGREGADO: Incluir tipo de documento
      ]
    });

    // Calcular totales
    let totalReceivable = 0;
    let totalOverdue = 0;
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const invoicesWithDetails = pendingInvoices.map(invoice => {
      const balance = parseFloat(invoice.total_amount) - parseFloat(invoice.paid_amount || 0);
      const daysOverdue = Math.floor((today - new Date(invoice.sale_date)) / (1000 * 60 * 60 * 24));
      const isOverdue = daysOverdue > 30;

      totalReceivable += balance;
      if (isOverdue) {
        totalOverdue += balance;
      }

      return {
        id: invoice.id,
        sale_number: invoice.sale_number,
        sale_date: invoice.sale_date,
        customer_id: invoice.customer_id,
        customer_name: invoice.customer_name,
        customer: invoice.customer,
        total_amount: parseFloat(invoice.total_amount),
        paid_amount: parseFloat(invoice.paid_amount || 0),
        balance,
        payment_status: invoice.payment_status,
        payment_method: invoice.payment_method,
        days_overdue: daysOverdue,
        is_overdue: isOverdue,
        payment_history: invoice.payment_history || [],
        document_type: invoice.document_type // ✅ AGREGADO: Incluir tipo de documento
      };
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

    res.json({
      success: true,
      data: {
        summary: {
          total_receivable: totalReceivable,
          total_overdue: totalOverdue,
          total_invoices: pendingInvoices.length,
          total_customers: Object.keys(byCustomer).length
        },
        by_customer: Object.values(byCustomer),
        all_invoices: invoicesWithDetails
      }
    });
  } catch (error) {
    console.error('Error obteniendo cartera:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo cartera',
      error: error.message
    });
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
        document_type: { [Op.in]: ['factura', 'remision'] }, // ✅ CAMBIO: Incluir facturas Y remisiones
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

    let totalBalance = 0;
    let totalOverdue = 0;
    const today = new Date();

    const invoicesWithDetails = invoices.map(invoice => {
      const balance = parseFloat(invoice.total_amount) - parseFloat(invoice.paid_amount || 0);
      const daysOverdue = Math.floor((today - new Date(invoice.sale_date)) / (1000 * 60 * 60 * 24));
      const isOverdue = daysOverdue > 30;

      totalBalance += balance;
      if (isOverdue) {
        totalOverdue += balance;
      }

      return {
        ...invoice.toJSON(),
        balance,
        days_overdue: daysOverdue,
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
      error: error.message
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

    const balance = parseFloat(sale.total_amount) - parseFloat(sale.paid_amount || 0);
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
      error: error.message
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
        document_type: { [Op.in]: ['factura', 'remision'] }, // ✅ CAMBIO: Incluir facturas Y remisiones
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
      const balance = parseFloat(invoice.total_amount) - parseFloat(invoice.paid_amount || 0);
      const daysOverdue = Math.floor((today - new Date(invoice.sale_date)) / (1000 * 60 * 60 * 24));

      const invoiceData = {
        id: invoice.id,
        sale_number: invoice.sale_number,
        sale_date: invoice.sale_date,
        customer_id: invoice.customer_id,
        customer_name: invoice.customer_name,
        customer: invoice.customer,
        total_amount: parseFloat(invoice.total_amount),
        paid_amount: parseFloat(invoice.paid_amount || 0),
        balance,
        days_overdue: daysOverdue,
        document_type: invoice.document_type // ✅ AGREGADO: Incluir tipo de documento
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
      error: error.message
    });
  }
};

module.exports = {
  getAccountsReceivableSummary,
  getCustomerAccountsReceivable,
  getPaymentHistory,
  getAgingReport
};