/**
 * Utilidad para manejar números con precisión decimal en Node.js
 * Evita problemas de punto flotante en cálculos financieros
 */

/**
 * Redondea un número a N decimales con precisión
 * @param {number|string} value - Valor a redondear
 * @param {number} decimals - Número de decimales (default: 2)
 * @returns {number} - Número redondeado
 */
const roundToDecimals = (value, decimals = 2) => {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num) || !isFinite(num)) return 0;
  
  const factor = Math.pow(10, decimals);
  return Math.round((num + Number.EPSILON) * factor) / factor;
};

/**
 * Parsea un valor a número seguro
 * @param {number|string} value - Valor a parsear
 * @param {number} decimals - Decimales a mantener (default: 2)
 * @returns {number} - Número parseado
 */
const parseNumber = (value, decimals = 2) => {
  if (value === null || value === undefined || value === '') return 0;
  
  const num = parseFloat(value);
  if (isNaN(num) || !isFinite(num)) return 0;
  
  return roundToDecimals(num, decimals);
};

/**
 * Realiza cálculos con precisión decimal
 */
const calculate = {
  /**
   * Suma con precisión
   */
  add: (...values) => {
    const sum = values.reduce((acc, val) => acc + parseNumber(val, 4), 0);
    return roundToDecimals(sum, 2);
  },
  
  /**
   * Resta con precisión
   */
  subtract: (a, b) => {
    return roundToDecimals(parseNumber(a, 4) - parseNumber(b, 4), 2);
  },
  
  /**
   * Multiplicación con precisión
   */
  multiply: (a, b) => {
    return roundToDecimals(parseNumber(a, 4) * parseNumber(b, 4), 2);
  },
  
  /**
   * División con precisión
   */
  divide: (a, b) => {
    const divisor = parseNumber(b, 4);
    if (divisor === 0) return 0;
    return roundToDecimals(parseNumber(a, 4) / divisor, 2);
  },
  
  /**
   * Porcentaje
   */
  percentage: (value, percent) => {
    return roundToDecimals(parseNumber(value, 4) * (parseNumber(percent, 4) / 100), 2);
  },
  
  /**
   * Calcular subtotal (cantidad * precio)
   */
  subtotal: (quantity, price) => {
    return calculate.multiply(quantity, price);
  },
  
  /**
   * Calcular IVA
   */
  tax: (subtotal, taxPercent) => {
    return calculate.percentage(subtotal, taxPercent);
  },
  
  /**
   * Calcular total (subtotal + impuesto)
   */
  total: (subtotal, tax) => {
    return calculate.add(subtotal, tax);
  }
};

/**
 * Calcula los totales de un item de compra/venta
 * @param {number} quantity - Cantidad
 * @param {number} unitPrice - Precio unitario
 * @param {number} taxPercentage - Porcentaje de impuesto
 * @returns {object} - {subtotal, tax_amount, total}
 */
const calculateItemTotals = (quantity, unitPrice, taxPercentage = 19) => {
  const subtotal = calculate.subtotal(quantity, unitPrice);
  const tax_amount = calculate.tax(subtotal, taxPercentage);
  const total = calculate.total(subtotal, tax_amount);
  
  return {
    subtotal: roundToDecimals(subtotal, 2),
    tax_amount: roundToDecimals(tax_amount, 2),
    total: roundToDecimals(total, 2)
  };
};

/**
 * Calcula los totales de una lista de items
 * @param {Array} items - Array de items con {quantity, unit_price, tax_percentage}
 * @returns {object} - {subtotal, tax_amount, total_amount}
 */
const calculateOrderTotals = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { subtotal: 0, tax_amount: 0, total_amount: 0 };
  }
  
  const totals = items.reduce((acc, item) => {
    const itemTotals = calculateItemTotals(
      item.quantity,
      item.unit_price || item.unit_cost,
      item.tax_percentage || 19
    );
    
    return {
      subtotal: calculate.add(acc.subtotal, itemTotals.subtotal),
      tax_amount: calculate.add(acc.tax_amount, itemTotals.tax_amount),
      total_amount: calculate.add(acc.total_amount, itemTotals.total)
    };
  }, { subtotal: 0, tax_amount: 0, total_amount: 0 });
  
  return {
    subtotal: roundToDecimals(totals.subtotal, 2),
    tax_amount: roundToDecimals(totals.tax_amount, 2),
    total_amount: roundToDecimals(totals.total_amount, 2)
  };
};

/**
 * Valida y sanitiza los datos numéricos de un item
 * @param {object} item - Item a sanitizar
 * @returns {object} - Item con números sanitizados
 */
const sanitizeItemNumbers = (item) => {
  return {
    ...item,
    quantity: parseNumber(item.quantity, 2),
    unit_price: parseNumber(item.unit_price || item.unit_cost, 2),
    unit_cost: parseNumber(item.unit_price || item.unit_cost, 2),
    tax_percentage: parseNumber(item.tax_percentage, 2),
    discount_percentage: parseNumber(item.discount_percentage || 0, 2)
  };
};

/**
 * Procesa y calcula totales de items para una orden
 * @param {Array} items - Items de la orden
 * @returns {Array} - Items con totales calculados
 */
const processOrderItems = (items) => {
  if (!Array.isArray(items)) return [];
  
  return items.map(item => {
    const sanitized = sanitizeItemNumbers(item);
    const totals = calculateItemTotals(
      sanitized.quantity,
      sanitized.unit_price || sanitized.unit_cost,
      sanitized.tax_percentage
    );
    
    return {
      ...sanitized,
      subtotal: totals.subtotal,
      tax_amount: totals.tax_amount,
      total: totals.total
    };
  });
};

module.exports = {
  roundToDecimals,
  parseNumber,
  calculate,
  calculateItemTotals,
  calculateOrderTotals,
  sanitizeItemNumbers,
  processOrderItems
};