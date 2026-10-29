// backend/src/utils/salePricing.js
//
// Precio de venta sugerido a partir del costo y el margen de ganancia del
// producto. El margen es SOBRE LA VENTA (no un recargo sobre el costo):
//
//   precio sin impuestos = costo / (1 − margen / 100)
//
// Con costo 100 y margen 30 % el precio es 142,86 y la ganancia (42,86) es
// el 30 % del precio. Si el producto maneja el precio con impuestos incluidos
// (price_includes_tax), se le suman IVA + INC con las mismas tarifas con que
// taxService.calculateItemTaxes los extrae al vender, para que la base neta
// de la venta conserve el margen. Gemelo en frontend/src/utils/salePricing.js.

const MAX_MARGIN = 99.99;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Igual que calculateItemTaxes: excluido o has_tax=false no llevan impuesto;
// exento lleva IVA 0 %; sin tarifa se asume 19 %.
function includedTaxRate(product) {
  if (!product?.price_includes_tax) return 0;
  const status = product?.tax_config?.iva_status;
  if (product?.has_tax === false || status === 'excluido') return 0;
  const ivaRate = status === 'exento' ? 0 : Number(product?.tax_percentage ?? 19) || 0;
  const inc = product?.tax_config?.inc;
  const incRate = inc?.enabled && inc?.rate > 0 ? Number(inc.rate) : 0;
  return ivaRate + incRate;
}

function isValidMargin(margin) {
  const m = parseFloat(margin);
  return Number.isFinite(m) && m >= 0 && m <= MAX_MARGIN;
}

/**
 * @param {number} cost    costo unitario sin IVA
 * @param {number} margin  margen sobre la venta, 0 a 99,99
 * @param {object} product { price_includes_tax, has_tax, tax_percentage, tax_config }
 * @returns {number|null}  valor para base_price (con impuestos si el producto los incluye)
 */
function suggestedSalePrice(cost, margin, product = {}) {
  const c = parseFloat(cost);
  const m = parseFloat(margin);
  if (!Number.isFinite(c) || c <= 0 || !isValidMargin(m)) return null;
  const net = c / (1 - m / 100);
  return round2(net * (1 + includedTaxRate(product) / 100));
}

// Precio de venta real del producto. El que se cobra y se edita en el formulario es
// base_price; sale_price es un campo heredado que casi nunca se llena (queda en 0).
function productSalePrice(product = {}) {
  const base = parseFloat(product.base_price) || 0;
  return base > 0 ? base : parseFloat(product.sale_price) || 0;
}

module.exports = { suggestedSalePrice, includedTaxRate, isValidMargin, productSalePrice, MAX_MARGIN };
