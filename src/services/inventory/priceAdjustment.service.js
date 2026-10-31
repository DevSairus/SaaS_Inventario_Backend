// backend/src/services/inventory/priceAdjustment.service.js
//
// Ajustes de precio de venta (AJP-000001). Cambian SOLO products.base_price:
// stock, costo promedio, último costo de compra y contabilidad quedan igual.
// El caso típico: una compra que todavía no se ha registrado salió más barata
// (o más cara) que la última registrada, y el precio de venta se quiere
// corregir ya, sin esperar a la compra y sin inventar un costo.
//
// Cada línea guarda el precio anterior y el nuevo, el costo de referencia con
// que se calculó el sugerido (último de compra, promedio o uno escrito a mano),
// el margen y el método del negocio (utils/salePricing.js) y una foto de los
// costos del producto. El precio final lo decide el usuario: el sugerido es
// solo una ayuda. En el mismo ajuste se puede cambiar el margen del producto:
// queda como margen propio (deja de heredar el de la categoría) y lo usan las
// próximas compras; la línea guarda el margen anterior (margin_changed). Las alertas de "precio retenido" activas de esos productos
// se resuelven, porque el precio ya se revisó a mano.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { Product, CostAlert, PriceAdjustment, PriceAdjustmentItem, User } = require('../../models');
const { suggestedSalePrice, isValidMargin, marginRangeMessage } = require('../../utils/salePricing');
const { getMarginMethod } = require('./productMargin.service');

const MAX_ITEMS = 500;
const EPS = 0.005;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const PRODUCT_ATTRS = [
  'id', 'sku', 'name', 'is_active', 'base_price', 'sale_price', 'average_cost', 'last_purchase_cost',
  'last_purchase_date', 'profit_margin_percentage', 'margin_inherited', 'price_includes_tax', 'has_tax', 'tax_percentage', 'tax_config',
];

class PriceAdjustmentError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

// Costo base por defecto: el último de compra; si nunca se ha comprado, el
// promedio (mismo criterio que compras y el formulario del producto).
function defaultCost(p) {
  const last = parseFloat(p.last_purchase_cost) || 0;
  if (last > 0) return { cost: last, source: 'last_purchase' };
  const avg = parseFloat(p.average_cost) || 0;
  return avg > 0 ? { cost: avg, source: 'average' } : { cost: null, source: null };
}

function productInfo(p, method) {
  const { cost, source } = defaultCost(p);
  const margin = p.profit_margin_percentage === null ? null : parseFloat(p.profit_margin_percentage);
  return {
    id: p.id, sku: p.sku, name: p.name, is_active: p.is_active,
    current_price: parseFloat(p.base_price) || 0,
    last_purchase_cost: parseFloat(p.last_purchase_cost) || 0,
    last_purchase_date: p.last_purchase_date || null,
    average_cost: parseFloat(p.average_cost) || 0,
    margin_pct: margin, margin_inherited: !!p.margin_inherited,
    price_includes_tax: !!p.price_includes_tax, has_tax: p.has_tax, tax_percentage: p.tax_percentage, tax_config: p.tax_config,
    default_cost: cost, default_cost_source: source,
    suggested_price: cost && margin ? suggestedSalePrice(cost, margin, p, method) : null,
  };
}

/** Datos de los productos para armar el ajuste en pantalla. */
async function getProductsInfo(tenant_id, productIds = []) {
  const ids = [...new Set((productIds || []).filter(Boolean))].slice(0, MAX_ITEMS);
  const method = await getMarginMethod(tenant_id);
  if (!ids.length) return { margin_method: method, products: [] };
  const products = await Product.findAll({ where: { tenant_id, id: ids }, attributes: PRODUCT_ATTRS });
  return { margin_method: method, products: products.map((p) => productInfo(p, method)) };
}

// Consecutivo AJP-000001 por tenant (advisory lock como las listas de pedido).
async function nextNumber(tenant_id, transaction) {
  await sequelize.query(`SELECT pg_advisory_xact_lock(hashtext(:key))`, {
    replacements: { key: `price_adjustments:${tenant_id}` }, transaction,
  });
  const last = await PriceAdjustment.findOne({
    where: { tenant_id, adjustment_number: { [Op.like]: 'AJP-%' } },
    order: [['adjustment_number', 'DESC']],
    attributes: ['adjustment_number'],
    transaction,
  });
  const n = last ? (parseInt(String(last.adjustment_number).split('-')[1], 10) || 0) + 1 : 1;
  return `AJP-${String(n).padStart(6, '0')}`;
}

