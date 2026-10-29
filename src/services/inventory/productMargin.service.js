// backend/src/services/inventory/productMargin.service.js
//
// Margen de ganancia por categoría y global. El margen efectivo de un
// producto se resuelve así:
//
//   producto con margen propio (margin_inherited = false) → el suyo
//   producto que hereda → su categoría → categoría padre → … → global
//
// El global vive en tenants.business_config.default_profit_margin_pct; el
// de la categoría en categories.profit_margin_percentage (NULL = hereda).
// Un producto que hereda guarda en profit_margin_percentage una COPIA del
// margen efectivo, así compras, reportes, alertas de costo y el script de
// recálculo siguen leyendo un solo campo. syncInheritedMargins mantiene esa
// copia al día cuando cambia una categoría (margen o padre) o el global.
//
// Cambiar el margen de una categoría o el global (applyMarginChange) solo
// toca los productos que heredan; con `force` también pasa a heredar los
// que tienen margen propio. Opcionalmente recalcula el precio de venta con
// la misma regla de las compras: el precio nunca baja salvo allow_decrease.

const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const Tenant = require('../../models/auth/Tenant');
const CostAlert = require('../../models/inventory/CostAlert');
const { Product, Category } = require('../../models/inventory');
const { suggestedSalePrice, isValidMargin } = require('../../utils/salePricing');

const EPS = 0.005;
const PREVIEW_ROWS = 500;
const UPDATE_CHUNK = 1000;

const toMargin = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

class MarginError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

async function loadTree(tenant_id, transaction) {
  const tenant = await Tenant.findByPk(tenant_id, { attributes: ['id', 'business_config'], transaction });
  const categories = await Category.findAll({
    where: { tenant_id },
    attributes: ['id', 'name', 'parent_id', 'is_active', 'profit_margin_percentage'],
    transaction,
  });
  const byId = new Map(categories.map((c) => [c.id, {
    id: c.id, name: c.name, parent_id: c.parent_id, is_active: c.is_active,
    own: toMargin(c.profit_margin_percentage),
  }]));
  return { tenant, global: toMargin(tenant?.business_config?.default_profit_margin_pct), byId };
}

// { margin, source_id }: source_id es la categoría que define el margen, o
// null si viene del global. Con guardia contra ciclos de parent_id.
function resolveCategory(tree, categoryId) {
  const seen = new Set();
  let current = categoryId ? tree.byId.get(categoryId) : null;
  while (current && !seen.has(current.id)) {
    if (current.own !== null) return { margin: current.own, source_id: current.id };
    seen.add(current.id);
    current = current.parent_id ? tree.byId.get(current.parent_id) : null;
  }
  return { margin: tree.global, source_id: null };
}

/** Margen efectivo para un producto que hereda, según su categoría. */
async function inheritedMarginFor(tenant_id, categoryId, transaction) {
  const tree = await loadTree(tenant_id, transaction);
  return resolveCategory(tree, categoryId).margin;
}

