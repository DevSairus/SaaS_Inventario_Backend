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

  // Retenciones
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
  buildTaxBreakdown,
  round,
};
