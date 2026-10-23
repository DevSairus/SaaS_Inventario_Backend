// backend/src/services/inventory/purchaseCost.service.js
//
// Punto único para registrar un nuevo costo de compra de un producto. Lo usan
// la recepción de compras (purchases.controller.js) y los ajustes de entrada
// con motivo "compra" (adjustments.controller.js, p. ej. la compra rápida).
//
//   1. Actualiza last_purchase_cost / last_purchase_date.
//   2. Si el producto tiene margen, recalcula base_price sobre ese costo,
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

const DEFAULT_VARIATION_THRESHOLD = 10;
const round2 = (n) => Math.round(n * 100) / 100;

async function getVariationThreshold(tenant_id, transaction) {
  const tenant = await Tenant.findByPk(tenant_id, { attributes: ['id', 'business_config'], transaction });
  const raw = tenant?.business_config?.cost_variation_alert_pct;
  const value = parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_VARIATION_THRESHOLD;
}

/**
 * @param {object} params
 * @param {Model}  params.product   instancia de Product ya leída dentro de la transacción
 * @param {number} params.newCost   costo unitario (sin IVA) de esta compra
 * @param {string} params.date      fecha de la compra (YYYY-MM-DD)
 * @param {'purchase'|'adjustment'} params.sourceType
 * @returns {{ priceUpdated: boolean, priceHeld: boolean, alert: object|null }}
 */
async function registerPurchaseCost({ tenant_id, product, newCost, date, sourceType, sourceId = null, sourceNumber = null }, transaction) {
  const cost = parseFloat(newCost);
  if (!product || !Number.isFinite(cost) || cost <= 0) return { priceUpdated: false, priceHeld: false, alert: null };

  const previousCost = parseFloat(product.last_purchase_cost) || 0;
  const currentPrice = parseFloat(product.base_price) || 0;
  const margin = parseFloat(product.profit_margin_percentage) || 0;

  const updates = { last_purchase_cost: cost, last_purchase_date: date };

  let suggestedPrice = null;
  let priceHeld = false;
  if (margin > 0) {
    suggestedPrice = round2(cost * (1 + margin / 100));
    if (currentPrice > 0 && suggestedPrice < currentPrice - 0.005) {
      priceHeld = true;
    } else {
      updates.base_price = suggestedPrice;
    }
  }

  await product.update(updates, { transaction });

  const variationPct = previousCost > 0 ? round2(((cost - previousCost) / previousCost) * 100) : null;
  const threshold = await getVariationThreshold(tenant_id, transaction);
  const variationAlert = threshold > 0 && variationPct !== null && Math.abs(variationPct) >= threshold;

  if (!variationAlert && !priceHeld) return { priceUpdated: !!updates.base_price, priceHeld, alert: null };

  const alertType = variationAlert ? (variationPct > 0 ? 'cost_increase' : 'cost_decrease') : 'price_held';
  const severity = variationAlert && threshold > 0 && Math.abs(variationPct) >= threshold * 2 ? 'critical' : 'warning';

  await CostAlert.update(
    { status: 'resolved', resolved_date: new Date(), resolution_notes: 'Reemplazada por una alerta de costo más reciente' },
    { where: { tenant_id, product_id: product.id, status: 'active' }, transaction }
  );

  const alert = await CostAlert.create({
    tenant_id,
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
  }, { transaction });

  return { priceUpdated: !!updates.base_price, priceHeld, alert };
}

module.exports = { registerPurchaseCost, DEFAULT_VARIATION_THRESHOLD };
