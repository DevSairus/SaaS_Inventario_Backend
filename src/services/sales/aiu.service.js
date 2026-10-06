// backend/src/services/sales/aiu.service.js
//
// Facturación AIU (Administración, Imprevistos, Utilidad) -- contratos de
// servicios donde el IVA se liquida solo sobre la Utilidad (Art. 462-1 E.T.
// para aseo, vigilancia y temporales; Decreto 1372 de 1992 art. 3 para
// contratos de construcción).
//
// Modelo de cálculo (el estándar en Colombia):
//   CD (costo directo) = suma de las líneas de la venta, sin IVA
//   A = CD × admin_pct%     I = CD × unforeseen_pct%     U = CD × profit_pct%
//   IVA = U × iva_rate%
//   Subtotal = CD + A + I + U            Total = Subtotal + IVA
//
// Las líneas de la venta quedan con IVA 0 (el IVA del contrato es solo el de
// la Utilidad). Los porcentajes por defecto y la base de ReteFuente salen de
// tenant.tax_config.aiu; cada venta guarda sus propios porcentajes.
//
// Base de ReteFuente configurable por tenant (aiu.retefuente_base):
//   'total' -> CD + A + I + U (p.ej. contratos de construcción)
//   'aiu'   -> A + I + U      (p.ej. vigilancia, aseo, temporales)
// ReteICA se calcula sobre el total del contrato y ReteIVA sobre el IVA.

'use strict';

// enabled: el tenant usa facturación AIU (Ajustes → Impuestos). Apagado por
// defecto: un taller que no factura AIU no ve la opción en ningún lado.
const AIU_DEFAULTS = { enabled: false, admin_pct: 10, unforeseen_pct: 5, profit_pct: 5, iva_rate: 19, retefuente_base: 'total' };
const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

function tenantAiuConfig(tenantTaxConfig) {
  return { ...AIU_DEFAULTS, ...(tenantTaxConfig?.aiu || {}) };
}

/**
 * Resuelve la configuración AIU de una venta a partir del body (y de la venta
 * existente en una edición). Devuelve null si la venta no es AIU.
 */
function resolveAiu(body, tenantTaxConfig, existingSale = null) {
  const enabled = body.aiu_enabled !== undefined ? !!body.aiu_enabled : !!existingSale?.aiu_enabled;
  if (!enabled) return null;
  const defaults = tenantAiuConfig(tenantTaxConfig);
  // Una venta que ya es AIU se puede seguir editando aunque luego se apague
  // la opción; una nueva no.
  if (!defaults.enabled && !existingSale?.aiu_enabled) {
    const err = new Error('La facturación AIU no está habilitada. Actívela en Ajustes → Impuestos.');
    err.statusCode = 400;
    throw err;
  }
  const pick = (key) => {
    const fromBody = body[`aiu_${key}`];
    if (fromBody !== undefined && fromBody !== null && fromBody !== '') return Number(fromBody);
    if (existingSale?.aiu_enabled && existingSale[`aiu_${key}`] != null) return Number(existingSale[`aiu_${key}`]);
    return Number(defaults[key]);
  };
  const aiu = {
    admin_pct: pick('admin_pct'),
    unforeseen_pct: pick('unforeseen_pct'),
    profit_pct: pick('profit_pct'),
    iva_rate: Number(defaults.iva_rate),
    retefuente_base: defaults.retefuente_base === 'aiu' ? 'aiu' : 'total',
    object: (body.aiu_object !== undefined ? body.aiu_object : existingSale?.aiu_object) || '',
  };
  for (const k of ['admin_pct', 'unforeseen_pct', 'profit_pct']) {
    if (!Number.isFinite(aiu[k]) || aiu[k] < 0 || aiu[k] > 100) {
      const err = new Error('Los porcentajes de AIU deben estar entre 0 y 100');
      err.statusCode = 400;
      throw err;
    }
  }
  if (!(aiu.profit_pct > 0)) {
    const err = new Error('En una factura AIU la Utilidad debe ser mayor a 0 (es la base del IVA)');
    err.statusCode = 400;
    throw err;
  }
  return aiu;
}

/**
 * Aplica AIU sobre las líneas ya calculadas de una venta (mutándolas: IVA,
 * INC e ICA en 0, total = subtotal). Devuelve los montos del contrato y los
 * campos a persistir en Sale.
 */
