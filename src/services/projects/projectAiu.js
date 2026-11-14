// backend/src/services/projects/projectAiu.js
//
// AIU personalizado por proyecto (Fase 4, req. 1.6).
//
//   - El proyecto guarda su AIU (A, I y U). Se carga al crearlo: de lo que
//     envíe el formulario, o de la cotización si es AIU.
//   - Cada corte arranca con el AIU del proyecto y puede cambiarlo: un
//     concepto en 0 % no aplica en ese corte. La Utilidad debe ser > 0 porque
//     es la base del IVA (aiu.service.js exige lo mismo en la factura).
//   - La tarifa de IVA sobre la U es la de Ajustes → Impuestos (la misma que
//     usará la factura del corte).
//
// Funciones puras: probadas en __tests__/projectAiu.test.js.

const { tenantAiuConfig } = require('../sales/aiu.service');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const KEYS = ['admin_pct', 'unforeseen_pct', 'profit_pct'];
const LABEL = { admin_pct: 'Administración', unforeseen_pct: 'Imprevistos', profit_pct: 'Utilidad' };
const blank = (v) => v === undefined || v === null || v === '';
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** AIU guardado en un registro con columnas aiu_* (proyecto, corte o cotización), o null. */
function aiuOf(row) {
  if (!row || !row.aiu_enabled) return null;
  return {
    admin_pct: Number(row.aiu_admin_pct) || 0,
    unforeseen_pct: Number(row.aiu_unforeseen_pct) || 0,
    profit_pct: Number(row.aiu_profit_pct) || 0,
  };
}

/**
 * Lee el AIU que llega en un body (aiu_enabled, aiu_admin_pct, ...).
 *   fallback      AIU a usar en los porcentajes que no lleguen (proyecto o defaults del tenant).
 *   tenantEnabled si el tenant tiene la facturación AIU activa.
 * Devuelve undefined si el body no menciona AIU, null si lo apaga, o el AIU validado.
 */
function parseAiu(body, { fallback = null, tenantEnabled = true, wasEnabled = false } = {}) {
  const mentions = body && (body.aiu_enabled !== undefined || KEYS.some((k) => body[`aiu_${k}`] !== undefined));
  if (!mentions) return undefined;
  const enabled = body.aiu_enabled !== undefined ? Boolean(body.aiu_enabled) && body.aiu_enabled !== 'false' : true;
  if (!enabled) return null;
  if (!tenantEnabled && !wasEnabled) throw httpError(400, 'La facturación AIU no está habilitada. Actívela en Ajustes → Impuestos.');
  const out = {};
  for (const k of KEYS) {
    const raw = body[`aiu_${k}`];
    const n = blank(raw) ? Number(fallback?.[k] ?? NaN) : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw httpError(400, `AIU: el % de ${LABEL[k]} debe estar entre 0 y 100`);
    out[k] = round2(n);
  }
  if (!(out.profit_pct > 0)) throw httpError(400, 'AIU: la Utilidad debe ser mayor que 0 % (es la base del IVA)');
  return out;
}

/** Columnas aiu_* a guardar a partir del resultado de parseAiu (null = apagado). */
function aiuColumns(aiu) {
  if (!aiu) return { aiu_enabled: false, aiu_admin_pct: null, aiu_unforeseen_pct: null, aiu_profit_pct: null };
  return { aiu_enabled: true, aiu_admin_pct: aiu.admin_pct, aiu_unforeseen_pct: aiu.unforeseen_pct, aiu_profit_pct: aiu.profit_pct };
}

/** AIU con el que nace un proyecto: el del formulario, si no el de la cotización AIU, si no ninguno. */
function initialProjectAiu(body, quote, taxConfig) {
  const cfg = tenantAiuConfig(taxConfig);
  const fromQuote = aiuOf(quote);
  const parsed = parseAiu(body, { fallback: fromQuote || cfg, tenantEnabled: cfg.enabled, wasEnabled: Boolean(fromQuote) });
  if (parsed !== undefined) return parsed;
  return fromQuote;
}

/** Tarifa de IVA sobre la Utilidad como fracción (0.19), de Ajustes → Impuestos. */
function ivaRateOf(taxConfig) {
  const rate = Number(tenantAiuConfig(taxConfig).iva_rate);
  return Number.isFinite(rate) && rate >= 0 ? rate / 100 : 0.19;
}

/** Texto corto "A 10 % · I 0 % · U 5 %". */
function aiuLabel(aiu) {
  if (!aiu) return 'Sin AIU';
  const f = (n) => `${Number(n).toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`;
  return `A ${f(aiu.admin_pct)} · I ${f(aiu.unforeseen_pct)} · U ${f(aiu.profit_pct)}`;
}

module.exports = { aiuOf, parseAiu, aiuColumns, initialProjectAiu, ivaRateOf, aiuLabel };
