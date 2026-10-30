// backend/src/services/inventory/purchaseCost.service.js
//
// Punto único para registrar un nuevo costo de compra de un producto. Lo usan
// la recepción de compras (purchases.controller.js) y los ajustes de entrada
// con motivo "compra" (adjustments.controller.js, p. ej. la compra rápida).
//
//   1. Actualiza last_purchase_cost / last_purchase_date.
//   2. Si el producto tiene margen, recalcula base_price sobre ese costo
//      (margen sobre la venta, con IVA si el precio lo incluye: utils/salePricing),
//      pero el precio NUNCA baja solo: si el sugerido queda por debajo del
//      actual se conserva el actual y la baja queda en cost_alerts
//      (price_held) para que alguien la revise y la aplique a mano.
//   3. Si el costo varía más del umbral del tenant frente al último costo
//      (business_config.cost_variation_alert_pct, 10 por defecto; 0 lo
//      apaga) también crea una alerta en cost_alerts.
//
// Una alerta nueva reemplaza a la activa anterior del mismo producto: el
// precio sugerido y la variación que importan son siempre los más recientes.

const CostAlert = require('../../models/inventory/CostAlert');
const Tenant = require('../../models/auth/Tenant');
const { suggestedSalePrice, normalizeMarginMethod } = require('../../utils/salePricing');