function parseLines(items) {
  if (!Array.isArray(items) || !items.length) throw new PriceAdjustmentError('Agrega al menos un producto');
  if (items.length > MAX_ITEMS) throw new PriceAdjustmentError(`Máximo ${MAX_ITEMS} productos por ajuste`);
  const seen = new Set();
  return items.map((it, i) => {
    const product_id = it?.product_id;
    if (!product_id) throw new PriceAdjustmentError(`Línea ${i + 1}: falta el producto`);
    if (seen.has(product_id)) throw new PriceAdjustmentError(`Línea ${i + 1}: el producto está repetido`);
    seen.add(product_id);
    const newPrice = Number(it.new_price);
    if (!Number.isFinite(newPrice) || newPrice <= 0) throw new PriceAdjustmentError(`Línea ${i + 1}: el precio nuevo debe ser mayor a 0`);
    let refCost = null;
    if (it.reference_cost !== null && it.reference_cost !== undefined && it.reference_cost !== '') {
      refCost = Number(it.reference_cost);
      if (!Number.isFinite(refCost) || refCost < 0) throw new PriceAdjustmentError(`Línea ${i + 1}: costo de referencia inválido`);
      refCost = round2(refCost);
    }
    let margin = null;
    if (it.margin_pct !== null && it.margin_pct !== undefined && it.margin_pct !== '') {
      margin = Number(it.margin_pct);
      if (!Number.isFinite(margin)) throw new PriceAdjustmentError(`Línea ${i + 1}: margen inválido`);
      margin = round2(margin);
    }
    return { product_id, new_price: round2(newPrice), reference_cost: refCost, margin_pct: margin };
  });
}

/**
 * Crea el ajuste y cambia el precio de venta de cada producto.
 * @param {{ reason: string, notes?: string, items: Array<{ product_id, new_price, reference_cost? }> }} data
 */