/** Global + cada categoría con su margen propio y el efectivo (para la UI). */
async function getMarginOverview(tenant_id) {
  const tree = await loadTree(tenant_id);
  const schema = getCurrentSchema() || 'public';
  const [counts] = await sequelize.query(`
    SELECT category_id,
           COUNT(*) FILTER (WHERE margin_inherited)     AS inherited,
           COUNT(*) FILTER (WHERE NOT margin_inherited) AS own
    FROM "${schema}"."products" WHERE tenant_id = :tenant_id
    GROUP BY category_id
  `, { replacements: { tenant_id } });
  const countBy = new Map(counts.map((r) => [r.category_id, { inherited: Number(r.inherited), own: Number(r.own) }]));
  const empty = { inherited: 0, own: 0 };

  const categories = [...tree.byId.values()].map((c) => {
    const eff = resolveCategory(tree, c.id);
    return {
      id: c.id, name: c.name, parent_id: c.parent_id, is_active: c.is_active,
      own_margin: c.own, effective_margin: eff.margin,
      source: eff.source_id === null ? 'global' : eff.source_id === c.id ? 'own' : 'parent',
      source_name: eff.source_id && eff.source_id !== c.id ? tree.byId.get(eff.source_id)?.name : null,
      products: countBy.get(c.id) || empty,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return { global_margin: tree.global, uncategorized_products: countBy.get(null) || empty, categories };
}

/**
 * Deja profit_margin_percentage de cada producto que hereda igual al margen
 * efectivo de su categoría. Devuelve cuántos productos cambiaron.
 */
async function syncInheritedMargins(tenant_id, transaction, tree = null) {
  tree = tree || await loadTree(tenant_id, transaction);
  const schema = getCurrentSchema() || 'public';

  // Agrupar categorías por margen efectivo: un UPDATE por margen distinto.
  const groups = new Map();
  for (const c of tree.byId.values()) {
    const { margin } = resolveCategory(tree, c.id);
    const key = margin === null ? 'null' : String(margin);
    if (!groups.has(key)) groups.set(key, { margin, ids: [] });
    groups.get(key).ids.push(c.id);
  }

  let changed = 0;
  const run = async (margin, whereCategory, replacements) => {
    const [, meta] = await sequelize.query(`
      UPDATE "${schema}"."products"
      SET profit_margin_percentage = :margin, updated_at = NOW()
      WHERE tenant_id = :tenant_id AND margin_inherited = true AND ${whereCategory}
        AND profit_margin_percentage IS DISTINCT FROM CAST(:margin AS DECIMAL(5,2))
    `, { replacements: { tenant_id, margin, ...replacements }, transaction });
    changed += meta?.rowCount || 0;
  };

  for (const { margin, ids } of groups.values()) {
    await run(margin, 'category_id IN (:ids)', { ids });
  }
  // Sin categoría (o con una categoría que ya no existe): margen global.
  const allIds = [...tree.byId.keys()];
  await run(tree.global, allIds.length ? '(category_id IS NULL OR category_id NOT IN (:allIds))' : 'TRUE', { allIds });
  return changed;
}

// Categorías cuyos productos quedan bajo el margen que se cambia: para el
// global, las que no tienen margen propio en toda su cadena; para una
// categoría, ella y sus descendientes que no lo redefinen.
function scopeCategoryIds(tree, scope, categoryId) {
  const ids = [];
  for (const c of tree.byId.values()) {
    const seen = new Set();
    let current = c;
    let inScope = false;
    while (current && !seen.has(current.id)) {
      if (scope === 'category' && current.id === categoryId) { inScope = true; break; }
      if (current.own !== null) break;
      seen.add(current.id);
      current = current.parent_id ? tree.byId.get(current.parent_id) : null;
    }
    if (scope === 'global' && (!current || seen.has(current?.id))) inScope = true;
    if (inScope) ids.push(c.id);
  }
  return ids;
}

function validateRequest({ scope, category_id, margin }) {
  if (!['global', 'category'].includes(scope)) throw new MarginError('Indica si el margen es global o de una categoría');
  if (scope === 'category' && !category_id) throw new MarginError('Selecciona la categoría');
  const m = toMargin(margin);
  if (margin !== null && margin !== undefined && margin !== '' && m === null) throw new MarginError('Margen inválido');
  if (m !== null && !isValidMargin(m)) throw new MarginError('El margen es sobre el precio de venta: debe estar entre 0 y 99,99 %');
  return m;
}

/**
 * Calcula qué pasaría con el cambio (sin escribir nada). Lo usan la vista
 * previa y applyMarginChange, que lo vuelve a correr dentro de su transacción.
 */
async function planMarginChange(tenant_id, params, transaction = null) {
  const { scope, category_id = null, force = false, recalc_prices = true, allow_decrease = false } = params;
  const margin = validateRequest(params);
  const tree = await loadTree(tenant_id, transaction);
  if (scope === 'category' && !tree.byId.has(category_id)) throw new MarginError('Categoría no encontrada', 404);

  const before = scope === 'global' ? tree.global : tree.byId.get(category_id).own;
  // Árbol con el cambio aplicado, para resolver el margen nuevo.
  const after = { ...tree, byId: new Map(tree.byId) };
  if (scope === 'global') after.global = margin;
  else after.byId.set(category_id, { ...tree.byId.get(category_id), own: margin });

  const catIds = scopeCategoryIds(tree, scope, category_id);
  const schema = getCurrentSchema() || 'public';
  const allIds = [...tree.byId.keys()];
  const where = [];
  if (catIds.length) where.push('category_id IN (:catIds)');
  if (scope === 'global') where.push(allIds.length ? '(category_id IS NULL OR category_id NOT IN (:allIds))' : 'TRUE');
  const products = where.length ? (await sequelize.query(`
    SELECT id, sku, name, category_id, is_active, margin_inherited, profit_margin_percentage,
           base_price, average_cost, last_purchase_cost, price_includes_tax, has_tax, tax_percentage, tax_config
    FROM "${schema}"."products"
    WHERE tenant_id = :tenant_id AND (${where.join(' OR ')})
    ORDER BY sku
  `, { replacements: { tenant_id, catIds, allIds }, transaction }))[0] : [];

  const stats = { in_scope: products.length, inherited: 0, own_kept: 0, forced: 0, margin_changes: 0, price_up: 0, price_down: 0, price_held: 0, price_same: 0, no_cost: 0 };
  const rows = [];
  for (const p of products) {
    if (!p.margin_inherited && !force) { stats.own_kept += 1; continue; }
    if (p.margin_inherited) stats.inherited += 1; else stats.forced += 1;

    const newMargin = resolveCategory(after, p.category_id).margin;
    const oldMargin = toMargin(p.profit_margin_percentage);
    const marginChanges = (oldMargin ?? null) !== (newMargin ?? null) && !(oldMargin !== null && newMargin !== null && Math.abs(oldMargin - newMargin) < EPS);
    if (marginChanges) stats.margin_changes += 1;

    const current = parseFloat(p.base_price) || 0;
    const lastCost = parseFloat(p.last_purchase_cost) || 0;
    const cost = lastCost > 0 ? lastCost : parseFloat(p.average_cost) || 0;
    const row = {
      id: p.id, sku: p.sku, name: p.name, is_active: p.is_active, forced: !p.margin_inherited,
      old_margin: oldMargin, new_margin: newMargin, cost, current_price: current, suggested_price: null, final_price: current, action: 'margen',
    };
    if (recalc_prices && newMargin !== null && newMargin > 0) {
      if (!(cost > 0)) {
        row.action = 'sin_costo'; stats.no_cost += 1;
      } else {
        const suggested = suggestedSalePrice(cost, newMargin, p);
        row.suggested_price = suggested;
        if (Math.abs(suggested - current) < EPS) { row.action = 'igual'; stats.price_same += 1; }
        else if (suggested > current || current <= 0) { row.action = 'sube'; row.final_price = suggested; stats.price_up += 1; }
        else if (allow_decrease) { row.action = 'baja'; row.final_price = suggested; stats.price_down += 1; }
        else { row.action = 'se_conserva'; stats.price_held += 1; }
      }
    }
    if (marginChanges || row.final_price !== current || row.forced) rows.push(row);
  }

  return { scope, category_id, category_name: scope === 'category' ? tree.byId.get(category_id).name : null, before, margin, tree, after, stats, rows };
}

async function previewMarginChange(tenant_id, params) {
  const plan = await planMarginChange(tenant_id, params);
  // Primero los que más cambian de precio; la lista completa puede ser de miles.
  const rows = [...plan.rows].sort((a, b) => Math.abs(b.final_price - b.current_price) - Math.abs(a.final_price - a.current_price));
  return {
    scope: plan.scope, category_id: plan.category_id, category_name: plan.category_name,
    before: plan.before, margin: plan.margin, stats: plan.stats,
    affected: plan.rows.length, rows: rows.slice(0, PREVIEW_ROWS),
  };
}

async function applyMarginChange(tenant_id, params) {
  const transaction = await sequelize.transaction();
  try {
    const plan = await planMarginChange(tenant_id, params, transaction);
    const schema = getCurrentSchema() || 'public';

    if (plan.scope === 'global') {
      const tenant = plan.tree.tenant;
      await tenant.update({ business_config: { ...(tenant.business_config || {}), default_profit_margin_pct: plan.margin } }, { transaction });
    } else {
      await Category.update({ profit_margin_percentage: plan.margin }, { where: { id: plan.category_id, tenant_id }, transaction });
    }

    const forcedIds = plan.rows.filter((r) => r.forced).map((r) => r.id);
    for (let i = 0; i < forcedIds.length; i += UPDATE_CHUNK) {
      await Product.update({ margin_inherited: true }, { where: { tenant_id, id: forcedIds.slice(i, i + UPDATE_CHUNK) }, transaction });
    }
    const marginsSynced = await syncInheritedMargins(tenant_id, transaction, plan.after);

    const priced = plan.rows.filter((r) => Math.abs(r.final_price - r.current_price) >= EPS);
    for (let i = 0; i < priced.length; i += UPDATE_CHUNK) {
      const chunk = priced.slice(i, i + UPDATE_CHUNK);
      const values = chunk.map((r) => `('${r.id}', ${Number(r.final_price)})`).join(',');
      await sequelize.query(`
        UPDATE "${schema}"."products" AS p
        SET base_price = v.price, updated_at = NOW()
        FROM (VALUES ${values}) AS v(id, price)
        WHERE p.id = v.id::uuid AND p.tenant_id = :tenant_id
      `, { replacements: { tenant_id }, transaction });
    }

    // Alertas de precio conservado: su sugerido se calculó con el margen
    // anterior. Igual que recalcSalePricesByMargin: se recalcula sobre el
    // costo de la alerta y, si con el margen nuevo ya no baja, se resuelve.
    let alertsUpdated = 0;
    let alertsResolved = 0;
    const rowById = new Map(plan.rows.map((r) => [r.id, r]));
    if (rowById.size) {
      const alerts = await CostAlert.findAll({ where: { tenant_id, status: 'active', price_held: true }, transaction });
      for (const alert of alerts) {
        const row = rowById.get(alert.product_id);
        if (!row || row.new_margin === null) continue;
        const product = await Product.findByPk(row.id, { attributes: ['id', 'price_includes_tax', 'has_tax', 'tax_percentage', 'tax_config'], transaction });
        const suggested = suggestedSalePrice(alert.new_cost, row.new_margin, product);
        if (suggested === null) continue;
        if (suggested >= row.final_price - EPS) {
          alertsResolved += 1;
          await alert.update({ status: 'resolved', resolved_date: new Date(), resolution_notes: 'Resuelta al cambiar el margen de ganancia: el precio ya no baja' }, { transaction });
        } else if (Math.abs(suggested - parseFloat(alert.suggested_price)) >= EPS) {
          alertsUpdated += 1;
          await alert.update({ suggested_price: suggested }, { transaction });
        }
      }
    }

    await transaction.commit();
    return {
      scope: plan.scope, category_name: plan.category_name, before: plan.before, margin: plan.margin, stats: plan.stats,
      products_forced: forcedIds.length, margins_synced: marginsSynced, prices_updated: priced.length,
      alerts_updated: alertsUpdated, alerts_resolved: alertsResolved,
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = {
  MarginError,
  inheritedMarginFor,
  getMarginOverview,
  syncInheritedMargins,
  previewMarginChange,
  applyMarginChange,
};
