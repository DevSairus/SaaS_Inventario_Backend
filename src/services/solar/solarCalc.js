// backend/src/services/solar/solarCalc.js
//
// Dimensionamiento y precio de un sistema solar fotovoltaico. Puro (sin BD)
// para probarlo aparte. Mismo modelo del cotizador original
// (Energia/index.html):
//   PR      = eficiencia base × techo × orientación × inclinación × sombra
//             (acotado entre 0,40 y 1,00)
//   kWp     = consumo a cubrir / (HSP × 30 × PR), redondeado a paneles enteros
//   energía = kWp × HSP × días × PR (mensual con la radiación de cada mes)
// Precio (decisión 2026-11-06, "catálogo + porcentajes"):
//   - Paneles, inversor y otros equipos: productos del catálogo a su precio.
//   - Mano de obra, material eléctrico y consultoría: líneas de servicio de
//     precio base por kWp × % configurable por empresa.
//   - AIU opcional (la cotización AIU de Pitbox calcula el IVA sobre la U).

const ROOF_FACTORS = { inclinado: 1.0, plano: 0.97, industrial: 1.02, mixto: 0.98 };
const ORIENTATION_FACTORS = { norte: 1.0, noreste: 0.97, noroeste: 0.96, este: 0.91, oeste: 0.89, sur: 0.75 };
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// Colombia (latitud ~4° N): óptimo entre 10° y 15°.
function tiltFactor(degrees) {
  const g = num(degrees, 10);
  if (g <= 5) return 0.97;
  if (g <= 15) return 1.0;
  if (g <= 25) return 0.99;
  if (g <= 35) return 0.96;
  return 0.92;
}

function performanceRatio({ basePr = 0.8, roof = 'inclinado', orientation = 'norte', tilt = 10, shadingPct = 5 }) {
  const factors = {
    roof: ROOF_FACTORS[roof] ?? 1,
    orientation: ORIENTATION_FACTORS[orientation] ?? 1,
    tilt: tiltFactor(tilt),
    shading: 1 - Math.min(Math.max(num(shadingPct, 5), 0), 60) / 100,
  };
  const pr = Math.max(0.4, Math.min(1, num(basePr, 0.8) * factors.roof * factors.orientation * factors.tilt * factors.shading));
  return { pr: Math.round(pr * 1000) / 1000, factors };
}

/**
 * @param {object} input
 *   monthly_kwh, tariff_kwh, coverage_pct, hsp, hsp_monthly[12]?, roof, orientation, tilt, shading_pct,
 *   panel: { product_id?, name, watts, unit_price, tax_pct? },
 *   inverter: { product_id?, name, unit_price, quantity, tax_pct? } | null,
 *   extras: [{ product_id?, name, quantity, unit_price, tax_pct? }],
 * @param {object} settings - solar_settings
 */
