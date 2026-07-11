// backend/src/services/ai/proposalExecutor.js
//
// Fase 2 del Asistente de IA: acá es donde una AiProposal aprobada se
// convierte finalmente en una escritura real, reusando los mismos
// controllers de siempre (misma validación, mismo tenant scoping) vía
// callControllerAsTool — igual que las tools de lectura de Fase 1.
//
// Este módulo SOLO se invoca desde aiProposals.controller.js, nunca desde
// el chat ni desde el modelo de IA directamente.

const { callControllerAsTool } = require('./callControllerAsTool');
const expensesCtrl = require('../../controllers/finance/expenses.controller');

const PROPOSAL_EXECUTORS = {
  create_expense: (proposal, req) =>
    callControllerAsTool(expensesCtrl.createExpense, req, {
      body: proposal.payload,
    }),

  register_expense_payment: (proposal, req) => {
    const { expense_id, ...body } = proposal.payload;
    return callControllerAsTool(expensesCtrl.registerPayment, req, {
      params: { id: expense_id },
      body,
    });
  },

  // Fase 3: regenera el asiento en borrador de un movimiento que quedó sin
  // contabilizar (típicamente porque el mapeo de cuentas no existía en el
  // momento, o el movimiento es anterior al módulo de contabilidad).
  //
  // OJO: generateSaleEntry/generatePurchaseEntry/etc. están envueltas en
  // `safeAutoGenerate`, que traga errores y devuelve `null` — eso está bien
  // para el flujo automático silencioso (no debe tumbar una venta), pero
  // acá el usuario aprobó explícitamente esta acción y espera un resultado
  // real. Por eso: si el resultado es null, lo tratamos como fallo explícito
  // (lanzamos error) para que aiProposals.controller.js marque la propuesta
  // como 'failed' con un mensaje útil, en vez de 'executed' sin haber creado
  // nada.
  regenerate_journal_entry: async (proposal, req) => {
    const { source_type, source_id } = proposal.payload;
    const { Sale, SaleItem, Purchase, Expense, CashSession, JournalEntry } = require('../../models');
    const autoEntries = require('../accounting/autoEntries.service');

    // Re-chequear justo antes de ejecutar: pudo haberse generado por otro
    // camino entre que se propuso y se aprobó.
    const existing = await JournalEntry.findOne({
      where: { tenant_id: req.tenant_id, source_type, source_id },
    });
    if (existing) {
      return { already_existed: true, entry_id: existing.id, entry_number: existing.entry_number };
    }

    let entry = null;
    switch (source_type) {
      case 'sale': {
        const sale = await Sale.findOne({
          where: { id: source_id, tenant_id: req.tenant_id },
          include: [{ model: SaleItem, as: 'items' }],
        });
        if (!sale) throw new Error('La venta ya no existe');
        entry = await autoEntries.generateSaleEntry(sale, sale.items, req.tenant_id, req.user.id);
        break;
      }
      case 'purchase': {
        const purchase = await Purchase.findOne({ where: { id: source_id, tenant_id: req.tenant_id } });
        if (!purchase) throw new Error('La compra ya no existe');
        entry = await autoEntries.generatePurchaseEntry(purchase, req.tenant_id, req.user.id);
        break;
      }
      case 'expense': {
        const expense = await Expense.findOne({ where: { id: source_id, tenant_id: req.tenant_id } });
        if (!expense) throw new Error('El gasto ya no existe');
        entry = await autoEntries.generateExpenseEntry(expense, req.tenant_id, req.user.id);
        break;
      }
      case 'cash_session': {
        const session = await CashSession.findOne({ where: { id: source_id, tenant_id: req.tenant_id } });
        if (!session) throw new Error('El cierre de caja ya no existe');
        entry = await autoEntries.generateCashSessionEntry(session, req.tenant_id, req.user.id);
        break;
      }
      default:
        throw new Error(`source_type desconocido: ${source_type}`);
    }

    if (!entry) {
      throw new Error(
        'No se pudo generar el asiento — probablemente sigue faltando un mapeo de cuentas contables para este tipo de movimiento. Revisa Configuración > Mapeo Contable e inténtalo de nuevo.'
      );
    }

    return { entry_id: entry.id, entry_number: entry.entry_number };
  },
};

module.exports = { PROPOSAL_EXECUTORS };
