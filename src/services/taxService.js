// backend/src/services/taxService.js
/**
 * Servicio centralizado de cálculo de impuestos y retenciones.
 * Soporta: IVA (01), INC/Impoconsumo (04), ICA (03), ReteIVA (05), ReteICA (06), ReteFuente (07)
 */

'use strict';

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* ──────────────────────────────────────────────────────────
 * Calcula impuestos de un ítem de venta/compra
 *
 * @param {object} item       - { quantity, unit_price, discount_percentage?, discount_amount?, tax_percentage? }
 * @param {object} product    - { has_tax, tax_percentage, price_includes_tax, tax_config }
 * @param {string} context    - 'sale' | 'purchase' (para defaults distintos)
 * @param {object} tenantConfig - tenant.tax_config (Fase D: fuente de las tarifas ICA por categoría económica)
 * @returns {object}          - { iva, inc, ica, total_taxes, base }
 * ────────────────────────────────────────────────────────── */
function calculateItemTaxes(item, product, context = 'sale', tenantConfig = {}) {
  const qty = Number(item.quantity || 1);
  const unitPrice = Number(item.unit_price || item.unit_cost || 0);
  const discPct = Number(item.discount_percentage || 0);
  const discAmt = Number(item.discount_amount || 0);

  const grossBase = qty * unitPrice;
  const discount = discAmt > 0 ? discAmt : grossBase * discPct / 100;
  const base = grossBase - discount;

  // ── IVA (01) ──
  let ivaRate = 0;
  let ivaAmount = 0;
  const hasTax = product?.has_tax !== false;
  if (hasTax) {
    ivaRate = Number(item.tax_percentage ?? product?.tax_percentage ?? (context === 'sale' ? 19 : 0));
    const priceIncludesTax = product?.price_includes_tax || false;
    if (priceIncludesTax) {
      ivaAmount = base * ivaRate / (100 + ivaRate);
    } else {
      ivaAmount = base * ivaRate / 100;
    }
  }

  // ── INC / Impoconsumo (04) — sobre base SIN IVA ──
  const incConfig = product?.tax_config?.inc;
  const incRate = (incConfig?.enabled && incConfig?.rate > 0) ? Number(incConfig.rate) : 0;
  const incAmount = base * incRate / 100;

  // ── ICA (03) — sobre base SIN IVA, se expresa en ‰ (milesimas) ──
  // Fase D: el producto puede fijar una tarifa manual (icaConfig.rate, legado)
  // o referenciar una categoría económica (icaConfig.category) cuya tarifa
  // vive en tenant.tax_config.ica_categories — la carga y mantiene cada
  // tenant según su propio municipio, no hay tabla nacional aquí. Si hay
  // categoría, esta manda: así un cambio de tarifa se refleja para todos
  // los productos de esa categoría sin editarlos uno por uno.
  const icaConfig = product?.tax_config?.ica;
  let icaRate = 0;
  if (icaConfig?.enabled) {
    if (icaConfig.category) {
      const cat = (tenantConfig?.ica_categories || []).find(c => c.key === icaConfig.category);
      icaRate = Number(cat?.rate || 0);
    } else {
      icaRate = Number(icaConfig.rate || 0);
    }
  }
  const icaAmount = base * icaRate / 1000;

  return {
    base: round(base),
    iva: { rate: round(ivaRate), amount: round(ivaAmount) },
    inc: { rate: round(incRate), amount: round(incAmount) },
    ica: { rate: round(icaRate), amount: round(icaAmount) },
    total_taxes: round(ivaAmount + incAmount + icaAmount),
    total_line: round(base + ivaAmount + incAmount + icaAmount),
  };
}

/* ──────────────────────────────────────────────────────────
 * Calcula retenciones a nivel documento (venta o compra)
 *
 * La retención la practica quien PAGA sobre quien RECIBE el pago. El campo
 * `is_autoretenedor` es una propiedad de quien RECIBE el pago (declarado
 * autorretenedor ante la DIAN, se retiene a sí mismo — nadie más debe
 * hacerlo). En una venta, quien recibe el pago es el tenant; en una compra,
 * es el proveedor. Por eso el lado que se revisa depende de `context`:
 * el tenant puede no ser autorretenedor, pero un proveedor puntual sí serlo
 * (o viceversa un cliente puntual), y eso debe bastar para no retenerle.
 *
 * `is_exento`, en cambio, siempre se evalúa sobre la contraparte
 * (customer.retention_config en venta, supplier.retention_config en
 * compra): es la entidad concreta con la que se hace la transacción la que
 * está exenta de que se le practique/practique retención, sin importar el
 * estado del tenant.
 *
 * @param {Array}   items         - Ítems ya calculados con tax_amount, inc_amount, etc.
 * @param {object}  tenantConfig  - tenant.tax_config (fuente de las tarifas por defecto configuradas por el tenant)
 * @param {object}  entityConfig  - customer.retention_config o supplier.retention_config (contraparte)
 * @param {string}  context       - 'sale' | 'purchase' (default 'sale') — determina de qué lado se revisa is_autoretenedor
 * @returns {object}              - { retefuente, reteiva, reteica, total }
 * ────────────────────────────────────────────────────────── */
