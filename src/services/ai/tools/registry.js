// backend/src/services/ai/tools/registry.js
//
// Fase 1 del Asistente de IA: SOLO LECTURA.
// Cada tool llama a un controller/servicio que YA EXISTE en Pitbox — no se
// duplica ninguna lógica de negocio ni se toca la base de datos directamente.
// El modelo de IA nunca decide tenant_id/branch_id: siempre vienen del
// request autenticado real (ver callControllerAsTool.js).
//
// Los controllers devuelven más detalle del que el modelo necesita (objetos
// de cliente/producto anidados repetidos, payment_history completo, todas
// las cuentas con movimiento, etc.) — cada executor recorta y aplana el
// resultado antes de devolverlo, mismo criterio que tools/payablesTools.js:
// nunca falsear el total/conteo, pero sí limitar el detalle listado para no
// inflar el prompt en cada llamada al modelo.

const { callControllerAsTool } = require('../callControllerAsTool');

const financialReportsCtrl = require('../../../controllers/accounting/financialReports.controller');
const accountsReceivableCtrl = require('../../../controllers/sales/accounts-receivable.controller');
const expensesCtrl = require('../../../controllers/finance/expenses.controller');
const { buildCashFlow } = require('../../../controllers/finance/cashflow.controller');
const stockAlertsCtrl = require('../../../controllers/stockAlerts.controller');

const MAX_ACCOUNTS = 150;
const MAX_PER_AGING_BUCKET = 15;
const MAX_STOCK_ALERTS = 30;

// rows puede traer distintos campos numéricos según el reporte (balance de
// comprobación: total_debit/total_credit; balance general: + balance;
// estado de resultados: total) — solo se copian los que de verdad vienen,
// para no inyectar NaN/undefined en el JSON que lee el modelo.
function trimAccounts(rows) {
  const total = rows.length;
  return {
    total,
    accounts: rows.slice(0, MAX_ACCOUNTS).map((r) => {
      const account = { code: r.code, name: r.name, account_type: r.account_type };
      if (r.total_debit !== undefined) account.total_debit = Number(r.total_debit);
      if (r.total_credit !== undefined) account.total_credit = Number(r.total_credit);
      if (r.balance !== undefined) account.balance = Number(r.balance);
      if (r.total !== undefined) account.total = Number(r.total);
      return account;
    }),
    truncated: total > MAX_ACCOUNTS,
    truncated_note: total > MAX_ACCOUNTS ? `Se muestran ${MAX_ACCOUNTS} de ${total} cuentas — los totales sí son exactos.` : undefined,
  };
}

function trimInvoice(inv) {
  return {
    id: inv.id,
    sale_number: inv.sale_number,
    sale_date: inv.sale_date,
    due_date: inv.due_date,
    customer_name: inv.customer_name,
    total_amount: inv.total_amount,
    paid_amount: inv.paid_amount,
    balance: inv.balance,
    days_overdue: inv.days_overdue,
    is_overdue: inv.is_overdue,
    document_type: inv.document_type,
  };
}

// ── Definiciones en formato OpenAI/Groq function calling ──────────────────
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_trial_balance',
      description:
        'Obtiene el balance de comprobación (movimientos débito/crédito por cuenta contable) en un rango de fechas. Útil para preguntas sobre saldos de cuentas, cuadre contable, o "cómo va la contabilidad".',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Fecha inicial YYYY-MM-DD' },
          to: { type: 'string', description: 'Fecha final YYYY-MM-DD' },
          branch_id: { type: 'string', description: 'UUID de sede (opcional, si no se da consolida todas las sedes)' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_balance_general',
      description:
        'Obtiene el Balance General (activos, pasivos, patrimonio) a una fecha de corte específica.',
      parameters: {
        type: 'object',
        properties: {
          as_of: { type: 'string', description: 'Fecha de corte YYYY-MM-DD (default: hoy)' },
          branch_id: { type: 'string', description: 'UUID de sede (opcional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_income_statement',
      description:
        'Obtiene el Estado de Resultados (ingresos, costos, gastos, utilidad) en un rango de fechas.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Fecha inicial YYYY-MM-DD' },
          to: { type: 'string', description: 'Fecha final YYYY-MM-DD' },
          branch_id: { type: 'string', description: 'UUID de sede (opcional)' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_accounts_receivable_summary',
      description:
        'Obtiene el resumen general de cartera (cuentas por cobrar): total por cobrar, cuánto está vencido, etc.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_accounts_receivable_aging',
      description:
        'Obtiene el reporte de antigüedad de saldos de cartera (0-30, 31-60, 61-90, +90 días de vencido), agrupado por cliente. Útil para "qué clientes están vencidos" o "quién me debe hace más tiempo".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expenses_summary',
      description: 'Obtiene el resumen de gastos registrados (por categoría, por sede) en un rango de fechas.',
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'Fecha inicial YYYY-MM-DD' },
          to_date: { type: 'string', description: 'Fecha final YYYY-MM-DD' },
          branch_id: { type: 'string', description: 'UUID de sede (opcional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cashflow_summary',
      description:
        'Obtiene el flujo de caja (entradas y salidas de dinero por ventas, compras y gastos) en un rango de fechas.',
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'Fecha inicial YYYY-MM-DD' },
          to_date: { type: 'string', description: 'Fecha final YYYY-MM-DD' },
          branch_id: { type: 'string', description: 'UUID de sede (opcional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_alerts',
      description:
        'Obtiene las alertas de inventario activas (stock bajo, agotado, etc.). Útil para "qué productos se están acabando".',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filtro de estado: active | resolved | ignored (default: active)' },
        },
        required: [],
      },
    },
  },
];

