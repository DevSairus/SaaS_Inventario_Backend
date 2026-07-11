// backend/src/services/ai/tools/controlTools.js
//
// Fase 3 del Asistente de IA: tools de CONTROL Y EVALUACIÓN sobre lo que el
// sistema ya genera solo (asientos automáticos de venta/compra/gasto/caja).
// A diferencia de registry.js (consultas de negocio) y writeTools.js
// (propuestas de escritura), estas tools vigilan la salud de datos que ya
// existen — son de solo lectura, mismo mecanismo de callControllerAsTool no
// aplica porque no hay un controller HTTP detrás, se llama directo al
// servicio (mismo patrón que get_cashflow_summary en registry.js).

const { findMissingJournalEntries, getDraftEntriesPendingReview, validateTrialBalanceConsistency } = require('../../accounting/journalIntegrity.service');

function formatCOP(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'find_missing_journal_entries',
      description:
        'Revisa un rango de fechas y detecta ventas confirmadas, compras recibidas, gastos y cierres de caja ' +
        'con diferencia que NO tienen su asiento contable automático generado (puede pasar si falta configurar ' +
        'un mapeo de cuentas contables para ese tipo de movimiento, o si el movimiento es anterior a que ' +
        'existiera el módulo de contabilidad). Devuelve el detalle (referencia, fecha, monto, source_id) de cada ' +
        'uno, no solo el conteo — muéstraselos al usuario. Úsala cuando el usuario pregunte cosas como "¿está ' +
        'todo contabilizado?", "¿falta algo por registrar en contabilidad?", "revisa si hay huecos contables", ' +
        'o como chequeo de rutina antes de cerrar un periodo.',
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
      name: 'get_draft_entries_pending_review',
      description:
        'Detecta asientos contables (automáticos o manuales) que quedaron en estado borrador hace más de N días ' +
        'sin postearse — a diferencia de find_missing_journal_entries (que busca movimientos SIN asiento), acá el ' +
        'asiento ya existe pero nadie lo confirmó. Útil para "¿qué me falta confirmar en contabilidad?", "¿hay ' +
        'asientos pendientes de revisar?", o como chequeo de rutina antes de cerrar un periodo.',
      parameters: {
        type: 'object',
        properties: {
          older_than_days: {
            type: 'number',
            description: 'Días mínimos en borrador para considerarlo pendiente (opcional, default 7)',
          },
          branch_id: { type: 'string', description: 'UUID de sede (opcional, si no se da consolida todas las sedes)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_trial_balance_consistency',
      description:
        'Chequeo de salud contable: confirma que el débito y el crédito cuadren, tanto en total como asiento ' +
        'por asiento, en un rango de fechas. Por diseño esto no debería fallar nunca — es una red de seguridad, ' +
        'no un reporte de uso frecuente. Úsala solo si el usuario pregunta explícitamente algo como "¿está bien ' +
        'cuadrada la contabilidad?", "¿hay algo raro en los asientos?", o antes de cerrar un periodo si el ' +
        'usuario lo pide; no la corras espontáneamente en cada conversación.',
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
      name: 'propose_regenerate_journal_entry',
      description:
        'Prepara una PROPUESTA para generar el asiento contable en borrador de un movimiento que la ' +
        'revisión de integridad contable detectó sin asiento. IMPORTANTE: esto NO genera el asiento de ' +
        'inmediato — solo deja una propuesta pendiente de aprobación humana en la pantalla de Aprobaciones ' +
        'NEXA, igual que un gasto o un abono. Necesitas el source_type y source_id exactos del movimiento ' +
        '(obtenidos previamente al revisar la integridad contable). Nunca menciones el nombre de esta tool ' +
        'al usuario — ofrécele la acción en lenguaje natural.',
      parameters: {
        type: 'object',
        properties: {
          source_type: { type: 'string', description: 'sale | purchase | expense | cash_session' },
          source_id: { type: 'string', description: 'UUID del movimiento (venta, compra, gasto o cierre de caja)' },
        },
        required: ['source_type', 'source_id'],
      },
    },
  },
];

const TOOL_EXECUTORS = {
  find_missing_journal_entries: async (args, req) => {
    if (!args.from || !args.to) {
      return { success: false, message: 'Debes indicar from y to (YYYY-MM-DD)' };
    }

    const result = await findMissingJournalEntries(req.tenant_id, {
      from: args.from,
      to: args.to,
      branchId: args.branch_id || null,
    });

    let note;
    if (result.total_missing === 0) {
      note = 'Todo lo revisado en este rango tiene su asiento contable generado.';
    } else if (result.truncated) {
      note = `Se muestran los ${result.shown} más antiguos de ${result.total_missing} en total. Ofrécele al usuario, en lenguaje natural, generar el asiento faltante de alguno de estos movimientos (usa su referencia, ej. "¿quieres que prepare el asiento de la venta X?"); si acepta, dispara la propuesta con el source_type + source_id de ese item. No menciones nombres de tools ni de funciones al usuario.`;
    } else {
      note = 'Ofrécele al usuario, en lenguaje natural, generar el asiento faltante de alguno de estos movimientos (usa su referencia, ej. "¿quieres que prepare el asiento de la venta X?"); si acepta, dispara la propuesta con el source_type + source_id de ese item. No menciones nombres de tools ni de funciones al usuario.';
    }

    return {
      success: true,
      data: {
        total_missing: result.total_missing,
        by_type: result.by_type,
        shown: result.shown,
        truncated: result.truncated,
        items: result.items.map((item) => ({
          source_type: item.source_type,
          source_id: item.source_id,
          referencia: item.label,
          fecha: item.date,
          monto: formatCOP(item.amount),
        })),
        note,
      },
    };
  },

  get_draft_entries_pending_review: async (args, req) => {
    const result = await getDraftEntriesPendingReview(req.tenant_id, {
      olderThanDays: args.older_than_days,
      branchId: args.branch_id || null,
    });

    let note;
    if (result.total === 0) {
      note = `No hay asientos en borrador con más de ${result.older_than_days} días sin postear.`;
    } else if (result.truncated) {
      note = `Se muestran los ${result.shown} más antiguos de ${result.total} en total. Ofrécele al usuario revisarlos o postearlos desde el Libro Diario — tú no puedes postearlos directamente, solo avisar cuáles son.`;
    } else {
      note = 'Ofrécele al usuario revisarlos o postearlos desde el Libro Diario — tú no puedes postearlos directamente, solo avisar cuáles son.';
    }

    return {
      success: true,
      data: {
        total: result.total,
        older_than_days: result.older_than_days,
        shown: result.shown,
        truncated: result.truncated,
        items: result.items.map((item) => ({
          entry_number: item.entry_number,
          entry_date: item.entry_date,
          source_type: item.source_type,
          descripcion: item.description,
          monto: formatCOP(item.total_debit),
          dias_pendiente: item.days_pending,
        })),
        note,
      },
    };
  },

  validate_trial_balance_consistency: async (args, req) => {
    if (!args.from || !args.to) {
      return { success: false, message: 'Debes indicar from y to (YYYY-MM-DD)' };
    }

    const result = await validateTrialBalanceConsistency(req.tenant_id, {
      from: args.from,
      to: args.to,
      branchId: args.branch_id || null,
    });

    const note = result.is_consistent
      ? `Todo cuadra: ${result.entries_checked} asientos revisados, débito y crédito coinciden tanto en total como en cada asiento.`
      : `Se encontraron ${result.total_inconsistent} asiento(s) con inconsistencias sobre ${result.entries_checked} revisados. Esto no debería pasar en operación normal — avísale al usuario con los datos exactos y sugiérele revisar esos asientos puntuales desde el Libro Diario (no intentes corregirlos tú).`;

    return {
      success: true,
      data: {
        is_consistent: result.is_consistent,
        entries_checked: result.entries_checked,
        global: {
          total_debit: formatCOP(result.global.total_debit),
          total_credit: formatCOP(result.global.total_credit),
          difference: formatCOP(result.global.difference),
        },
        inconsistent_entries: result.inconsistent_entries.map((e) => ({
          entry_number: e.entry_number,
          entry_date: e.entry_date,
          status: e.status,
          problemas: e.problems,
        })),
        truncated: result.truncated,
        note,
      },
    };
  },

  propose_regenerate_journal_entry: async (args, req) => {
    const VALID_TYPES = ['sale', 'purchase', 'expense', 'cash_session'];
    if (!args.source_type || !VALID_TYPES.includes(args.source_type)) {
      return { success: false, message: `source_type debe ser uno de: ${VALID_TYPES.join(', ')}` };
    }
    if (!args.source_id) {
      return { success: false, message: 'source_id es obligatorio' };
    }

    const { JournalEntry } = require('../../../models');
    const existing = await JournalEntry.findOne({
      where: { tenant_id: req.tenant_id, source_type: args.source_type, source_id: args.source_id },
    });
    if (existing) {
      return {
        success: false,
        message: `Este movimiento ya tiene un asiento contable (${existing.entry_number}, estado ${existing.status}) — no hace falta regenerarlo.`,
      };
    }

    const source = await loadSourceRecord(args.source_type, args.source_id, req.tenant_id);
    if (!source) {
      return { success: false, message: 'No encontré ese movimiento en esta empresa' };
    }

    const summary = `Generar el asiento contable faltante de ${describeSource(args.source_type, source)}`;

    const { AiProposal } = require('../../../models');
    const proposal = await AiProposal.create({
      tenant_id: req.tenant_id,
      conversation_id: req.ai_conversation_id || null,
      created_by: req.user.id,
      branch_id: source.branch_id || req.branch_id || null,
      action_type: 'regenerate_journal_entry',
      summary,
      payload: { source_type: args.source_type, source_id: args.source_id },
    });

    return {
      success: true,
      data: {
        proposal_id: proposal.id,
        status: 'pending',
        summary,
        note: 'Esta propuesta quedó pendiente de aprobación humana en la pantalla de Aprobaciones NEXA. No se ha generado nada todavía.',
      },
    };
  },
};

// ── Helpers para propose_regenerate_journal_entry ──────────────────────────
async function loadSourceRecord(sourceType, sourceId, tenantId) {
  const { Sale, SaleItem, Purchase, Expense, CashSession } = require('../../../models');
  switch (sourceType) {
    case 'sale':
      return Sale.findOne({ where: { id: sourceId, tenant_id: tenantId }, include: [{ model: SaleItem, as: 'items' }] });
    case 'purchase':
      return Purchase.findOne({ where: { id: sourceId, tenant_id: tenantId } });
    case 'expense':
      return Expense.findOne({ where: { id: sourceId, tenant_id: tenantId } });
    case 'cash_session':
      return CashSession.findOne({ where: { id: sourceId, tenant_id: tenantId } });
    default:
      return null;
  }
}

function describeSource(sourceType, source) {
  switch (sourceType) {
    case 'sale':
      return `la venta ${source.sale_number || source.id}`;
    case 'purchase':
      return `la compra ${source.purchase_number || source.id}`;
    case 'expense':
      return `el gasto ${source.expense_number || source.id} (${source.description})`;
    case 'cash_session':
      return `el cierre de caja del ${source.session_date}`;
    default:
      return source.id;
  }
}

module.exports = { TOOL_DEFINITIONS, TOOL_EXECUTORS };