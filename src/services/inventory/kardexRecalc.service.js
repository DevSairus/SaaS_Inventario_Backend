// backend/src/services/inventory/kardexRecalc.service.js
//
// Recálculo del kardex (costo promedio ponderado) en orden de fecha.
//
// Cuando se registra un movimiento con fecha atrasada (una compra que llegó
// hace dos semanas y se ingresa hoy), el promedio nuevo solo afectaba lo que
// venía después de registrarla: las salidas de esas dos semanas quedaban con
// el costo anterior. Esto recorre los movimientos de cada producto en orden
// de fecha, recalcula el promedio y el costo de cada salida, y — al aplicar —
// corrige los movimientos, el costo de las líneas de venta, el promedio del
// producto y genera el asiento de ajuste por mes (costo de ventas / gasto
// contra inventario).
//
// Reglas por tipo de movimiento:
//   - Fijan costo (entran con su propio costo y recalculan el promedio):
//     compras, ajustes de entrada, stock inicial, conteos con sobrante,
//     reversos de devolución a proveedor.
//   - Vuelven al promedio vigente: devoluciones de clientes y reversos de venta.
//   - Traslados: no cambian el promedio (es uno por producto), pero toman el
//     promedio vigente a su fecha. Los que entran o salen de la bodega de una
//     obra ya contabilizados como materiales del proyecto ajustan ese costo.
//   - Devolución a proveedor: sale con su propio costo (el de la compra).
//   - Todas las demás salidas (ventas, repuestos de taller, consumos
//     internos, ajustes de salida, conteos con faltante) salen al promedio.
//
// Al aplicar también se corrige el costo de las líneas de la factura (venta
// directa, o la que generó la orden de trabajo) para que márgenes y
// devoluciones usen el costo nuevo.
//
// Los movimientos de un período contable cerrado NO se modifican (ya fueron
// validados): se muestran como bloqueados y no generan ajuste. El promedio
// sí los recorre para que los movimientos posteriores queden bien.
'use strict';

const { Op } = require('sequelize');
const { weightedAverageCost } = require('../../utils/costResolver');

const SETTING_IN = new Set(['purchase_receipt', 'adjustment_in', 'initial_stock', 'physical_count', 'supplier_return_reversal', 'product_initial_stock', 'product_bulk_import']);
const AVERAGE_IN = new Set(['customer_return', 'sale_reversal']);
const NEUTRAL = new Set(['transfer_send', 'transfer_receive', 'transfer_cancel', 'transfer_in', 'transfer_out']);
const SPECIFIC_OUT = new Set(['supplier_return']);
// Cuenta de resultado contra la que se ajusta la diferencia de cada tipo.
const EXPENSE_KEY = {
  // project_material_cost: traslados de obra ya contabilizados (ver abajo).
  sale: 'sale_cogs_product',
  taller_repuesto: 'sale_cogs_product',
  customer_return: 'sale_cogs_product',
  sale_reversal: 'sale_cogs_product',
  customer_return_reversal: 'sale_cogs_product',
  internal_consumption: 'internal_consumption_expense',
  internal_use: 'internal_consumption_expense',
  adjustment_out: 'inventory_adjustment_shortage',
  physical_count: 'inventory_adjustment_shortage',
};
const EPS = 0.005;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

const typeOf = (m) => m.movement_reason || m.movement_type;

/**
 * Kardex puro de UN producto.
 * @param {Array} movements [{ id, movement_reason|movement_type, direction: 'in'|'out', quantity, unit_cost }] en orden
 * @param {{ qty: number, avg: number }} opening existencias y promedio antes del primer movimiento
 * @returns {{ rows: Array<{ id, type, direction, qty, oldCost, newCost, changed, avgAfter, stockAfter }>, finalAvg, finalQty }}
 */
