// backend/src/services/ai/tools/payablesTools.js
//
// Fase 3 del Asistente de IA (§2 del plan): consultas de cartera por pagar
// (cuentas por pagar a proveedores) y contexto contable general que hoy no
// tenían tool. Mismo patrón que registry.js (Fase 1) — solo lectura, cada
// tool reusa un controller que YA EXISTE, vía callControllerAsTool. No se
// toca AiProposal porque nada de esto escribe datos.
//
// Los controllers devuelven a veces más detalle del que el modelo necesita
// (objetos de proveedor anidados repetidos, payment_history completo,
// hasta 200 asientos, etc.) — cada executor recorta y aplana el resultado
// antes de devolverlo, siguiendo el mismo criterio que get_cashflow_summary
// y find_missing_journal_entries: nunca falsear el total/conteo, pero sí
// limitar el detalle listado para no inflar el prompt.

const { callControllerAsTool } = require('../callControllerAsTool');

const accountsPayableCtrl = require('../../../controllers/inventory/accountsPayable.controller');
const chartOfAccountsCtrl = require('../../../controllers/accounting/chartOfAccounts.controller');
const journalEntriesCtrl = require('../../../controllers/accounting/journalEntries.controller');

function formatCOP(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

// ── Definiciones en formato OpenAI/Groq function calling ──────────────────
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_accounts_payable_summary',
      description:
        'Obtiene el resumen general de cuentas por pagar (lo que la empresa le debe a sus proveedores): total ' +
        'por pagar, cuánto está vencido, y el detalle por proveedor. Útil para "¿cuánto le debemos a proveedores?" ' +
        'o "¿cómo va la cartera con proveedores?". Puede filtrarse por rango de fechas de compra, proveedor o sede.',
      parameters: {
        type: 'object',
        properties: {
          from_date: { type: 'string', description: 'Fecha inicial de compra YYYY-MM-DD (opcional)' },
          to_date: { type: 'string', description: 'Fecha final de compra YYYY-MM-DD (opcional)' },
          supplier_id: { type: 'string', description: 'UUID del proveedor, para filtrar solo ese (opcional)' },
          branch_id: { type: 'string', description: 'UUID de sede (opcional, si no se da consolida todas las sedes)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_supplier_payable_detail',
      description:
        'Obtiene el detalle de lo que se le debe a UN proveedor específico: sus compras pendientes o parciales, ' +
        'monto, saldo y días de vencimiento de cada una. Úsala cuando el usuario pregunte "¿qué le debo a ' +
        '[proveedor]?" y ya tengas o puedas ubicar el UUID del proveedor (ej. a partir de get_accounts_payable_summary).',
      parameters: {
        type: 'object',
        properties: {
          supplier_id: { type: 'string', description: 'UUID del proveedor' },
        },
        required: ['supplier_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_payable_aging',
      description:
        'Obtiene el reporte de antigüedad de cuentas por pagar (0-30, 31-60, 61-90, +90 días de vencido), ' +
        'agrupado por rango, con el proveedor de cada compra. Es el espejo, del lado de proveedores, del reporte ' +
        'de cartera por cobrar. Útil para "¿qué le debemos hace más tiempo?" o "¿qué tan atrasados estamos con proveedores?".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_chart_of_accounts',
      description:
        'Obtiene el plan de cuentas contable de la empresa (código, nombre y tipo de cada cuenta: activo, ' +
        'pasivo, patrimonio, ingreso, gasto o costo). Es contexto interno más que una pregunta típica de usuario — ' +
        'úsala para traducir códigos de cuenta a nombres legibles cuando expliques un balance de comprobación, ' +
        'un balance general o un asiento, no como respuesta directa salvo que el usuario pida explícitamente ' +
        'ver el plan de cuentas.',
      parameters: {
        type: 'object',
        properties: {
          account_type: {
            type: 'string',
            description: 'Filtrar por tipo: activo | pasivo | patrimonio | ingreso | gasto | costo (opcional)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_journal_entries',
      description:
        'Lista asientos contables (Libro Diario), filtrables por estado (draft/posted/voided), tipo de origen ' +
        '(venta/compra/gasto/cierre de caja/manual/ajuste) y rango de fechas. Útil para "¿qué asientos quedaron ' +
        'en borrador?", "¿qué se contabilizó esta semana?" o para ubicar el asiento de un movimiento puntual.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'draft | posted | voided (opcional, si no se da trae todos)' },
          source_type: { type: 'string', description: 'sale | purchase | expense | cash_session | manual | adjustment (opcional)' },
          from: { type: 'string', description: 'Fecha inicial YYYY-MM-DD (opcional)' },
          to: { type: 'string', description: 'Fecha final YYYY-MM-DD (opcional)' },
          branch_id: { type: 'string', description: 'UUID de sede (opcional, si no se da consolida todas las sedes)' },
        },
        required: [],
      },
    },
  },
];

// ── Ejecutores: llaman al controller real y recortan la respuesta ─────────
const TOOL_EXECUTORS = {
  get_accounts_payable_summary: async (args, req) => {
    const result = await callControllerAsTool(accountsPayableCtrl.getAccountsPayableSummary, req, {
      query: {
        from_date: args.from_date,
        to_date: args.to_date,
        supplier_id: args.supplier_id,
        branch_id: args.branch_id,
      },
    });

    const { summary, by_supplier, all_purchases } = result.data;
    const MAX_SUPPLIERS = 20;
    const MAX_PURCHASES = 30;

    const suppliers = by_supplier
      .map(({ purchases, supplier, ...rest }) => rest) // el detalle de compras ya va aparte en `purchases`
      .sort((a, b) => b.balance - a.balance);

    const purchases = all_purchases.map(({ supplier, payment_history, ...rest }) => rest);

    return {
      success: true,
      data: {
        summary: { ...summary, total_payable_formatted: formatCOP(summary.total_payable), total_overdue_formatted: formatCOP(summary.total_overdue) },
        by_supplier: suppliers.slice(0, MAX_SUPPLIERS),
        by_supplier_truncated: suppliers.length > MAX_SUPPLIERS,
        purchases: purchases.slice(0, MAX_PURCHASES),
        purchases_truncated: purchases.length > MAX_PURCHASES,
      },
    };
  },

  get_supplier_payable_detail: async (args, req) => {
    if (!args.supplier_id) {
      return { success: false, message: 'Debes indicar supplier_id' };
    }

    const result = await callControllerAsTool(accountsPayableCtrl.getSupplierAccountsPayable, req, {
      params: { supplierId: args.supplier_id },
    });

    const { supplier, summary, purchases } = result.data;
    const MAX_PURCHASES = 30;

    const trimmedPurchases = purchases.map((p) => ({
      id: p.id,
      purchase_number: p.purchase_number,
      purchase_date: p.purchase_date,
      due_date: p.due_date,
      invoice_number: p.invoice_number,
      total_amount: p.total_amount,
      paid_amount: p.paid_amount,
      balance: p.balance,
      payment_status: p.payment_status,
      days_overdue: p.days_overdue,
      is_overdue: p.is_overdue,
    }));

    return {
      success: true,
      data: {
        supplier,
        summary: { ...summary, total_balance_formatted: formatCOP(summary.total_balance), total_overdue_formatted: formatCOP(summary.total_overdue) },
        purchases: trimmedPurchases.slice(0, MAX_PURCHASES),
        purchases_truncated: trimmedPurchases.length > MAX_PURCHASES,
      },
    };
  },

  get_payable_aging: async (args, req) => {
    const result = await callControllerAsTool(accountsPayableCtrl.getAgingReport, req, { query: {} });
    const { aging, totals, total_purchases } = result.data;

    const MAX_PER_BUCKET = 15;
    const trimBucket = (bucket) =>
      bucket.slice(0, MAX_PER_BUCKET).map((p) => ({
        id: p.id,
        purchase_number: p.purchase_number,
        purchase_date: p.purchase_date,
        supplier_name: p.supplier?.name || 'Sin proveedor',
        balance: p.balance,
        days_overdue: p.days_overdue,
      }));

    return {
      success: true,
      data: {
        totals: {
          ...totals,
          total_formatted: formatCOP(totals.total),
          current_formatted: formatCOP(totals.current),
          days_31_60_formatted: formatCOP(totals.days_31_60),
          days_61_90_formatted: formatCOP(totals.days_61_90),
          over_90_formatted: formatCOP(totals.over_90),
        },
        total_purchases,
        aging: {
          current: trimBucket(aging.current),
          days_31_60: trimBucket(aging.days_31_60),
          days_61_90: trimBucket(aging.days_61_90),
          over_90: trimBucket(aging.over_90),
        },
        truncated_note:
          'Cada rango muestra hasta 15 compras; los totales por rango sí son exactos aunque la lista se recorte.',
      },
    };
  },

  get_chart_of_accounts: async (args, req) => {
    const result = await callControllerAsTool(chartOfAccountsCtrl.list, req, { query: {} });
    let accounts = result.data
      .filter((a) => a.is_active)
      .map((a) => ({
        code: a.code,
        name: a.name,
        account_type: a.account_type,
        level: a.level,
        accepts_entries: a.accepts_entries,
      }));

    if (args.account_type) {
      accounts = accounts.filter((a) => a.account_type === args.account_type);
    }

    // chartOfAccounts.controller.js#list no filtra server-side — trae todas
    // las cuentas activas del tenant. Un plan de cuentas normal tiene pocas
    // decenas de filas, pero si algún tenant termina con uno muy detallado
    // (subcuentas por sede, por ejemplo) se recorta acá para no inflar el
    // prompt, igual que el resto de tools de este archivo. El total sí es exacto.
    const MAX_ACCOUNTS = 150;
    const total = accounts.length;

    return {
      success: true,
      data: {
        total,
        accounts: accounts.slice(0, MAX_ACCOUNTS),
        truncated: total > MAX_ACCOUNTS,
        truncated_note:
          total > MAX_ACCOUNTS
            ? `Se muestran ${MAX_ACCOUNTS} de ${total} cuentas — filtra por account_type para acotar.`
            : undefined,
      },
    };
  },

  get_journal_entries: async (args, req) => {
    const result = await callControllerAsTool(journalEntriesCtrl.list, req, {
      query: {
        status: args.status,
        source_type: args.source_type,
        from: args.from,
        to: args.to,
        branch_id: args.branch_id,
      },
    });

    const MAX_ENTRIES = 30;
    const entries = result.data.map((e) => ({
      id: e.id,
      entry_number: e.entry_number,
      entry_date: e.entry_date,
      source_type: e.source_type,
      source_id: e.source_id,
      description: e.description,
      status: e.status,
      total_debit: e.total_debit,
      total_credit: e.total_credit,
    }));

    return {
      success: true,
      data: {
        total_found: entries.length,
        entries: entries.slice(0, MAX_ENTRIES),
        truncated: entries.length > MAX_ENTRIES,
        note:
          entries.length > MAX_ENTRIES
            ? `Se muestran los ${MAX_ENTRIES} más recientes de ${entries.length} encontrados — pide un rango de fechas más corto si necesitas ver el resto.`
            : undefined,
      },
    };
  },
};

module.exports = { TOOL_DEFINITIONS, TOOL_EXECUTORS };