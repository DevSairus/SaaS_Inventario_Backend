// backend/src/services/ai/tools/writeTools.js
//
// Fase 2 del Asistente de IA: tools de ESCRITURA.
// A diferencia de registry.js (Fase 1, solo lectura), estas tools NO llaman
// al controller real. Lo único que hacen es crear una fila en `ai_proposals`
// con status 'pending' y devolverle al modelo un resumen de lo que preparó.
//
// La escritura real solo ocurre cuando un humano con el rol adecuado aprueba
// la propuesta desde la pantalla de Aprobaciones NEXA (ver
// controllers/ai/aiProposals.controller.js + services/ai/proposalExecutor.js).
// El modelo de IA NUNCA puede aprobar sus propias propuestas.

const { AiProposal, Expense } = require('../../../models');
const expensesCtrl = require('../../../controllers/finance/expenses.controller');

function formatCOP(amount) {
  const n = Number(amount) || 0;
  return `$${n.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

// ── Definiciones en formato OpenAI/Groq function calling ──────────────────
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'propose_create_expense',
      description:
        'Prepara una PROPUESTA para registrar un nuevo gasto (arriendo, servicios públicos, nómina, etc). ' +
        'IMPORTANTE: esto NO registra el gasto de inmediato — solo deja una propuesta pendiente de aprobación ' +
        'humana en la pantalla de Aprobaciones NEXA. Úsala cuando el usuario te pida explícitamente registrar, ' +
        'crear o guardar un gasto.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description:
              'Categoría del gasto: arriendo | servicios_publicos | nomina | mantenimiento | transporte | ' +
              'impuestos | marketing | insumos_oficina | seguros | honorarios | otro',
          },
          description: { type: 'string', description: 'Descripción breve del gasto' },
          total_amount: { type: 'number', description: 'Monto total del gasto en pesos colombianos' },
          expense_date: { type: 'string', description: 'Fecha del gasto YYYY-MM-DD (default: hoy)' },
          due_date: { type: 'string', description: 'Fecha de vencimiento YYYY-MM-DD (opcional)' },
          supplier_id: { type: 'string', description: 'UUID del proveedor asociado (opcional)' },
          payment_method: { type: 'string', description: 'Método de pago, ej. Efectivo, Transferencia (opcional)' },
          branch_id: { type: 'string', description: 'UUID de la sede (opcional, default: sede activa)' },
          paid_now: { type: 'boolean', description: 'true si el gasto ya se pagó por completo al registrarlo' },
          notes: { type: 'string', description: 'Notas adicionales (opcional)' },
        },
        required: ['category', 'description', 'total_amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_register_expense_payment',
      description:
        'Prepara una PROPUESTA para registrar un abono/pago sobre un gasto ya existente que está pendiente o ' +
        'parcialmente pagado. IMPORTANTE: esto NO registra el pago de inmediato — solo deja una propuesta ' +
        'pendiente de aprobación humana en la pantalla de Aprobaciones NEXA.',
      parameters: {
        type: 'object',
        properties: {
          expense_id: { type: 'string', description: 'UUID del gasto sobre el cual se abona' },
          amount: { type: 'number', description: 'Monto a abonar en pesos colombianos' },
          payment_method: { type: 'string', description: 'Método de pago (opcional)' },
          payment_date: { type: 'string', description: 'Fecha del pago YYYY-MM-DD (opcional, default: hoy)' },
          notes: { type: 'string', description: 'Notas adicionales (opcional)' },
        },
        required: ['expense_id', 'amount'],
      },
    },
  },
];

// ── Ejecutores: SIEMPRE crean una propuesta, nunca escriben datos reales ───
const TOOL_EXECUTORS = {
  propose_create_expense: async (args, req) => {
    if (!expensesCtrl.CATEGORIES.includes(args.category)) {
      return {
        success: false,
        message: `Categoría inválida. Debe ser una de: ${expensesCtrl.CATEGORIES.join(', ')}`,
      };
    }
    if (!args.description || !args.total_amount || Number(args.total_amount) <= 0) {
      return { success: false, message: 'Descripción y monto (mayor a 0) son obligatorios' };
    }

    const payload = {
      category: args.category,
      description: args.description,
      total_amount: Number(args.total_amount),
      expense_date: args.expense_date || null,
      due_date: args.due_date || null,
      supplier_id: args.supplier_id || null,
      payment_method: args.payment_method || null,
      branch_id: args.branch_id || req.branch_id || null,
      paid_now: !!args.paid_now,
      notes: args.notes || null,
    };

    const summary = `Registrar gasto "${args.description}" por ${formatCOP(args.total_amount)} (categoría: ${args.category})`;

    const proposal = await AiProposal.create({
      tenant_id: req.tenant_id,
      conversation_id: req.ai_conversation_id || null,
      created_by: req.user.id,
      branch_id: payload.branch_id,
      action_type: 'create_expense',
      summary,
      payload,
    });

    return {
      success: true,
      data: {
        proposal_id: proposal.id,
        status: 'pending',
        summary,
        note: 'Esta propuesta quedó pendiente de aprobación humana en la pantalla de Aprobaciones NEXA. No se ha registrado nada todavía.',
      },
    };
  },

  propose_register_expense_payment: async (args, req) => {
    if (!args.expense_id || !args.amount || Number(args.amount) <= 0) {
      return { success: false, message: 'expense_id y un monto mayor a 0 son obligatorios' };
    }

    const expense = await Expense.findOne({ where: { id: args.expense_id, tenant_id: req.tenant_id } });
    if (!expense) {
      return { success: false, message: 'No encontré ese gasto en esta empresa' };
    }

    const remaining = Number(expense.total_amount) - Number(expense.paid_amount || 0);
    if (remaining <= 0) {
      return { success: false, message: `El gasto ${expense.expense_number} ya está pagado en su totalidad` };
    }

    const payload = {
      expense_id: expense.id,
      amount: Number(args.amount),
      payment_method: args.payment_method || null,
      payment_date: args.payment_date || null,
      notes: args.notes || null,
    };

    const summary = `Registrar abono de ${formatCOP(args.amount)} sobre el gasto ${expense.expense_number} (${expense.description})`;

    const proposal = await AiProposal.create({
      tenant_id: req.tenant_id,
      conversation_id: req.ai_conversation_id || null,
      created_by: req.user.id,
      branch_id: expense.branch_id || req.branch_id || null,
      action_type: 'register_expense_payment',
      summary,
      payload,
    });

    return {
      success: true,
      data: {
        proposal_id: proposal.id,
        status: 'pending',
        summary,
        note: 'Esta propuesta quedó pendiente de aprobación humana en la pantalla de Aprobaciones NEXA. No se ha registrado nada todavía.',
      },
    };
  },
};

module.exports = { TOOL_DEFINITIONS, TOOL_EXECUTORS };