function recomputeKardex(movements, opening = { qty: 0, avg: 0 }) {
  let qty = Number(opening.qty) || 0;
  let avg = Number(opening.avg) || 0;
  const rows = [];
  for (const m of movements) {
    const type = typeOf(m);
    const q = Number(m.quantity) || 0;
    const oldCost = Number(m.unit_cost) || 0;
    let newCost = oldCost;
    if (NEUTRAL.has(type)) {
      // Traslado: no cambia existencias globales ni promedio; sale y entra al promedio vigente.
      newCost = avg > 0 ? avg : oldCost;
    } else if (m.direction === 'in') {
      if (AVERAGE_IN.has(type)) newCost = avg > 0 ? avg : oldCost;
      avg = weightedAverageCost(qty, avg, q, newCost);
      qty += q;
    } else {
      if (!SPECIFIC_OUT.has(type)) newCost = avg > 0 ? avg : oldCost;
      if (SPECIFIC_OUT.has(type) && qty - q > 0) {
        // Sale con su propio costo: el valor que queda se reparte en lo que queda.
        avg = Math.max(0, (qty * avg - q * oldCost) / (qty - q));
      }
      qty -= q;
    }
    newCost = round2(newCost);
    rows.push({
      id: m.id, type, direction: m.direction, qty: q, oldCost, newCost,
      changed: Math.abs(newCost - oldCost) > EPS,
      avgAfter: round4(avg), stockAfter: round4(qty),
    });
  }
  return { rows, finalAvg: round2(avg), finalQty: round4(qty) };
}

const sortKey = (m) => `${new Date(m.movement_date || m.created_at).toISOString()}|${new Date(m.created_at).toISOString()}|${m.id}`;

/**
 * Vista previa o aplicación del recálculo.
 * @param {object} opts { tenantId, productId?, from? ('YYYY-MM-DD': productos con movimientos desde esa fecha), apply, userId }
 */