function calculateRetentions(items, tenantConfig, entityConfig, context = 'sale') {
  const zero = { retefuente: { rate: 0, amount: 0 }, reteiva: { rate: 0, amount: 0 }, reteica: { rate: 0, amount: 0 }, total: 0 };

  // No aplicar si la contraparte (cliente en venta, proveedor en compra) está exenta
  if (entityConfig?.is_exento) return zero;

  // No aplicar si quien RECIBE el pago es autorretenedor:
  // - en venta, quien recibe el pago es el tenant → tenantConfig.is_autoretenedor
  // - en compra, quien recibe el pago es el proveedor → entityConfig.is_autoretenedor
  // Nota: el tenant puede no ser autorretenedor y aun así el proveedor sí
  // serlo (muy común) — por eso no se puede revisar solo tenantConfig.
  const payeeIsAutoretenedor = context === 'purchase'
    ? entityConfig?.is_autoretenedor
    : tenantConfig?.is_autoretenedor;
  if (payeeIsAutoretenedor) return zero;

  // Base = suma de subtotales (sin IVA)
  const base = items.reduce((s, i) => s + Number(i.subtotal || i.base || 0), 0);

  // Total IVA facturado
  const totalIVA = items.reduce((s, i) => s + Number(i.tax_amount || i.iva?.amount || 0), 0);

  // ── ReteFuente (07) — sobre base gravable ──
  const tenantReteFuente = tenantConfig?.retentions?.find(r => r.code === '07');
  const retefuenteRate = Number(entityConfig?.retefuente_rate ?? tenantReteFuente?.rate ?? 0);
  const retefuente = base * retefuenteRate / 100;

  // ── ReteIVA (05) — sobre el IVA facturado ──
  const tenantReteIVA = tenantConfig?.retentions?.find(r => r.code === '05');
  const reteivaRate = Number(entityConfig?.reteiva_rate ?? tenantReteIVA?.rate ?? 0);
  const reteiva = totalIVA * reteivaRate / 100;

  // ── ReteICA (06) — sobre base gravable, en ‰ ──
  const tenantReteICA = tenantConfig?.retentions?.find(r => r.code === '06');
  const reteicaRate = Number(entityConfig?.reteica_rate ?? tenantReteICA?.rate ?? 0);
  const reteica = base * reteicaRate / 1000;

  return {
    retefuente: { rate: round(retefuenteRate), amount: round(retefuente) },
    reteiva:    { rate: round(reteivaRate),    amount: round(reteiva) },
    reteica:    { rate: round(reteicaRate),    amount: round(reteica) },
    total: round(retefuente + reteiva + reteica),
  };
}

/* ──────────────────────────────────────────────────────────
 * Retenciones detalladas por concepto (compras)
 *
 * Un mismo proveedor puede tener varias tarifas del mismo tipo de retención
 * según lo que se le compre (ej. ReteFuente 2.5% compras, 4% servicios,
 * 11% honorarios), y cada concepto suele ir a su propia subcuenta del PUC
 * (236540 / 236525 / 236515). Por eso supplier.retention_config.retentions
 * es una lista de conceptos:
 *
 *   [{ id, code: '07'|'05'|'06', concept, rate, min_base?, account_id?, is_default? }]
 *
 * y la compra guarda en `applied_retentions` las líneas que realmente se
 * practicaron, cada una con su base (editable: una compra mixta de bienes
 * y servicios reparte el subtotal entre dos conceptos de ReteFuente).
 * Las columnas agregadas retefuente_amount/reteiva_amount/reteica_amount se
 * siguen llenando con la suma por tipo — de ahí leen Exógena (1001), el
 * asiento contable legado y los reportes existentes.
 * ────────────────────────────────────────────────────────── */
const RETENTION_TYPES = {
  '07': { key: 'retefuente', name: 'ReteFuente', divisor: 100 },
  '05': { key: 'reteiva', name: 'ReteIVA', divisor: 100 },
  '06': { key: 'reteica', name: 'ReteICA', divisor: 1000 },
};