async function createPriceAdjustment(tenant_id, user_id, data = {}) {
  const reason = String(data.reason || '').trim();
  if (!reason) throw new PriceAdjustmentError('Escribe el motivo del ajuste');
  if (reason.length > 255) throw new PriceAdjustmentError('El motivo es muy largo (máximo 255 caracteres)');
  const notes = String(data.notes || '').trim() || null;
  const lines = parseLines(data.items);
  const method = await getMarginMethod(tenant_id);

  const transaction = await sequelize.transaction();
  try {
    const products = await Product.findAll({
      where: { tenant_id, id: lines.map((l) => l.product_id) },
      attributes: PRODUCT_ATTRS,
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const rows = [];
    const unchanged = [];
    for (const line of lines) {
      const p = byId.get(line.product_id);
      if (!p) throw new PriceAdjustmentError('Uno de los productos no existe o no es de esta empresa', 404);
      const previous = parseFloat(p.base_price) || 0;
      const prevMargin = p.profit_margin_percentage === null ? null : parseFloat(p.profit_margin_percentage);
      if (line.margin_pct !== null && !isValidMargin(line.margin_pct, method)) {
        throw new PriceAdjustmentError(`${p.sku}: ${marginRangeMessage(method)}`);
      }
      const marginChanged = line.margin_pct !== null && (prevMargin === null || Math.abs(line.margin_pct - prevMargin) >= EPS);
      const priceChanged = Math.abs(line.new_price - previous) >= EPS;
      if (!priceChanged && !marginChanged) { unchanged.push(p.sku); continue; }

      const def = defaultCost(p);
      const last = parseFloat(p.last_purchase_cost) || 0;
      const avg = parseFloat(p.average_cost) || 0;
      let refCost = def.cost;
      let source = def.source;
      if (line.reference_cost !== null) {
        refCost = line.reference_cost;
        source = Math.abs(refCost - last) < EPS && last > 0 ? 'last_purchase'
          : Math.abs(refCost - avg) < EPS && avg > 0 ? 'average' : 'manual';
      }
      const margin = marginChanged ? line.margin_pct : prevMargin;
      rows.push({
        tenant_id, product_id: p.id, sku: p.sku, product_name: p.name,
        previous_price: previous, new_price: line.new_price,
        reference_cost: refCost, cost_source: refCost === null ? null : source,
        margin_pct: margin, margin_method: method,
        previous_margin_pct: prevMargin, margin_changed: marginChanged,
        suggested_price: refCost && margin ? suggestedSalePrice(refCost, margin, p, method) : null,
        price_includes_tax: !!p.price_includes_tax,
        last_purchase_cost: last, average_cost: avg,
      });
    }
    if (!rows.length) throw new PriceAdjustmentError('Ningún precio ni margen cambia: son iguales a los actuales');

    const adjustment_number = await nextNumber(tenant_id, transaction);
    const adjustment = await PriceAdjustment.create({
      tenant_id, adjustment_number, reason, notes, items_count: rows.length, created_by: user_id,
    }, { transaction });
    await PriceAdjustmentItem.bulkCreate(rows.map((r) => ({ ...r, adjustment_id: adjustment.id })), { transaction });

    const schema = getCurrentSchema() || 'public';
    const priced = rows.filter((r) => Math.abs(r.new_price - r.previous_price) >= EPS);
    if (priced.length) {
      const values = priced.map((r) => `('${r.product_id}', ${Number(r.new_price)})`).join(',');
      await sequelize.query(`
        UPDATE "${schema}"."products" AS p
        SET base_price = v.price, updated_at = NOW()
        FROM (VALUES ${values}) AS v(id, price)
        WHERE p.id = v.id::uuid AND p.tenant_id = :tenant_id
      `, { replacements: { tenant_id }, transaction });
    }
    // Margen cambiado: queda como margen propio del producto.
    const remargined = rows.filter((r) => r.margin_changed);
    if (remargined.length) {
      const values = remargined.map((r) => `('${r.product_id}', ${Number(r.margin_pct)})`).join(',');
      await sequelize.query(`
        UPDATE "${schema}"."products" AS p
        SET profit_margin_percentage = v.margin, margin_inherited = false, updated_at = NOW()
        FROM (VALUES ${values}) AS v(id, margin)
        WHERE p.id = v.id::uuid AND p.tenant_id = :tenant_id
      `, { replacements: { tenant_id }, transaction });
    }

    // El precio ya se revisó a mano: las alertas de precio retenido de estos
    // productos dejan de estar pendientes.
    const [alertsResolved] = await CostAlert.update({
      status: 'resolved', resolved_date: new Date(), resolved_by: user_id, price_applied: false,
      resolution_notes: `Precio de venta ajustado a mano en ${adjustment_number}`,
    }, {
      where: { tenant_id, status: 'active', price_held: true, product_id: rows.map((r) => r.product_id) },
      transaction,
    });

    await transaction.commit();
    return {
      adjustment, items_count: rows.length, prices_changed: priced.length, margins_changed: remargined.length,
      unchanged, alerts_resolved: alertsResolved,
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function listPriceAdjustments(tenant_id, { page = 1, limit = 20, search = '' } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const where = { tenant_id };
  const term = String(search || '').trim();
  if (term) {
    const schema = getCurrentSchema() || 'public';
    where[Op.or] = [
      { adjustment_number: { [Op.iLike]: `%${term}%` } },
      { reason: { [Op.iLike]: `%${term}%` } },
      // Ajustes que incluyen un producto con ese código o nombre.
      sequelize.literal(`"PriceAdjustment"."id" IN (
        SELECT adjustment_id FROM "${schema}"."price_adjustment_items"
        WHERE tenant_id = ${sequelize.escape(tenant_id)}
          AND (sku ILIKE ${sequelize.escape(`%${term}%`)} OR product_name ILIKE ${sequelize.escape(`%${term}%`)})
      )`),
    ];
  }
  const { rows, count } = await PriceAdjustment.findAndCountAll({
    where,
    include: [{ model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] }],
    order: [['created_at', 'DESC']],
    limit: lim,
    offset: (pg - 1) * lim,
  });
  return { adjustments: rows, pagination: { page: pg, limit: lim, total: count, pages: Math.ceil(count / lim) } };
}

async function getPriceAdjustment(tenant_id, id) {
  const adjustment = await PriceAdjustment.findOne({
    where: { tenant_id, id },
    include: [
      { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] },
      { model: PriceAdjustmentItem, as: 'items' },
    ],
    order: [[{ model: PriceAdjustmentItem, as: 'items' }, 'sku', 'ASC']],
  });
  if (!adjustment) throw new PriceAdjustmentError('Ajuste de precio no encontrado', 404);
  return adjustment;
}

/** Historial de ajustes de precio de un producto (pestaña de la ficha). */
async function getProductPriceHistory(tenant_id, product_id, limit = 100) {
  return PriceAdjustmentItem.findAll({
    where: { tenant_id, product_id },
    include: [{
      model: PriceAdjustment, as: 'adjustment', attributes: ['id', 'adjustment_number', 'reason', 'notes', 'created_at'],
      include: [{ model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name', 'email'] }],
    }],
    order: [['created_at', 'DESC']],
    limit,
  });
}

module.exports = {
  PriceAdjustmentError,
  getProductsInfo,
  createPriceAdjustment,
  listPriceAdjustments,
  getPriceAdjustment,
  getProductPriceHistory,
};
