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
  let base = grossBase - discount;

  // ── INC / Impoconsumo (04) — tarifa del producto; se liquida sobre la
  // misma base sin IVA (no es impuesto sobre impuesto).
  const incConfig = product?.tax_config?.inc;
  const incRate = (incConfig?.enabled && incConfig?.rate > 0) ? Number(incConfig.rate) : 0;

  // ── IVA (01) ──
  // Tratamiento del producto (tax_config.iva_status): 'gravado' (19 % / 5 %),
  // 'exento' (tarifa 0 %, sí es IVA) o 'excluido' (no causa IVA: la DIAN no
  // lo informa como impuesto). Sin marcar = como siempre: con tarifa >0
  // gravado y en 0 % exento.
  let ivaRate = 0;
  const declaredStatus = product?.tax_config?.iva_status;
  const hasTax = product?.has_tax !== false && declaredStatus !== 'excluido';
  if (hasTax && declaredStatus !== 'exento') {
    ivaRate = Number(item.tax_percentage ?? product?.tax_percentage ?? (context === 'sale' ? 19 : 0));
  }
  const ivaStatus = declaredStatus === 'excluido' ? 'excluido' : ivaRate > 0 ? 'gravado' : 'exento';
  // Precio con impuestos incluidos: se extraen IVA e INC juntos para que la
  // base quede neta y base + IVA + INC = precio. Antes solo se extraía el IVA
  // y el INC se sumaba encima del precio "con impuestos incluidos".
  if (hasTax && product?.price_includes_tax) {
    base = base / (1 + (ivaRate + incRate) / 100);
  }
  const ivaAmount = base * ivaRate / 100;
  const incAmount = base * incRate / 100;

  // ── ICA (03) ──
  // El ICA es un impuesto a cargo del vendedor sobre sus ingresos: no se le
  // cobra al cliente ni va en la factura. Se causa por período y municipio
  // (ver services/tax/ica.service.js). Se conserva la forma { rate, amount }
  // en 0 para no romper a quien lee estos campos.
  const icaRate = 0;
  const icaAmount = 0;

  return {
    base: round(base),
    discount: round(discount),
    iva: { rate: round(ivaRate), amount: round(ivaAmount), status: ivaStatus },
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
function calculateRetentions(items, tenantConfig, entityConfig, context = 'sale', baseOverrides = {}) {
  const zero = { retefuente: { rate: 0, amount: 0 }, reteiva: { rate: 0, amount: 0 }, reteica: { rate: 0, amount: 0 }, total: 0 };
  if (context === 'sale') return calculateSaleRetentions(items, tenantConfig || {}, entityConfig || {}, baseOverrides, zero);

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

  // Base = suma de subtotales (sin IVA). Una factura AIU trae sus propias
  // bases (ver services/sales/aiu.service.js#aiuRetentionBases).
  const base = items.reduce((s, i) => s + Number(i.subtotal || i.base || 0), 0);
  const retefuenteBase = baseOverrides.retefuente ?? base;
  const reteicaBase = baseOverrides.reteica ?? base;

  // Total IVA facturado
  const totalIVA = items.reduce((s, i) => s + Number(i.tax_amount || i.iva?.amount || 0), 0);

  // Tarifas por defecto del tenant (Ajustes → Impuestos): solo cuentan las
  // ACTIVADAS. Antes se usaba la tarifa aunque el interruptor estuviera
  // apagado, y la pantalla guarda 2,5 % / 15 % / 4 ‰ apagadas por defecto.
  // Sin el campo enabled (configuración vieja) se toma como activa.
  const tenantDefault = (code) => tenantConfig?.retentions?.find(r => r.code === code && r.enabled !== false);

  // ── ReteFuente (07) — sobre base gravable ──
  const tenantReteFuente = tenantDefault('07');
  const retefuenteRate = Number(entityConfig?.retefuente_rate ?? tenantReteFuente?.rate ?? 0);
  const retefuente = retefuenteBase * retefuenteRate / 100;

  // ── ReteIVA (05) — sobre el IVA facturado ──
  const tenantReteIVA = tenantDefault('05');
  const reteivaRate = Number(entityConfig?.reteiva_rate ?? tenantReteIVA?.rate ?? 0);
  const reteiva = totalIVA * reteivaRate / 100;

  // ── ReteICA (06) — sobre base gravable, en ‰ ──
  const tenantReteICA = tenantDefault('06');
  const reteicaRate = Number(entityConfig?.reteica_rate ?? tenantReteICA?.rate ?? 0);
  const reteica = reteicaBase * reteicaRate / 1000;

  return {
    retefuente: { rate: round(retefuenteRate), amount: round(retefuente) },
    reteiva:    { rate: round(reteivaRate),    amount: round(reteiva) },
    reteica:    { rate: round(reteicaRate),    amount: round(reteica) },
    total: round(retefuente + reteiva + reteica),
  };
}

/* ──────────────────────────────────────────────────────────
 * Retenciones que el CLIENTE le practicará al tenant (estimación de venta).
 *
 * - Solo si el cliente es agente de retención: retention_config.withholding_agent
 *   (sí/no explícito en su ficha) o, si no se ha indicado, según su documento:
 *   NIT (31) = sí, cédula u otros = no. Antes se le estimaban a TODOS los
 *   clientes no exentos, incluidos consumidores finales que nunca retienen.
 * - Tarifas: las propias del cliente o, si no tiene, las por defecto ACTIVAS
 *   del tenant (Ajustes → Impuestos). ReteFuente separa bienes (rate) y
 *   servicios (service_rate).
 * - Base mínima: ReteFuente y ReteIVA solo aplican si la base de bienes o de
 *   servicios llega al mínimo en UVT de los conceptos "Compras generales" y
 *   "Servicios generales" (mismo catálogo de compras, tax_config.retention_concepts,
 *   y el valor UVT de fiscal_profile). ReteICA: tarifa municipal sin mínimo.
 * ────────────────────────────────────────────────────────── */
const SERVICE_ITEM_TYPES = new Set(['service', 'free_line']);

// El descuento global de una venta/OT se resta después de impuestos: reduce
// la base y el IVA sujetos a retención en la misma proporción.
function scaleRetentions(ret, preDiscountTotal, globalDiscount) {
  const pre = parseFloat(preDiscountTotal) || 0;
  const gd = parseFloat(globalDiscount) || 0;
  if (pre <= 0 || gd <= 0) return ret;
  const f = Math.max(pre - gd, 0) / pre;
  const r2 = (v) => Math.round(v * f * 100) / 100;
  const out = {
    retefuente: { ...ret.retefuente, amount: r2(ret.retefuente.amount) },
    reteiva:    { ...ret.reteiva,    amount: r2(ret.reteiva.amount) },
    reteica:    { ...ret.reteica,    amount: r2(ret.reteica.amount) },
  };
  out.total = Math.round((out.retefuente.amount + out.reteiva.amount + out.reteica.amount) * 100) / 100;
  return out;
}
function isWithholdingAgent(cfg) {
  if (cfg.withholding_agent === true || cfg.withholding_agent === false) return cfg.withholding_agent;
  return String(cfg.document_type || '') === '31';
}

// Ficha del cliente -> config de retención con su tipo de documento (para el
// valor por defecto de "agente de retención").
function customerRetentionConfig(customer) {
  if (!customer) return {};
  const json = customer.toJSON ? customer.toJSON() : customer;
  return { ...(json.retention_config || {}), document_type: json.document_type };
}

function saleRetentionThresholds(tenantConfig) {
  const { DEFAULT_RETENTION_CONCEPTS, DEFAULT_UVT_VALUE } = require('../data/retention-concepts-default');
  const concepts = Array.isArray(tenantConfig.retention_concepts) && tenantConfig.retention_concepts.length
    ? tenantConfig.retention_concepts : DEFAULT_RETENTION_CONCEPTS;
  const uvt = Number(tenantConfig.fiscal_profile?.uvt_value) > 0 ? Number(tenantConfig.fiscal_profile.uvt_value) : DEFAULT_UVT_VALUE;
  const minOf = (id) => Number((concepts.find(c => c.id === id) || DEFAULT_RETENTION_CONCEPTS.find(c => c.id === id))?.min_base_uvt || 0) * uvt;
  return { goods: minOf('compras'), services: minOf('servicios'), uvt };
}

function calculateSaleRetentions(items, tenantConfig, cfg, baseOverrides, zero) {
  if (cfg.is_exento) return zero;
  if (tenantConfig.is_autoretenedor) return zero;
  if (!isWithholdingAgent(cfg)) return zero;

  const tenantDefault = (code) => tenantConfig.retentions?.find(r => r.code === code && r.enabled !== false);
  const own = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const rfDefault = tenantDefault('07');
  const rfGoodsRate = own(cfg.retefuente_rate) ?? Number(rfDefault?.rate ?? 0);
  // Sin tarifa de servicios guardada: 4 % (Servicios generales), lo mismo que
  // muestra Ajustes → Impuestos por defecto.
  const rfServicesRate = own(cfg.retefuente_service_rate) ?? own(cfg.retefuente_rate)
    ?? Number(rfDefault ? (rfDefault.service_rate ?? 4) : 0);
  const reteivaRate = own(cfg.reteiva_rate) ?? Number(tenantDefault('05')?.rate ?? 0);
  const reteicaRate = own(cfg.reteica_rate) ?? Number(tenantDefault('06')?.rate ?? 0);

  const min = saleRetentionThresholds(tenantConfig);
  const lines = items || [];
  const isService = (i) => SERVICE_ITEM_TYPES.has(i.item_type);
  const sum = (arr, f) => arr.reduce((s, i) => s + Number(f(i) || 0), 0);
  const goods = lines.filter(i => !isService(i));
  const services = lines.filter(isService);

  let retefuente = 0;
  let reteivaBase = 0;
  let reteicaBase;
  let rfBase = 0;
  if (baseOverrides.retefuente !== undefined) {
    // Factura AIU: base propia; es un contrato de servicios.
    const base = Number(baseOverrides.retefuente) || 0;
    if (base >= min.services) { retefuente = base * rfServicesRate / 100; rfBase = base; reteivaBase = sum(lines, i => i.tax_amount); }
    reteicaBase = baseOverrides.reteica ?? base;
  } else {
    const goodsBase = sum(goods, i => i.subtotal ?? i.base);
    const servicesBase = sum(services, i => i.subtotal ?? i.base);
    if (goodsBase > 0 && goodsBase >= min.goods) {
      retefuente += goodsBase * rfGoodsRate / 100; rfBase += goodsBase; reteivaBase += sum(goods, i => i.tax_amount);
    }
    if (servicesBase > 0 && servicesBase >= min.services) {
      retefuente += servicesBase * rfServicesRate / 100; rfBase += servicesBase; reteivaBase += sum(services, i => i.tax_amount);
    }
    reteicaBase = goodsBase + servicesBase;
  }
  // ReteIVA sobre el IVA de lo que sí supera el mínimo (el INC no es IVA).
  const reteiva = reteivaBase * reteivaRate / 100;
  const reteica = Number(reteicaBase || 0) * reteicaRate / 1000;
  // Tarifa efectiva de ReteFuente (bienes y servicios pueden ir a tarifas distintas).
  const rfRate = rfBase > 0 ? retefuente / rfBase * 100 : 0;

  return {
    retefuente: { rate: round(rfRate), amount: round(retefuente) },
    reteiva:    { rate: round(reteiva > 0 ? reteivaRate : 0), amount: round(reteiva) },
    reteica:    { rate: round(reteica > 0 ? reteicaRate : 0), amount: round(reteica) },
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

/* ──────────────────────────────────────────────────────────
 * Impuestos de un documento de venta calculados desde sus líneas -- la misma
 * fuente que el total (suma de los totales de línea). Para mostrar en PDF,
 * link público y detalle: el tax_breakdown guardado puede quedar desfasado
 * (cotizaciones editadas con versiones anteriores, aprobaciones parciales).
 * La base de cada línea es total - IVA - INC: sirve también para líneas
 * libres viejas, que guardaban el subtotal bruto (antes del descuento).
 * Ignora líneas rechazadas por el cliente. Solo impuestos (type 'tax').
 * ────────────────────────────────────────────────────────── */
function taxLinesFromItems(items) {
  const lines = (items || [])
    .map(i => (i && i.toJSON ? i.toJSON() : i))
    .filter(i => i && i.approval_status !== 'rechazado')
    .map(i => ({
      ...i,
      subtotal: Number(i.total || 0) - Number(i.tax_amount || 0) - Number(i.inc_amount || 0),
    }));
  return buildTaxBreakdown(lines, null).filter(t => t.type === 'tax');
}

module.exports = {
  taxLinesFromItems,
  scaleRetentions,
  customerRetentionConfig,
  isWithholdingAgent,
  saleRetentionThresholds,
  calculateItemTaxes,
  calculateRetentions,
  calculatePurchaseRetentions,
  purchaseRetentionFields,
  sanitizeRetentionConcepts,
  RETENTION_TYPES,
  buildTaxBreakdown,
  round,
};
