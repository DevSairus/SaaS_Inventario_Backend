// backend/src/controllers/accounting/accountingHealth.controller.js
//
// 4.2 del análisis contable: "Reporte de asientos pendientes de revisión /
// huecos de integridad, visible en UI". El backend (journalIntegrity.service.js)
// ya tenía los tres chequeos completos, pero solo los podía consultar NEXA
// (el asistente de IA) — no existía ningún endpoint REST ni pantalla que
// los mostrara. Este controlador solo expone lo que ya existe.
const logger = require('../../config/logger');

const {
  findMissingJournalEntries,
  getDraftEntriesPendingReview,
  validateTrialBalanceConsistency,
} = require('../../services/accounting/journalIntegrity.service');
const {
  generateSaleEntry,
  generatePurchaseEntry,
  generateExpenseEntry,
  generateCashSessionEntry,
} = require('../../services/accounting/autoEntries.service');

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

// Punto único que traduce un (source_type, source_id) al generador correcto,
// cargando exactamente lo que cada generador necesita (mismo patrón que ya
// usan sales.controller.js / purchases.controller.js / expenses.controller.js
// / cashSessions.controller.js al momento de confirmar el movimiento — acá
// solo se llama más tarde, "a mano", desde la pantalla de Salud Contable).
//
// `options.rethrow: true` para que, si falta un mapeo de cuentas, el error
// llegue al usuario en vez de quedar solo en el log (ver safeAutoGenerate).
async function generateEntryForSource(sourceType, sourceId, tenantId, userId, options = {}) {
  const { Sale, SaleItem, Purchase, Expense, CashSession } = require('../../models');

  switch (sourceType) {
    case 'sale': {
      const sale = await Sale.findOne({ where: { id: sourceId, tenant_id: tenantId }, include: [{ model: SaleItem, as: 'items' }] });
      if (!sale) throw Object.assign(new Error('Venta no encontrada'), { statusCode: 404 });
      return generateSaleEntry(sale, sale.items, tenantId, userId, options);
    }
    case 'purchase': {
      const purchase = await Purchase.findOne({ where: { id: sourceId, tenant_id: tenantId } });
      if (!purchase) throw Object.assign(new Error('Compra no encontrada'), { statusCode: 404 });
      return generatePurchaseEntry(purchase, tenantId, userId, options);
    }
    case 'expense': {
      const expense = await Expense.findOne({ where: { id: sourceId, tenant_id: tenantId } });
      if (!expense) throw Object.assign(new Error('Gasto no encontrado'), { statusCode: 404 });
      return generateExpenseEntry(expense, tenantId, userId, options);
    }
    case 'cash_session': {
      const session = await CashSession.findOne({ where: { id: sourceId, tenant_id: tenantId } });
      if (!session) throw Object.assign(new Error('Cierre de caja no encontrado'), { statusCode: 404 });
      return generateCashSessionEntry(session, tenantId, userId, options);
    }
    default:
      throw Object.assign(new Error(`Tipo de origen no soportado: "${sourceType}"`), { statusCode: 400 });
  }
}

// POST /api/accounting/health/missing-entries/:source_type/:source_id/generate
// Genera (en borrador) el asiento de UN movimiento puntual detectado como
// hueco. No lo postea automáticamente — queda en 'draft' para que alguien
// lo revise, igual que los asientos automáticos normales.
exports.generateMissingEntry = async (req, res) => {
  try {
    const { source_type, source_id } = req.params;
    const entry = await generateEntryForSource(source_type, source_id, req.tenant_id, req.user.id, { rethrow: true });
    if (!entry) {
      // Puede pasar en cash_session: si ya no hay diferencia que contabilizar
      // (se corrigió por otro lado), no hay nada que generar — no es un error.
      return res.json({ success: true, data: null, message: 'No había nada que contabilizar para este movimiento (sin diferencia real)' });
    }
    res.json({ success: true, data: entry, message: `Asiento ${entry.entry_number} generado en borrador` });
  } catch (error) {
    logger.error('Error en accountingHealth.controller.js:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : `No se pudo generar el asiento: ${error.message}`,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

// POST /api/accounting/health/missing-entries/generate-all
// Body: { items: [{ source_type, source_id }, ...] } — normalmente la misma
// lista que ya trae GET /api/accounting/health en missing_entries.items.
// Genera uno por uno (no en batch/transacción única a propósito: si uno
// falla por falta de mapeo, los demás igual se intentan) y devuelve el
// detalle de éxitos y fallos para que la pantalla muestre exactamente qué
// quedó pendiente y por qué.
exports.generateAllMissingEntries = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ success: false, message: 'items es obligatorio y debe tener al menos un elemento' });
    }
    const MAX_BULK = 100;
    if (items.length > MAX_BULK) {
      return res.status(400).json({ success: false, message: `Máximo ${MAX_BULK} movimientos por lote — filtra por un rango de fechas más corto` });
    }

    const results = { generated: [], skipped: [], failed: [] };
    for (const item of items) {
      try {
        const entry = await generateEntryForSource(item.source_type, item.source_id, req.tenant_id, req.user.id, { rethrow: true });
        if (entry) results.generated.push({ ...item, entry_id: entry.id, entry_number: entry.entry_number });
        else results.skipped.push({ ...item, reason: 'Sin diferencia real que contabilizar' });
      } catch (error) {
        results.failed.push({ ...item, reason: error.message });
      }
    }

    res.json({
      success: true,
      data: results,
      message: `${results.generated.length} generados, ${results.skipped.length} sin cambios, ${results.failed.length} con error`,
    });
  } catch (error) {
    logger.error('Error en accountingHealth.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error generando los asientos en lote', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /api/accounting/health?from=&to=&older_than_days=&branch_id=
// Corre los tres chequeos de integridad de una sola vez — es lo que
// alimenta la pantalla "Salud Contable". Cada chequeo es independiente:
// si uno falla, no bloquea a los otros dos.
exports.summary = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const defaults = defaultRange();
    const from = req.query.from || defaults.from;
    const to = req.query.to || defaults.to;
    const olderThanDays = req.query.older_than_days;

    const [missing, drafts, consistency] = await Promise.all([
      findMissingJournalEntries(req.tenant_id, { from, to, branchId: branch_id }),
      getDraftEntriesPendingReview(req.tenant_id, { olderThanDays, branchId: branch_id }),
      validateTrialBalanceConsistency(req.tenant_id, { from, to, branchId: branch_id }),
    ]);

    res.json({
      success: true,
      data: {
        from,
        to,
        branch_id: branch_id || null,
        missing_entries: missing,
        drafts_pending: drafts,
        consistency,
        is_healthy: missing.total_missing === 0 && drafts.total === 0 && consistency.is_consistent,
      },
    });
  } catch (error) {
    logger.error('Error en accountingHealth.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al calcular la salud contable', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