function applyAiu(items, aiu) {
  for (const it of items) {
    it.tax_percentage = 0;
    it.tax_amount = 0;
    if ('inc_amount' in it) { it.inc_rate = 0; it.inc_amount = 0; }
    if ('ica_amount' in it) { it.ica_rate = 0; it.ica_amount = 0; }
    // subtotal de las líneas libres viene antes de descuento; el costo
    // directo es siempre lo efectivamente cobrado por la línea.
    it.total = round2(Number(it.subtotal || 0) - (it.item_type === 'free_line' ? Number(it.discount_amount || 0) : 0));
  }
  const direct = round2(items.reduce((s, it) => s + Number(it.total || 0), 0));
  const admin = round2(direct * aiu.admin_pct / 100);
  const unforeseen = round2(direct * aiu.unforeseen_pct / 100);
  const profit = round2(direct * aiu.profit_pct / 100);
  const iva = round2(profit * aiu.iva_rate / 100);
  const subtotal = round2(direct + admin + unforeseen + profit);

  return {
    direct, admin, unforeseen, profit, iva, subtotal,
    total: round2(subtotal + iva),
    fields: {
      aiu_enabled: true,
      aiu_admin_pct: aiu.admin_pct,
      aiu_unforeseen_pct: aiu.unforeseen_pct,
      aiu_profit_pct: aiu.profit_pct,
      aiu_direct_amount: direct,
      aiu_admin_amount: admin,
      aiu_unforeseen_amount: unforeseen,
      aiu_profit_amount: profit,
      aiu_object: aiu.object || null,
    },
  };
}

// Campos para apagar AIU en una venta que lo tenía.
const AIU_OFF_FIELDS = {
  aiu_enabled: false,
  aiu_admin_pct: null, aiu_unforeseen_pct: null, aiu_profit_pct: null,
  aiu_direct_amount: null, aiu_admin_amount: null, aiu_unforeseen_amount: null, aiu_profit_amount: null,
  aiu_object: null,
};

/**
 * Líneas sintéticas para calculateRetentions/buildTaxBreakdown: una con la
 * base de ReteFuente/ReteICA y otra con el IVA sobre la Utilidad.
 */
function aiuTaxLines(result, aiu) {
  return [{ subtotal: result.profit, tax_percentage: aiu.iva_rate, tax_amount: result.iva }];
}

function aiuRetentionBases(result, aiu) {
  return {
    retefuente: aiu.retefuente_base === 'aiu' ? round2(result.admin + result.unforeseen + result.profit) : result.subtotal,
    reteica: result.subtotal,
  };
}

/**
 * Líneas adicionales del XML DIAN (Administración, Imprevistos, Utilidad) a
 * partir de una venta AIU ya guardada. IVA solo en la de Utilidad. Se omiten
 * las de valor 0 (la DIAN exige precio positivo).
 */
function aiuDianLines(sale) {
  const pct = (v) => `${Number(v || 0)}%`;
  const ivaAmount = round2(Number(sale.tax_amount || 0));
  const profit = Number(sale.aiu_profit_amount || 0);
  const ivaRate = profit > 0 ? round2(ivaAmount / profit * 100) : 0;
  return [
    { key: 'A', product_name: `Administración (${pct(sale.aiu_admin_pct)})`, amount: Number(sale.aiu_admin_amount || 0), rate: 0, tax: 0 },
    { key: 'I', product_name: `Imprevistos (${pct(sale.aiu_unforeseen_pct)})`, amount: Number(sale.aiu_unforeseen_amount || 0), rate: 0, tax: 0 },
    { key: 'U', product_name: `Utilidad (${pct(sale.aiu_profit_pct)})`, amount: profit, rate: ivaRate, tax: ivaAmount },
  ]
    .filter((l) => l.amount > 0)
    .map((l) => ({
      id: `AIU-${l.key}`,
      product_name: l.product_name,
      quantity: 1,
      unit_price: l.amount,
      subtotal: l.amount,
      tax_percentage: l.rate,
      tax_amount: l.tax,
    }));
}

/**
 * Nota crédito sobre una factura AIU: las líneas acreditadas son costo
 * directo (IVA 0); A, I, U y el IVA se acreditan en la misma proporción
 * (costo directo de la nota / costo directo de la factura). Devuelve los
 * campos AIU de la nota y su subtotal/IVA. Con proporción 1 (devolución
 * total) los valores son exactamente los de la factura.
 */
function prorateAiu(original, noteDirect) {
  const origDirect = Number(original.aiu_direct_amount || 0);
  const ratio = origDirect > 0 ? Math.min(noteDirect / origDirect, 1) : 0;
  const part = (v) => (ratio === 1 ? round2(v) : round2(Number(v || 0) * ratio));
  const admin = part(original.aiu_admin_amount);
  const unforeseen = part(original.aiu_unforeseen_amount);
  const profit = part(original.aiu_profit_amount);
  const iva = part(original.tax_amount);
  const direct = round2(noteDirect);
  return {
    subtotal: round2(direct + admin + unforeseen + profit),
    tax: iva,
    fields: {
      aiu_enabled: true,
      aiu_admin_pct: original.aiu_admin_pct,
      aiu_unforeseen_pct: original.aiu_unforeseen_pct,
      aiu_profit_pct: original.aiu_profit_pct,
      aiu_direct_amount: direct,
      aiu_admin_amount: admin,
      aiu_unforeseen_amount: unforeseen,
      aiu_profit_amount: profit,
      aiu_object: original.aiu_object,
    },
  };
}

module.exports = {
  prorateAiu,
  AIU_DEFAULTS, AIU_OFF_FIELDS, tenantAiuConfig, resolveAiu, applyAiu, aiuTaxLines, aiuRetentionBases, aiuDianLines,
};