async function recalculateKardex({ tenantId, productId = null, from = null, apply = false, userId = null }) {
  const { sequelize } = require('../../config/database');
  const { InventoryMovement, Product, Warehouse, SaleItem, WorkOrder } = require('../../models');

  // Productos a revisar: el indicado, o los que tienen movimientos desde la fecha.
  let productIds;
  if (productId) productIds = [productId];
  else {
    const where = { tenant_id: tenantId };
    if (from) where.movement_date = { [Op.gte]: from };
    const rows = await InventoryMovement.findAll({ where, attributes: [[sequelize.fn('DISTINCT', sequelize.col('product_id')), 'product_id']], raw: true });
    productIds = rows.map((r) => r.product_id).filter(Boolean);
  }
  if (!productIds.length) return { products: [], totals: { changed: 0, cost_difference: 0 }, entries: [] };

  const projectOfWarehouse = new Map((await Warehouse.findAll({ where: { tenant_id: tenantId, project_id: { [Op.ne]: null } }, attributes: ['id', 'project_id'] })).map((w) => [w.id, w.project_id]));
  const table = (name) => `"${require('../../config/tenantContext').getCurrentSchema() || 'public'}"."${name}"`;
  // Solo bienes con inventario: servicios y productos sin control de stock no tienen kardex.
  const products = await Product.findAll({
    where: { tenant_id: tenantId, id: productIds, product_type: { [Op.ne]: 'service' }, track_inventory: { [Op.ne]: false } },
    attributes: ['id', 'sku', 'name', 'average_cost', 'current_stock'],
  });

  // Meses cerrados (YYYY-MM): sus movimientos no se tocan.
  const { FiscalPeriod } = require('../../models');
  const closedMonths = new Set((await FiscalPeriod.findAll({ where: { tenant_id: tenantId, status: 'closed' }, attributes: ['year', 'month'] }))
    .map((fp) => `${fp.year}-${String(fp.month).padStart(2, '0')}`));
  const localMonth = (d) => {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  };
  const results = [];
  const adjustments = new Map(); // `${YYYY-MM}|${expenseKey}` → monto (positivo = más gasto)
  for (const product of products) {
    const movements = await InventoryMovement.findAll({
      where: { tenant_id: tenantId, product_id: product.id },
      attributes: ['id', 'movement_reason', 'movement_type', 'direction', 'quantity', 'unit_cost', 'movement_date', 'created_at', 'previous_stock', 'stock_before', 'warehouse_id', 'reference_type', 'reference_id', 'movement_number'],
    });
    if (!movements.length) continue;
    movements.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const first = movements[0];
    const openingQty = Number(first.previous_stock ?? first.stock_before ?? 0) || 0;
    const opening = { qty: openingQty, avg: openingQty > 0 ? Number(first.unit_cost) || Number(product.average_cost) || 0 : 0 };
    const { rows, finalAvg } = recomputeKardex(movements, opening);
    const byId = new Map(movements.map((m) => [m.id, m]));
    const lockedRows = rows.filter((r) => r.changed && closedMonths.has(localMonth(byId.get(r.id).movement_date || byId.get(r.id).created_at)));
    const lockedIds = new Set(lockedRows.map((r) => r.id));
    const changed = rows.filter((r) => r.changed && !lockedIds.has(r.id));
    // Traslados de obra ya contabilizados como materiales del proyecto.
    const transferIds = changed.filter((r) => NEUTRAL.has(r.type) && projectOfWarehouse.has(byId.get(r.id).warehouse_id)).map((r) => r.id);
    const posted = new Set(transferIds.length ? (await sequelize.query(
      `SELECT movement_id FROM ${table('project_material_postings')} WHERE movement_id IN (:ids) AND entry_id IS NOT NULL`,
      { replacements: { ids: transferIds }, type: sequelize.QueryTypes.SELECT },
    )).map((x) => x.movement_id) : []);
    let costDifference = 0;
    for (const r of changed) {
      const m = byId.get(r.id);
      const diff = round2((r.newCost - r.oldCost) * r.qty);
      r.movement_number = m.movement_number;
      r.date = m.movement_date || m.created_at;
      const projectId = projectOfWarehouse.get(m.warehouse_id) || null;
      let key = null;
      let expenseEffect = 0;
      if (NEUTRAL.has(r.type)) {
        // Traslado: solo pesa en resultados si es material de obra ya contabilizado
        // (entra a la obra = costo del proyecto; sale de la obra = reintegro).
        if (projectId && posted.has(r.id)) {
          key = 'project_material_cost';
          expenseEffect = r.direction === 'in' ? diff : -diff;
        }
      } else if (!projectId) {
        // Efecto en resultados: salida más cara = más gasto; devolución que vuelve más cara = menos gasto.
        key = EXPENSE_KEY[r.type] || null;
        expenseEffect = r.direction === 'out' ? diff : -diff;
      }
      r.accounted = Boolean(key);
      if (r.accounted) {
        costDifference = round2(costDifference + expenseEffect);
        const month = new Date(r.date).toISOString().slice(0, 7);
        const k = `${month}|${key}|${key === 'project_material_cost' ? projectId : ''}`;
        adjustments.set(k, round2((adjustments.get(k) || 0) + expenseEffect));
      }
    }
    const avgChanged = Math.abs(finalAvg - Number(product.average_cost)) > EPS;
    if (!changed.length && !avgChanged && !lockedRows.length) continue;
    results.push({
      product: { id: product.id, sku: product.sku, name: product.name },
      movements_changed: changed.length,
      cost_difference: costDifference,
      average_before: Number(product.average_cost),
      average_after: finalAvg,
      changes: changed.slice(0, 50).map((r) => ({
        movement_number: r.movement_number, date: r.date, type: r.type, direction: r.direction, quantity: r.qty,
        old_cost: r.oldCost, new_cost: r.newCost, accounted: r.accounted,
      })),
      locked: lockedRows.slice(0, 20).map((r) => {
        const m = byId.get(r.id);
        return { movement_number: m.movement_number, date: m.movement_date || m.created_at, type: r.type, quantity: r.qty, old_cost: r.oldCost, new_cost: r.newCost };
      }),
      locked_count: lockedRows.length,
      _rows: changed,
      _movements: byId,
    });
  }

  const summary = {
    products: results.map(({ _rows, _movements, ...r }) => r),
    totals: {
      locked: results.reduce((s, r) => s + (r.locked_count || 0), 0),
      products: results.length,
      changed: results.reduce((s, r) => s + r.movements_changed, 0),
      cost_difference: round2(results.reduce((s, r) => s + r.cost_difference, 0)),
    },
    entries: [...adjustments.entries()].filter(([, v]) => Math.abs(v) >= 0.01).map(([k, amount]) => {
      const [month, account_key, project_id] = k.split('|');
      return { month, account_key, project_id: project_id || null, amount };
    }),
    applied: false,
  };
  if (!apply || !results.length) return summary;

  const { createDraftEntry, assertPeriodOpen, getMappedAccountId } = require('../accounting/journalEntry.service');
  const created = [];
  await sequelize.transaction(async (t) => {
    for (const r of results) {
      for (const row of r._rows) {
        const m = r._movements.get(row.id);
        await m.update({ unit_cost: row.newCost, total_cost: round2(row.newCost * row.qty) }, { transaction: t });
        // Línea de la factura: el costo que usan márgenes y devoluciones (venta
        // directa, o la factura que generó la orden de trabajo).
        if (m.reference_id && ['sale', 'sale_reversal', 'taller_repuesto'].includes(row.type)) {
          let saleId = m.reference_type === 'sale' ? m.reference_id : null;
          if (m.reference_type === 'work_order') {
            const wo = await WorkOrder.findOne({ where: { id: m.reference_id, tenant_id: tenantId }, attributes: ['sale_id'], transaction: t });
            saleId = wo?.sale_id || null;
          }
          if (saleId) await SaleItem.update({ unit_cost: row.newCost }, { where: { sale_id: saleId, product_id: r.product.id }, transaction: t });
        }
      }
      await Product.update({ average_cost: r.average_after }, { where: { id: r.product.id, tenant_id: tenantId }, transaction: t });
    }

    // Asiento de ajuste por mes: en su mes si el período está abierto; si
    // está cerrado, hoy (con la nota del mes al que corresponde).
    const byMonth = new Map();
    for (const e of summary.entries) {
      if (!byMonth.has(e.month)) byMonth.set(e.month, []);
      byMonth.get(e.month).push(e);
    }
    const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
    for (const [month, items] of byMonth) {
      const [y, mo] = month.split('-').map(Number);
      const monthEnd = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      let entryDate = monthEnd;
      try { await assertPeriodOpen(tenantId, `${monthEnd}T12:00:00`, t); } catch { entryDate = new Date().toISOString().slice(0, 10); }
      const lines = [];
      let net = 0;
      for (const it of items) {
        const account = await getMappedAccountId(tenantId, it.account_key, t);
        const desc = it.account_key === 'project_material_cost' ? `Ajuste de materiales de obra (recálculo de kardex ${month})` : `Ajuste de costo (recálculo de kardex ${month})`;
        if (it.amount > 0) lines.push({ account_id: account, debit: it.amount, credit: 0, description: desc, project_id: it.project_id });
        else lines.push({ account_id: account, debit: 0, credit: -it.amount, description: desc, project_id: it.project_id });
        net = round2(net + it.amount);
      }
      if (Math.abs(net) < 0.01) continue;
      lines.push(net > 0
        ? { account_id: inventoryAccount, debit: 0, credit: net, description: 'Inventario — recálculo de kardex', project_id: null }
        : { account_id: inventoryAccount, debit: -net, credit: 0, description: 'Inventario — recálculo de kardex', project_id: null });
      const entry = await createDraftEntry(tenantId, {
        entryDate,
        sourceType: 'inventory_cost_recalc',
        sourceId: null,
        description: `Recálculo de costo promedio — movimientos de ${month}${entryDate !== monthEnd ? ' (período cerrado, registrado hoy)' : ''}`,
        lines,
        createdBy: userId,
      }, t);
      created.push({ month, entry_number: entry.entry_number, date: entryDate, amount: net });
    }
  });
  return { ...summary, applied: true, journal_entries: created };
}

module.exports = { recomputeKardex, recalculateKardex, SETTING_IN, AVERAGE_IN, NEUTRAL, EXPENSE_KEY };