function calculate(input, settings) {
  const monthlyKwh = num(input.monthly_kwh);
  if (!(monthlyKwh > 0)) throw Object.assign(new Error('Indica el consumo mensual en kWh'), { statusCode: 400 });
  const tariff = num(input.tariff_kwh);
  const coverage = Math.min(Math.max(num(input.coverage_pct, 100), 10), 150) / 100;
  const hsp = num(input.hsp) > 0 ? num(input.hsp) : num(settings.default_hsp, 4.5);
  const watts = num(input.panel?.watts) > 0 ? num(input.panel.watts) : num(settings.panel_watts, 645);

  const { pr, factors } = performanceRatio({
    basePr: num(settings.performance_ratio, 0.8), roof: input.roof, orientation: input.orientation, tilt: input.tilt, shadingPct: input.shading_pct,
  });

  const targetKwh = monthlyKwh * coverage;
  const kwpTarget = targetKwh / (hsp * 30 * pr);
  const panels = Math.max(1, Math.ceil(kwpTarget / (watts / 1000)));
  const kwp = Math.round(panels * watts) / 1000;
  const monthlyHsp = Array.isArray(input.hsp_monthly) && input.hsp_monthly.length === 12 ? input.hsp_monthly.map((v) => num(v)) : null;
  const productionMonthly = monthlyHsp
    ? monthlyHsp.map((h, i) => round2(kwp * h * DAYS_IN_MONTH[i] * pr))
    : DAYS_IN_MONTH.map((d) => round2(kwp * hsp * d * pr));
  const productionYear = round2(productionMonthly.reduce((s, v) => s + v, 0));
  const productionMonth = round2(kwp * hsp * 30 * pr);

  // ── Precio ──
  const lines = [];
  const pushProduct = (kind, p, quantity) => {
    if (!p || !(quantity > 0)) return;
    const unit = round2(num(p.unit_price));
    lines.push({
      kind, category: kind === 'service' ? 'services' : 'materials', product_id: p.product_id || null, name: p.name,
      quantity, unit_price: unit, tax_pct: num(p.tax_pct), subtotal: round2(unit * quantity), unit_cost: p.unit_cost != null ? num(p.unit_cost) : null,
    });
  };
  pushProduct('panel', input.panel, panels);
  if (input.inverter) pushProduct('inverter', input.inverter, Math.max(1, Math.round(num(input.inverter.quantity, 1))));
  for (const e of input.extras || []) pushProduct('extra', e, num(e.quantity));

  const base = round2(kwp * num(settings.price_per_kwp));
  const useAiu = Boolean(settings.use_aiu);
  // Con AIU el IVA va sobre la Utilidad (lo calcula la cotización); sin AIU,
  // las líneas de servicio llevan el IVA configurado.
  const serviceTax = useAiu ? 0 : num(settings.service_tax_pct);
  const services = [
    ['labor', 'Instalación, estructuras y mano de obra', num(settings.labor_pct), 'labor'],
    ['electrical', 'Material eléctrico (cableado, tableros, protecciones)', num(settings.electrical_pct), 'materials'],
    ['consulting', 'Consultoría RETIE, trámite ante el operador de red y UPME', num(settings.consulting_pct), 'services'],
  ];
  for (const [kind, name, pct, category] of services) {
    const amount = round2(base * pct / 100);
    if (amount > 0) lines.push({ kind, category, product_id: null, name, quantity: 1, unit_price: amount, tax_pct: serviceTax, subtotal: amount, unit_cost: null, pct });
  }

  const direct = round2(lines.reduce((s, l) => s + l.subtotal, 0));
  const aiu = useAiu ? {
    admin_pct: num(settings.aiu_admin_pct), unforeseen_pct: num(settings.aiu_unforeseen_pct), profit_pct: num(settings.aiu_profit_pct),
  } : null;
  if (aiu) {
    aiu.admin = round2(direct * aiu.admin_pct / 100);
    aiu.unforeseen = round2(direct * aiu.unforeseen_pct / 100);
    aiu.profit = round2(direct * aiu.profit_pct / 100);
    aiu.total = round2(aiu.admin + aiu.unforeseen + aiu.profit);
    aiu.iva = round2(aiu.profit * 0.19);
  }
  const lineTaxes = round2(lines.reduce((s, l) => s + l.subtotal * l.tax_pct / 100, 0));
  const subtotal = round2(direct + (aiu?.total || 0));
  const taxes = round2(lineTaxes + (aiu?.iva || 0));
  const total = round2(subtotal + taxes);

  const savingsMonth = round2(productionMonth * tariff);
  const savingsYear = round2(productionYear * tariff);
  return {
    pr,
    factors,
    hsp: round2(hsp),
    panel_watts: watts,
    panels,
    kwp,
    kwp_target: Math.round(kwpTarget * 1000) / 1000,
    suggested_inverter_kw: Math.round((kwp / num(settings.dc_ac_ratio, 1.2)) * 10) / 10,
    target_kwh: round2(targetKwh),
    production_month: productionMonth,
    production_monthly: productionMonthly,
    production_year: productionYear,
    coverage_pct: Math.round(coverage * 100),
    savings_month: savingsMonth,
    savings_year: savingsYear,
    payback_months: savingsMonth > 0 ? Math.round((total / savingsMonth) * 10) / 10 : null,
    // Ley 1715 de 2014 (art. 11): deducción en renta de hasta el 50 % de la inversión.
    tax_deduction_50: round2(subtotal * 0.5),
    lines,
    price_base: base,
    direct,
    aiu,
    subtotal,
    taxes,
    total,
  };
}

/**
 * Presupuesto de costos del proyecto a partir del estudio: equipos al costo
 * del producto (o a su precio si no tiene costo), y los servicios a su valor.
 * Es el costo directo; el AIU queda como margen esperado.
 */
function budgetFromResults(results) {
  const by = { materials: 0, labor: 0, services: 0, other: 0 };
  for (const l of results.lines || []) {
    const unit = l.unit_cost != null && l.unit_cost > 0 ? l.unit_cost : l.unit_price;
    by[l.category] = round2((by[l.category] || 0) + unit * l.quantity);
  }
  return by;
}

module.exports = { calculate, performanceRatio, tiltFactor, budgetFromResults, ROOF_FACTORS, ORIENTATION_FACTORS };