/**
 * Normaliza/valida la lista de conceptos de retención de un proveedor
 * (lo que llega del formulario). Descarta filas sin código válido o con
 * tarifa no positiva, y garantiza un id estable por fila.
 */
function sanitizeRetentionConcepts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && RETENTION_TYPES[r.code] && Number(r.rate) > 0)
    .map((r, idx) => ({
      id: r.id || `${r.code}-${Date.now().toString(36)}-${idx}`,
      code: r.code,
      concept: String(r.concept || '').trim().slice(0, 120) || RETENTION_TYPES[r.code].name,
      rate: Number(r.rate),
      min_base: r.min_base !== undefined && r.min_base !== null && r.min_base !== '' ? Math.max(Number(r.min_base) || 0, 0) : 0,
      account_id: r.account_id || null,
      is_default: !!r.is_default,
    }));
}

/**
 * @param {Array}  items          - Ítems con subtotal/tax_amount.
 * @param {object} tenantConfig   - tenant.tax_config (fallback legado).
 * @param {object} supplierConfig - supplier.retention_config.
 * @param {Array|undefined} requested - Líneas elegidas en el formulario de compra
 *        ([{ code, concept, rate, base?, account_id?, retention_id? }]). Si es
 *        `undefined` (API, importación de facturas, cambio de proveedor) se usan
 *        los conceptos `is_default` del proveedor; si el proveedor no tiene
 *        conceptos configurados, se cae al cálculo legado (calculateRetentions).
 * @returns {object} - { retefuente, reteiva, reteica, total, lines }
 */
function calculatePurchaseRetentions(items, tenantConfig, supplierConfig, requested) {
  const config = supplierConfig || {};
  const empty = () => ({
    retefuente: { rate: 0, amount: 0 }, reteiva: { rate: 0, amount: 0 }, reteica: { rate: 0, amount: 0 }, total: 0, lines: [],
  });

  if (config.is_exento || config.is_autoretenedor) return empty();

  const concepts = sanitizeRetentionConcepts(config.retentions);
  const baseSubtotal = items.reduce((s, i) => s + Number(i.subtotal || i.base || 0), 0);
  const baseIva = items.reduce((s, i) => s + Number(i.tax_amount || i.iva?.amount || 0), 0);
  const defaultBaseFor = (code) => (code === '05' ? baseIva : baseSubtotal);

  let candidateLines;
  if (Array.isArray(requested)) {
    candidateLines = requested
      .filter((r) => r && RETENTION_TYPES[r.code] && Number(r.rate) > 0)
      .map((r) => {
        const hasBase = r.base !== undefined && r.base !== null && r.base !== '';
        return {
          retention_id: r.retention_id || r.id || null,
          code: r.code,
          concept: String(r.concept || '').trim() || RETENTION_TYPES[r.code].name,
          rate: Number(r.rate),
          base: hasBase ? Math.max(Number(r.base) || 0, 0) : defaultBaseFor(r.code),
          account_id: r.account_id || concepts.find((c) => c.id === (r.retention_id || r.id))?.account_id || null,
        };
      });
  } else if (concepts.length > 0) {
    candidateLines = concepts
      .filter((c) => c.is_default && defaultBaseFor(c.code) >= c.min_base)
      .map((c) => ({
        retention_id: c.id, code: c.code, concept: c.concept, rate: c.rate,
        base: defaultBaseFor(c.code), account_id: c.account_id,
      }));
  } else {
    // Proveedor sin conceptos configurados: comportamiento anterior
    // (tarifas del tenant / retefuente_rate sueltos en retention_config).
    const legacy = calculateRetentions(items, tenantConfig, config, 'purchase');
    const lines = [];
    for (const code of ['07', '05', '06']) {
      const t = RETENTION_TYPES[code];
      if (legacy[t.key].amount > 0) {
        lines.push({
          retention_id: null, code, concept: t.name, rate: legacy[t.key].rate,
          base: round(defaultBaseFor(code)), amount: legacy[t.key].amount, account_id: null,
        });
      }
    }
    return { ...legacy, lines };
  }

  const result = empty();
  const baseByKey = { retefuente: 0, reteiva: 0, reteica: 0 };
  for (const line of candidateLines) {
    const t = RETENTION_TYPES[line.code];
    const amount = round(line.base * line.rate / t.divisor);
    if (amount <= 0) continue;
    result.lines.push({ ...line, base: round(line.base), amount });
    result[t.key].amount = round(result[t.key].amount + amount);
    baseByKey[t.key] += line.base;
  }

  // Tarifa agregada por tipo: si hay una sola línea es su tarifa; si hay
  // varias, la tarifa efectiva ponderada (las columnas *_rate son solo
  // informativas, el detalle real vive en `lines`).
  for (const code of ['07', '05', '06']) {
    const t = RETENTION_TYPES[code];
    const linesOfType = result.lines.filter((l) => l.code === code);
    if (linesOfType.length === 1) result[t.key].rate = round(linesOfType[0].rate);
    else if (linesOfType.length > 1 && baseByKey[t.key] > 0) {
      result[t.key].rate = round(result[t.key].amount * t.divisor / baseByKey[t.key]);
    }
  }
  result.total = round(result.retefuente.amount + result.reteiva.amount + result.reteica.amount);
  return result;
}

