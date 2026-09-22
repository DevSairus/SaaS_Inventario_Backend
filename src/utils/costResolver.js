// backend/src/utils/costResolver.js
//
// Cadena de fallback ÚNICA para resolver el costo unitario efectivo de una
// salida de inventario (venta, OT, devolución, ajuste). Antes cada sitio
// tenía su propia variante (kardex: unit_cost || average_cost || unit_price;
// OT: average_cost || purchase_price || unit_price; el asiento de venta: solo
// unit_cost, sin fallback) y podían quedar desincronizados entre sí -- el
// kardex reconocía un costo distinto al que el asiento contable reversaba.
//
// Orden:
//   1. item.unit_cost      -- snapshot ya registrado (ej. lo que se contabilizó
//                              al confirmar la venta; una devolución debe
//                              reversar ESTE valor, no uno recalculado).
//   2. product.average_cost -- costo promedio ponderado vigente del producto.
//   3. product.purchase_price -- último costo de compra conocido, si el
//                              producto nunca tuvo entradas con costo.
//   4. item.unit_price     -- último recurso: precio de venta. Esconde el
//                              margen (queda en 0%) pero es preferible a un
//                              costo $0, que deja la salida sin CMV alguno.
function resolveUnitCost(item, product) {
  const candidates = [item?.unit_cost, product?.average_cost, product?.purchase_price, item?.unit_price];
  for (const candidate of candidates) {
    const value = parseFloat(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

// Costo unitario "aterrizado" de una línea de compra: prorratea el descuento
// GLOBAL de la compra y el flete (purchase.discount_amount / shipping_cost)
// entre las líneas según su peso en purchase.subtotal, que ya trae aplicado
// el descuento POR LÍNEA (purchaseItem.discount_percentage). Sin esto, el
// kardex/average_cost capitalizaba purchaseItem.unit_cost -- el precio de
// lista de la línea -- mientras generatePurchaseEntry acreditaba a 143501
// subtotal - discount_amount + shipping_cost (que sí incluye ambos), dejando
// el inventario valorado por debajo de lo contabilizado.
function resolveLandedPurchaseUnitCost(purchaseItem, purchase) {
  const quantity = parseFloat(purchaseItem?.quantity) || 0;
  if (quantity <= 0) return parseFloat(purchaseItem?.unit_cost) || 0;

  const lineSubtotal = parseFloat(purchaseItem?.subtotal) || 0;
  const purchaseSubtotal = parseFloat(purchase?.subtotal) || 0;
  const globalDiscount = parseFloat(purchase?.discount_amount) || 0;
  const shippingCost = parseFloat(purchase?.shipping_cost) || 0;

  if (purchaseSubtotal <= 0 || (globalDiscount === 0 && shippingCost === 0)) {
    return lineSubtotal / quantity;
  }

  const share = lineSubtotal / purchaseSubtotal;
  const landedLineTotal = lineSubtotal - (globalDiscount * share) + (shippingCost * share);
  return landedLineTotal / quantity;
}

module.exports = { resolveUnitCost, resolveLandedPurchaseUnitCost };
