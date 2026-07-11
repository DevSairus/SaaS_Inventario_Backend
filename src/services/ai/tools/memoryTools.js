// backend/src/services/ai/tools/memoryTools.js
//
// Fase 3 del Asistente de IA: tool de MEMORIA DE PATRONES.
// Solo lectura — busca en el histórico de gastos marcados como recurrentes
// para que NEXA pueda recordar valores/proveedores habituales (arriendo,
// nómina, servicios) en vez de pedirle al usuario que los repita cada vez.

const { findRecurringExpensePattern } = require('../../finance/recurringExpense.service');

function formatCOP(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'find_recurring_expense_pattern',
      description:
        'Busca el gasto recurrente más reciente que coincida con una categoría y/o una palabra clave ' +
        '(ej. "arriendo", "nómina"). Úsala SIEMPRE antes de "propose_create_expense" cuando el usuario pida ' +
        'registrar un gasto que suene recurrente (arriendo, nómina, servicios públicos, etc.) — así puedes ' +
        'confirmarle el valor y proveedor habituales en vez de pedírselos de cero. Si no encuentra nada, ' +
        'simplemente pide los datos normalmente.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description:
              'Categoría a buscar: arriendo | servicios_publicos | nomina | mantenimiento | transporte | ' +
              'impuestos | marketing | insumos_oficina | seguros | honorarios | otro (opcional si das keyword)',
          },
          keyword: {
            type: 'string',
            description: 'Palabra clave para buscar en la descripción del gasto, ej. "arriendo bodega" (opcional si das category)',
          },
        },
        required: [],
      },
    },
  },
];

const TOOL_EXECUTORS = {
  find_recurring_expense_pattern: async (args, req) => {
    if (!args.category && !args.keyword) {
      return { success: false, message: 'Debes indicar category o keyword' };
    }

    const pattern = await findRecurringExpensePattern(req.tenant_id, {
      category: args.category || null,
      keyword: args.keyword || null,
    });

    if (!pattern) {
      return {
        success: true,
        data: { found: false, note: 'No hay un gasto recurrente previo que coincida — pide los datos normalmente.' },
      };
    }

    return {
      success: true,
      data: {
        found: true,
        description: pattern.description,
        category: pattern.category,
        total_amount: pattern.total_amount,
        total_amount_formatted: formatCOP(pattern.total_amount),
        payment_method: pattern.payment_method,
        supplier_id: pattern.supplier_id,
        supplier_name: pattern.supplier_name,
        branch_id: pattern.branch_id,
        last_expense_date: pattern.last_expense_date,
        note: `Última vez (${pattern.last_expense_date}, ${pattern.last_expense_number}) fue ${formatCOP(pattern.total_amount)}${pattern.supplier_name ? ` con ${pattern.supplier_name}` : ''}. Confírmale este valor al usuario antes de proponer el gasto — no lo registres en silencio si no dijo que fuera igual.`,
      },
    };
  },
};

module.exports = { TOOL_DEFINITIONS, TOOL_EXECUTORS };
