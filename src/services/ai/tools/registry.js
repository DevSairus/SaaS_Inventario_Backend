// backend/src/services/ai/tools/registry.js
//
// Fase 1 del Asistente de IA: SOLO LECTURA.
// Cada tool llama a un controller/servicio que YA EXISTE en Pitbox — no se
// duplica ninguna lógica de negocio ni se toca la base de datos directamente.
// El modelo de IA nunca decide tenant_id/branch_id: siempre vienen del
// request autenticado real (ver callControllerAsTool.js).

const { callControllerAsTool } = require('../callControllerAsTool');

const financialReportsCtrl = require('../../../controllers/accounting/financialReports.controller');
const accountsReceivableCtrl = require('../../../controllers/sales/accounts-receivable.controller');
const expensesCtrl = require('../../../controllers/finance/expenses.controller');
const { buildCashFlow } = require('../../../controllers/finance/cashflow.controller');
const stockAlertsCtrl = require('../../../controllers/stockAlerts.controller');

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

// ── Ejecutores: mapean cada tool_name a la llamada real ────────────────────
const TOOL_EXECUTORS = {
  get_trial_balance: (args, req) =>
    callControllerAsTool(financialReportsCtrl.trialBalance, req, {
      query: { from: args.from, to: args.to, branch_id: args.branch_id },
    }),

  get_balance_general: (args, req) =>
    callControllerAsTool(financialReportsCtrl.balanceGeneral, req, {
      query: { as_of: args.as_of, branch_id: args.branch_id },
    }),

  get_income_statement: (args, req) =>
    callControllerAsTool(financialReportsCtrl.incomeStatement, req, {
      query: { from: args.from, to: args.to, branch_id: args.branch_id },
    }),

  get_accounts_receivable_summary: (args, req) =>
    callControllerAsTool(accountsReceivableCtrl.getAccountsReceivableSummary, req, { query: {} }),

  get_accounts_receivable_aging: (args, req) =>
    callControllerAsTool(accountsReceivableCtrl.getAgingReport, req, { query: {} }),

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

  get_stock_alerts: (args, req) =>
    callControllerAsTool(stockAlertsCtrl.getStockAlerts, req, {
      query: { status: args.status || 'active' },
    }),
};

module.exports = { TOOL_DEFINITIONS, TOOL_EXECUTORS };
