// backend/src/services/accounting/fixedAssetFiscal.service.js
//
// Libro fiscal de depreciación (conciliación contable-fiscal, formato 2516).
// No genera asientos: compara, año por año, la depreciación contable con la
// deducible.
//
// Regla (art. 137 E.T.): la depreciación fiscal del año es la contable, sin
// pasar de la tasa máxima anual de la categoría (sobre el costo, proporcional
// a los meses de uso del año). Lo que la contabilidad deprecia de más por
// encima del tope se deduce en los años siguientes, también con el tope, hasta
// agotar la base; así, cuando la vida contable es más corta que la fiscal, la
// deducción sigue después de que el activo ya está depreciado en libros.
// Activos de menor cuantía (≤ 50 UVT) se deducen completos en el año de
// compra (art. 1.2.1.18.7 DUR 1625/2016). Terrenos no se deprecian. El
// deterioro contable no es deducible: queda como diferencia. La base fiscal
// puede diferir de la contable (fiscal_cost / fiscal_salvage_value).
'use strict';

// Tasa anual máxima (%) del art. 137 E.T. por categoría (editable por activo).
const FISCAL_MAX_RATES = {
  construcciones: 2.22,
  maquinaria: 10,
  vehiculo: 10,
  muebles_enseres: 10,
  equipo_computo: 20,
  equipo_comunicacion: 20,
  terrenos: 0,
  otro: 10,
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const yearOf = (d) => Number(String(d).slice(0, 4));
const monthOf = (d) => Number(String(d).slice(5, 7));

const blank = (v) => v === null || v === undefined || v === '';
const fiscalCostOf = (asset) => (blank(asset.fiscal_cost) ? Number(asset.acquisition_cost) : Number(asset.fiscal_cost));
const fiscalSalvageOf = (asset) => (blank(asset.fiscal_salvage_value) ? Number(asset.salvage_value || 0) : Number(asset.fiscal_salvage_value));

function fiscalRateOf(asset) {
  const own = Number(asset.fiscal_max_rate);
  if (asset.fiscal_max_rate !== null && asset.fiscal_max_rate !== undefined && asset.fiscal_max_rate !== '' && own >= 0) return own;
  return FISCAL_MAX_RATES[asset.category] ?? FISCAL_MAX_RATES.otro;
}

/**
 * Calendario fiscal puro.
 * @param {object} asset FixedAsset (plano)
 * @param {Map<number, number>} accountingByYear depreciación contable registrada por año
 * @param {number} toYear último año a calcular
 * @returns {Array<{ year, months, cap, accounting, fiscal, difference, accounting_accumulated, fiscal_accumulated }>}
 */
function fiscalSchedule(asset, accountingByYear, toYear) {
  const method = asset.category === 'terrenos' ? 'no_deprecia' : (asset.depreciation_method || 'linea_recta');
  const cost = fiscalCostOf(asset);
  const base = round2(cost - fiscalSalvageOf(asset));
  const rate = fiscalRateOf(asset) / 100;
  const opening = asset.opening_period;
  const openingAccounting = opening ? Number(asset.opening_accumulated_depreciation || 0) : 0;
  const openingFiscal = opening
    ? Number(asset.fiscal_opening_accumulated ?? asset.opening_accumulated_depreciation ?? 0)
    : 0;
  // Con saldo inicial, el libro empieza el año siguiente al mes de corte si
  // es diciembre, o en ese mismo año (los meses después del corte).
  const startYear = opening ? yearOf(`${opening}-01`) + (monthOf(`${opening}-01`) === 12 ? 1 : 0) : yearOf(asset.acquisition_date);
  const endYear = asset.disposal_date ? Math.min(toYear, yearOf(asset.disposal_date)) : toYear;

  let accAccounting = openingAccounting;
  let accFiscal = openingFiscal;
  let carry = round2(openingAccounting - openingFiscal);
  const rows = [];
  for (let y = startYear; y <= endYear; y += 1) {
    const firstMonth = y === yearOf(asset.acquisition_date) ? monthOf(asset.acquisition_date) : 1;
    const fromMonth = opening && y === yearOf(`${opening}-01`) ? Math.max(firstMonth, monthOf(`${opening}-01`) + 1) : firstMonth;
    const lastMonth = asset.disposal_date && y === yearOf(asset.disposal_date) ? monthOf(asset.disposal_date) : 12;
    const months = Math.max(0, lastMonth - fromMonth + 1);
    const accounting = round2(accountingByYear.get(y) || 0);
    const remaining = round2(base - accFiscal);
    let cap;
    if (method === 'no_deprecia') cap = 0;
    else if (method === 'menor_cuantia') cap = remaining;
    else cap = round2(cost * rate * (months / 12));
    const fiscal = Math.max(0, round2(Math.min(cap, accounting + carry, remaining)));
    carry = round2(carry + accounting - fiscal);
    accAccounting = round2(accAccounting + accounting);
    accFiscal = round2(accFiscal + fiscal);
    rows.push({
      year: y, months, cap, accounting, fiscal, difference: round2(accounting - fiscal),
      accounting_accumulated: accAccounting, fiscal_accumulated: accFiscal, pending_carry: carry,
    });
  }
  return rows;
}

/**
 * Reporte del año: por activo, depreciación contable y fiscal del año,
 * acumuladas, valor en libros contable y fiscal, y la diferencia (temporaria)
 * para la conciliación y el impuesto diferido.
 */
async function fiscalReport(tenantId, year) {
  const { FixedAsset, FixedAssetDepreciationEntry, FixedAssetImpairment } = require('../../models');
  const { Op } = require('sequelize');
  const assets = await FixedAsset.findAll({
    where: {
      tenant_id: tenantId,
      acquisition_date: { [Op.lte]: `${year}-12-31` },
      [Op.or]: [{ disposal_date: null }, { disposal_date: { [Op.gte]: `${year}-01-01` } }],
    },
    order: [['category', 'ASC'], ['name', 'ASC']],
  });
  if (!assets.length) return { year, rows: [], totals: {} };
  const ids = assets.map((a) => a.id);
  const entries = await FixedAssetDepreciationEntry.findAll({ where: { fixed_asset_id: ids }, attributes: ['fixed_asset_id', 'period', 'amount'] });
  const impairments = await FixedAssetImpairment.findAll({ where: { fixed_asset_id: ids, impairment_date: { [Op.lte]: `${year}-12-31` } }, attributes: ['fixed_asset_id', 'amount'] });
  const byAsset = new Map();
  for (const e of entries) {
    if (!byAsset.has(e.fixed_asset_id)) byAsset.set(e.fixed_asset_id, new Map());
    const m = byAsset.get(e.fixed_asset_id);
    const y = Number(e.period.slice(0, 4));
    m.set(y, round2((m.get(y) || 0) + Number(e.amount)));
  }
  const impairedBy = new Map();
  for (const i of impairments) impairedBy.set(i.fixed_asset_id, round2((impairedBy.get(i.fixed_asset_id) || 0) + Number(i.amount)));

  const rows = assets.map((a) => {
    const schedule = fiscalSchedule(a.toJSON(), byAsset.get(a.id) || new Map(), year);
    const row = schedule.find((r) => r.year === year) || { accounting: 0, fiscal: 0, difference: 0, accounting_accumulated: 0, fiscal_accumulated: 0, cap: 0 };
    const last = schedule[schedule.length - 1] || row;
    const cost = Number(a.acquisition_cost);
    const impaired = impairedBy.get(a.id) || 0;
    // Vendido o retirado en el año: ya no hay diferencia temporaria; se
    // realiza en el resultado de la venta (fiscal vs. contable).
    if (a.disposal_date && String(a.disposal_date) <= `${year}-12-31`) {
      const fiscalBook = round2(fiscalCostOf(a) - last.fiscal_accumulated);
      const accountingBook = round2(cost - last.accounting_accumulated - impaired);
      const sale = Number(a.sale_amount || 0);
      return {
        id: a.id, name: a.name, category: a.category, method: a.depreciation_method, acquisition_date: a.acquisition_date, cost,
        fiscal_rate: fiscalRateOf(a), accounting_year: row.accounting, fiscal_year: row.fiscal, difference_year: row.difference,
        accounting_accumulated: last.accounting_accumulated, fiscal_accumulated: last.fiscal_accumulated, impaired,
        book_accounting: 0, book_fiscal: 0, temporary_difference: 0,
        disposed: true, disposal_date: a.disposal_date,
        accounting_result: round2(sale - accountingBook), fiscal_result: round2(sale - fiscalBook),
      };
    }
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      method: a.depreciation_method,
      acquisition_date: a.acquisition_date,
      cost,
      fiscal_rate: fiscalRateOf(a),
      accounting_year: row.accounting,
      fiscal_year: row.fiscal,
      difference_year: row.difference,
      accounting_accumulated: last.accounting_accumulated,
      fiscal_accumulated: last.fiscal_accumulated,
      impaired,
      book_accounting: round2(cost - last.accounting_accumulated - impaired),
      fiscal_cost: fiscalCostOf(a),
      book_fiscal: round2(fiscalCostOf(a) - last.fiscal_accumulated),
      // Diferencia temporaria: valor fiscal − valor contable (positiva:
      // deducible a futuro → activo por impuesto diferido).
      temporary_difference: round2((fiscalCostOf(a) - last.fiscal_accumulated) - (cost - last.accounting_accumulated - impaired)),
    };
  });
  const sum = (k) => round2(rows.reduce((s, r) => s + Number(r[k] || 0), 0));
  return {
    year,
    rows,
    totals: {
      cost: sum('cost'), accounting_year: sum('accounting_year'), fiscal_year: sum('fiscal_year'), difference_year: sum('difference_year'),
      book_accounting: sum('book_accounting'), book_fiscal: sum('book_fiscal'), temporary_difference: sum('temporary_difference'), impaired: sum('impaired'),
    },
  };
}

module.exports = { FISCAL_MAX_RATES, fiscalRateOf, fiscalCostOf, fiscalSalvageOf, fiscalSchedule, fiscalReport };