/**
 * Campos de Purchase a partir del resultado de calculatePurchaseRetentions.
 */
function purchaseRetentionFields(retentions) {
  return {
    retefuente_rate:    retentions.retefuente.rate,
    retefuente_amount:  retentions.retefuente.amount,
    reteiva_rate:       retentions.reteiva.rate,
    reteiva_amount:     retentions.reteiva.amount,
    reteica_rate:       retentions.reteica.rate,
    reteica_amount:     retentions.reteica.amount,
    total_retentions:   retentions.total,
    applied_retentions: retentions.lines || [],
  };
}

/* ──────────────────────────────────────────────────────────
 * Construye el desglose de impuestos para tax_breakdown
 * ────────────────────────────────────────────────────────── */
function buildTaxBreakdown(items, retentions) {
  const breakdown = [];

  // Agrupar impuestos por tipo
  const groups = {};
  for (const item of items) {
    // IVA
    const ivaRate = Number(item.tax_percentage || item.iva?.rate || 0);
    if (ivaRate > 0) {
      const key = `iva_${ivaRate}`;
      if (!groups[key]) groups[key] = { code: '01', name: 'IVA', rate: ivaRate, taxable: 0, amount: 0 };
      groups[key].taxable += Number(item.subtotal || item.base || 0);
      groups[key].amount += Number(item.tax_amount || item.iva?.amount || 0);
    }

    // INC
    const incRate = Number(item.inc_rate || item.inc?.rate || 0);
    if (incRate > 0) {
      const key = `inc_${incRate}`;
      if (!groups[key]) groups[key] = { code: '04', name: 'INC', rate: incRate, taxable: 0, amount: 0 };
      groups[key].taxable += Number(item.subtotal || item.base || 0);
      groups[key].amount += Number(item.inc_amount || item.inc?.amount || 0);
    }

    // ICA
    const icaRate = Number(item.ica_rate || item.ica?.rate || 0);
    if (icaRate > 0) {
      const key = `ica_${icaRate}`;
      if (!groups[key]) groups[key] = { code: '03', name: 'ICA', rate: icaRate, taxable: 0, amount: 0 };
      groups[key].taxable += Number(item.subtotal || item.base || 0);
      groups[key].amount += Number(item.ica_amount || item.ica?.amount || 0);
    }
  }

  for (const g of Object.values(groups)) {
    breakdown.push({ type: 'tax', ...g, amount: round(g.amount) });
  }

  // Retenciones — con detalle por concepto cuando existe (compras)
  if (Array.isArray(retentions?.lines) && retentions.lines.length > 0) {
    for (const l of retentions.lines) {
      breakdown.push({
        type: 'retention', code: l.code, name: RETENTION_TYPES[l.code]?.name || l.code,
        concept: l.concept, rate: l.rate, taxable: l.base, amount: -l.amount,
      });
    }
    return breakdown;
  }
  if (retentions?.retefuente?.amount > 0) {
    breakdown.push({ type: 'retention', code: '07', name: 'ReteFuente', rate: retentions.retefuente.rate, amount: -retentions.retefuente.amount });
  }
  if (retentions?.reteiva?.amount > 0) {
    breakdown.push({ type: 'retention', code: '05', name: 'ReteIVA', rate: retentions.reteiva.rate, amount: -retentions.reteiva.amount });
  }
  if (retentions?.reteica?.amount > 0) {
    breakdown.push({ type: 'retention', code: '06', name: 'ReteICA', rate: retentions.reteica.rate, amount: -retentions.reteica.amount });
  }

  return breakdown;
}

module.exports = {
  calculateItemTaxes,
  calculateRetentions,
  calculatePurchaseRetentions,
  purchaseRetentionFields,
  sanitizeRetentionConcepts,
  RETENTION_TYPES,
  buildTaxBreakdown,
  round,
};