// ── Ejecutores: mapean cada tool_name a la llamada real y recortan la respuesta ──
const TOOL_EXECUTORS = {
  get_trial_balance: async (args, req) => {
    const result = await callControllerAsTool(financialReportsCtrl.trialBalance, req, {
      query: { from: args.from, to: args.to, branch_id: args.branch_id },
    });
    return { success: true, data: { ...trimAccounts(result.data.accounts), totals: result.data.totals, from: args.from, to: args.to } };
  },

  get_balance_general: async (args, req) => {
    const result = await callControllerAsTool(financialReportsCtrl.balanceGeneral, req, {
      query: { as_of: args.as_of, branch_id: args.branch_id },
    });
    const { activo, pasivo, patrimonio, resultado_no_cerrado, totales, as_of } = result.data;
    return {
      success: true,
      data: {
        as_of,
        activo: trimAccounts(activo),
        pasivo: trimAccounts(pasivo),
        patrimonio: trimAccounts(patrimonio),
        resultado_no_cerrado,
        totales,
      },
    };
  },

  get_income_statement: async (args, req) => {
    const result = await callControllerAsTool(financialReportsCtrl.incomeStatement, req, {
      query: { from: args.from, to: args.to, branch_id: args.branch_id },
    });
    const { ingresos, costos, gastos, totales, from, to } = result.data;
    return {
      success: true,
      data: {
        from,
        to,
        ingresos: trimAccounts(ingresos),
        costos: trimAccounts(costos),
        gastos: trimAccounts(gastos),
        totales,
      },
    };
  },

  get_accounts_receivable_summary: async (args, req) => {
    const result = await callControllerAsTool(accountsReceivableCtrl.getAccountsReceivableSummary, req, { query: {} });
    const { summary, by_customer } = result.data;
    const MAX_CUSTOMERS = 20;
    const customers = by_customer
      .map(({ invoices, customer, ...rest }) => rest) // el detalle de facturas ya va aparte, y el objeto customer completo no aporta al resumen
      .sort((a, b) => b.balance - a.balance);

    return {
      success: true,
      data: {
        summary,
        by_customer: customers.slice(0, MAX_CUSTOMERS),
        by_customer_truncated: customers.length > MAX_CUSTOMERS,
      },
    };
  },

  get_accounts_receivable_aging: async (args, req) => {
    const result = await callControllerAsTool(accountsReceivableCtrl.getAgingReport, req, { query: {} });
    const { aging, totals, total_invoices } = result.data;
    const trimBucket = (bucket) => bucket.slice(0, MAX_PER_AGING_BUCKET).map(trimInvoice);

    return {
      success: true,
      data: {
        totals,
        total_invoices,
        aging: {
          current: trimBucket(aging.current),
          days_31_60: trimBucket(aging.days_31_60),
          days_61_90: trimBucket(aging.days_61_90),
          over_90: trimBucket(aging.over_90),
        },
        truncated_note: `Cada rango muestra hasta ${MAX_PER_AGING_BUCKET} facturas; los totales por rango sí son exactos aunque la lista se recorte.`,
      },
    };
  },

  get_expenses_summary: (args, req) =>
    callControllerAsTool(expensesCtrl.getExpensesSummary, req, {
      query: { from_date: args.from_date, to_date: args.to_date, branch_id: args.branch_id },
    }),

  get_cashflow_summary: async (args, req) => {
    // buildCashFlow ya es una función pura (tenant_id, filtros) -> datos,
    // no necesita pasar por callControllerAsTool.
    const data = await buildCashFlow(req.tenant_id, {
      from_date: args.from_date,
      to_date: args.to_date,
      branch_id: args.branch_id,
    });
    return {
      success: true,
      data: {
        summary: data.summary,
        by_day: data.by_day,
        transactions: data.transactions.slice(0, 30), // el asistente no necesita el detalle completo
      },
    };
  },

  get_stock_alerts: async (args, req) => {
    const result = await callControllerAsTool(stockAlertsCtrl.getStockAlerts, req, {
      query: { status: args.status || 'active', limit: MAX_STOCK_ALERTS },
    });
    const alerts = result.data.map((a) => ({
      product_name: a.product?.name,
      sku: a.product?.sku,
      alert_type: a.alert_type,
      severity: a.severity,
      current_stock: a.current_stock,
      min_stock: a.min_stock,
      max_stock: a.max_stock,
    }));

    return {
      success: true,
      data: {
        total: result.pagination?.total ?? alerts.length,
        alerts,
        truncated: (result.pagination?.total ?? alerts.length) > alerts.length,
      },
    };
  },
};

module.exports = { TOOL_DEFINITIONS, TOOL_EXECUTORS };
