// backend/src/services/sales/globalDiscount.service.js
//
// Descuento global de una venta al acreditarla (devolución, anulación, nota
// crédito). El descuento global se resta del total DESPUÉS de impuestos
// (resolveGlobalDiscount en sales.controller.js): no cambia el IVA, reduce
// el ingreso. Al acreditar una parte de la venta, a lo acreditado le toca la
// misma proporción del descuento:
//
//   bruto acreditado = líneas + IVA (sin descuento)
//   descuento        = bruto × descuento global / total antes de descuento
//   neto             = bruto − descuento   ← lo que se devuelve / se reporta
//
// Antes se acreditaba el bruto: anular una venta de $238.000 con 10% de
// descuento (se cobraron $214.200) devolvía y reportaba $238.000.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Parte del descuento global de `sale` que corresponde a `gross` (bruto
// acreditado). 0 si la venta no tiene descuento global.
function discountShare(sale, gross) {
  const discount = Number(sale?.global_discount_amount || 0);
  if (!(discount > 0) || !(gross > 0)) return 0;
  const preDiscountTotal = Number(sale.total_amount || 0) + discount;
  if (!(preDiscountTotal > 0)) return 0;
  return Math.min(round2(gross * (discount / preDiscountTotal)), round2(discount));
}

// Reparte un descuento entre ingreso de producto y de servicio según su
// peso -- mismo criterio que generateSaleEntry, para que la reversa sea
// simétrica al reconocimiento.
function splitRevenueDiscount(productRevenue, serviceRevenue, discount) {
  const base = productRevenue + serviceRevenue;
  if (!(discount > 0) || !(base > 0)) return { productRevenue, serviceRevenue };
  const productDiscount = Math.round(discount * (productRevenue / base));
  return {
    productRevenue: productRevenue - productDiscount,
    serviceRevenue: serviceRevenue - (discount - productDiscount),
  };
}

module.exports = { discountShare, splitRevenueDiscount, round2 };
