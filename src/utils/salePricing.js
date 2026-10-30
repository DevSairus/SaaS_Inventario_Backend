// backend/src/utils/salePricing.js
//
// Precio de venta sugerido a partir del costo y el margen de ganancia del
// producto. Cada tenant elige cómo se interpreta el porcentaje
// (tenants.business_config.margin_method):
//
//   'on_sale' (por defecto) margen SOBRE LA VENTA:
//       precio sin impuestos = costo / (1 − margen / 100)
//       costo 100 y 30 % → 142,86; la ganancia (42,86) es el 30 % del precio.
//   'markup' RECARGO sobre el costo (lo que había antes del 2026-10-27):
//       precio sin impuestos = costo × (1 + margen / 100)
//       costo 100 y 30 % → 130.
//
// Si el producto maneja el precio con impuestos incluidos
// (price_includes_tax), se le suman IVA + INC con las mismas tarifas con que
// taxService.calculateItemTaxes los extrae al vender, para que la base neta
// de la venta conserve el margen. Gemelo en frontend/src/utils/salePricing.js.

const MARGIN_METHODS = ['on_sale', 'markup'];
const DEFAULT_MARGIN_METHOD = 'on_sale';
const MAX_MARGIN = 99.99;
// profit_margin_percentage es DECIMAL(5,2): el recargo llega hasta 999,99 %.
const MAX_MARKUP = 999.99;
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

function normalizeMarginMethod(method) {
  return MARGIN_METHODS.includes(method) ? method : DEFAULT_MARGIN_METHOD;
}

function maxMarginFor(method) {
  return normalizeMarginMethod(method) === 'markup' ? MAX_MARKUP : MAX_MARGIN;
}

function isValidMargin(margin, method) {
  const m = parseFloat(margin);
  return Number.isFinite(m) && m >= 0 && m <= maxMarginFor(method);
}

// Mensaje de error para un margen fuera de rango según el método del tenant.
function marginRangeMessage(method) {
  return normalizeMarginMethod(method) === 'markup'
    ? 'El margen es un recargo sobre el costo: debe estar entre 0 y 999,99 %'
    : 'El margen es sobre el precio de venta: debe estar entre 0 y 99,99 %';
}

/**
 * @param {number} cost    costo unitario sin IVA
 * @param {number} margin  porcentaje (0 a 99,99 sobre la venta; 0 a 999,99 recargo)
 * @param {object} product { price_includes_tax, has_tax, tax_percentage, tax_config }
 * @param {string} method  'on_sale' | 'markup' (business_config.margin_method)
 * @returns {number|null}  valor para base_price (con impuestos si el producto los incluye)
 */
function suggestedSalePrice(cost, margin, product = {}, method = DEFAULT_MARGIN_METHOD) {
  const c = parseFloat(cost);
  const m = parseFloat(margin);
  if (!Number.isFinite(c) || c <= 0 || !isValidMargin(m, method)) return null;
  const net = normalizeMarginMethod(method) === 'markup' ? c * (1 + m / 100) : c / (1 - m / 100);
  return round2(net * (1 + includedTaxRate(product) / 100));
}

// Precio de venta real del producto. El que se cobra y se edita en el formulario es
// base_price; sale_price es un campo heredado que casi nunca se llena (queda en 0).
function productSalePrice(product = {}) {
  const base = parseFloat(product.base_price) || 0;
  return base > 0 ? base : parseFloat(product.sale_price) || 0;
}

module.exports = {
  suggestedSalePrice, includedTaxRate, isValidMargin, productSalePrice, normalizeMarginMethod,
  maxMarginFor, marginRangeMessage, MARGIN_METHODS, DEFAULT_MARGIN_METHOD, MAX_MARGIN, MAX_MARKUP,
};