const DEFAULT_VARIATION_THRESHOLD = 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Umbral de alerta de variación y método de cálculo del precio (margen sobre
// la venta o recargo sobre el costo), ambos de tenants.business_config.
async function getCostSettings(tenant_id, transaction) {
  const tenant = await Tenant.findByPk(tenant_id, { attributes: ['id', 'business_config'], transaction });
  const raw = tenant?.business_config?.cost_variation_alert_pct;
  const value = parseFloat(raw);
  return {
    threshold: Number.isFinite(value) && value >= 0 ? value : DEFAULT_VARIATION_THRESHOLD,
    marginMethod: normalizeMarginMethod(tenant?.business_config?.margin_method),
  };
}

// Cálculo de un registro de costo sobre el estado actual del producto, sin
// tocar la BD (lo comparten registerPurchaseCost y registerPurchaseCostsBatch).
// Devuelve null si no aplica; si no, { updates, alert|null, priceHeld }.
function planPurchaseCost(product, newCost, date, { threshold, marginMethod }, { sourceType, sourceId = null, sourceNumber = null }) {
  const cost = parseFloat(newCost);
  if (!product || !Number.isFinite(cost) || cost <= 0) return null;

  const previousCost = parseFloat(product.last_purchase_cost) || 0;
  const currentPrice = parseFloat(product.base_price) || 0;
  const margin = parseFloat(product.profit_margin_percentage) || 0;

  const updates = { last_purchase_cost: cost, last_purchase_date: date };

  let suggestedPrice = null;
  let priceHeld = false;
  if (margin > 0) suggestedPrice = suggestedSalePrice(cost, margin, product, marginMethod);
  if (suggestedPrice !== null) {
    if (currentPrice > 0 && suggestedPrice < currentPrice - 0.005) {
      priceHeld = true;
    } else {
      updates.base_price = suggestedPrice;
    }
  }

  const variationPct = previousCost > 0 ? round2(((cost - previousCost) / previousCost) * 100) : null;
  const variationAlert = threshold > 0 && variationPct !== null && Math.abs(variationPct) >= threshold;

  if (!variationAlert && !priceHeld) return { updates, alert: null, priceHeld };

  const alertType = variationAlert ? (variationPct > 0 ? 'cost_increase' : 'cost_decrease') : 'price_held';
  const severity = variationAlert && threshold > 0 && Math.abs(variationPct) >= threshold * 2 ? 'critical' : 'warning';

  return {
    updates,
    priceHeld,
    alert: {
      product_id: product.id,
      alert_type: alertType,
      severity,
      previous_cost: previousCost > 0 ? previousCost : null,
      new_cost: cost,
      variation_pct: variationPct,
      previous_price: currentPrice || null,
      suggested_price: suggestedPrice,
      price_held: priceHeld,
      source_type: sourceType,
      source_id: sourceId,
      source_number: sourceNumber,
    },
  };
}

const REPLACED_NOTE = 'Reemplazada por una alerta de costo más reciente';

/**
 * @param {object} params
 * @param {Model}  params.product   instancia de Product ya leída dentro de la transacción
 * @param {number} params.newCost   costo unitario (sin IVA) de esta compra
 * @param {string} params.date      fecha de la compra (YYYY-MM-DD)
 * @param {'purchase'|'adjustment'} params.sourceType
 * @returns {{ priceUpdated: boolean, priceHeld: boolean, alert: object|null }}
 */
async function registerPurchaseCost({ tenant_id, product, newCost, date, sourceType, sourceId = null, sourceNumber = null }, transaction) {
  const settings = await getCostSettings(tenant_id, transaction);
  const plan = planPurchaseCost(product, newCost, date, settings, { sourceType, sourceId, sourceNumber });
  if (!plan) return { priceUpdated: false, priceHeld: false, alert: null };

  await product.update(plan.updates, { transaction });
  if (!plan.alert) return { priceUpdated: !!plan.updates.base_price, priceHeld: plan.priceHeld, alert: null };

  await CostAlert.update(
    { status: 'resolved', resolved_date: new Date(), resolution_notes: REPLACED_NOTE },
    { where: { tenant_id, product_id: product.id, status: 'active' }, transaction }
  );

  const alert = await CostAlert.create({ tenant_id, ...plan.alert }, { transaction });

  return { priceUpdated: !!plan.updates.base_price, priceHeld: plan.priceHeld, alert };
}

// Escala de las columnas de products que toca un registro de costo (ver
// PRODUCT_STOCK_SCALE en movements.controller.js: mismo motivo).
const PRODUCT_COST_SCALE = { last_purchase_cost: 2, base_price: 2 };

/**
 * Igual que llamar registerPurchaseCost por cada entrada, en orden, con las
 * escrituras en bloque. `entries`: [{ product, newCost }] (las instancias se
 * actualizan en memoria). Un producto repetido deja, como antes, solo su
 * última alerta activa y las anteriores resueltas como reemplazadas.
 */
async function registerPurchaseCostsBatch(entries, { tenant_id, date, sourceType, sourceId = null, sourceNumber = null }, transaction) {
  const { bulkUpdateById } = require('../../utils/bulkUpdate');
  const { roundNumeric } = require('../../utils/numberUtils');
  const Product = require('../../models/inventory/Product');

  const settings = await getCostSettings(tenant_id, transaction);
  const changed = new Set();
  const alerts = [];
  for (const { product, newCost } of entries) {
    const plan = planPurchaseCost(product, newCost, date, settings, { sourceType, sourceId, sourceNumber });
    if (!plan) continue;
    for (const [col, value] of Object.entries(plan.updates)) {
      product.setDataValue(col, PRODUCT_COST_SCALE[col] !== undefined ? roundNumeric(value, PRODUCT_COST_SCALE[col]) : value);
    }
    changed.add(product);
    if (plan.alert) alerts.push(plan.alert);
  }
  if (changed.size === 0) return;

  const columns = ['last_purchase_cost', 'last_purchase_date', 'base_price'];
  await bulkUpdateById(Product, [...changed].map((p) => ({
    id: p.id,
    last_purchase_cost: p.getDataValue('last_purchase_cost'),
    last_purchase_date: p.getDataValue('last_purchase_date'),
    base_price: p.getDataValue('base_price'),
  })), columns, { transaction });

  if (alerts.length === 0) return;
  await CostAlert.update(
    { status: 'resolved', resolved_date: new Date(), resolution_notes: REPLACED_NOTE },
    { where: { tenant_id, product_id: [...new Set(alerts.map((a) => a.product_id))], status: 'active' }, transaction }
  );
  // De varias alertas del mismo producto en este lote, solo la última queda activa.
  const lastIndex = new Map(alerts.map((a, i) => [a.product_id, i]));
  const now = new Date();
  await CostAlert.bulkCreate(alerts.map((a, i) => (lastIndex.get(a.product_id) === i
    ? { tenant_id, ...a }
    : { tenant_id, ...a, status: 'resolved', resolved_date: now, resolution_notes: REPLACED_NOTE })), { transaction });
}

module.exports = { registerPurchaseCost, registerPurchaseCostsBatch, DEFAULT_VARIATION_THRESHOLD };
