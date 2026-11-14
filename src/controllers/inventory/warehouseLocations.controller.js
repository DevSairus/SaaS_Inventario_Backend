// backend/src/controllers/inventory/warehouseLocations.controller.js
//
// Ubicaciones físicas de bodega (req. 2.2): pasillo / estante / nivel.
// Base: /api/inventory/locations
//
// El stock sigue siendo uno solo por producto (Product.current_stock); la
// ubicación dice dónde se guarda, no cuánto hay en cada lugar.

'use strict';

const { Op, fn, col } = require('sequelize');
const { sequelize } = require('../../config/database');
const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { WarehouseLocation, Warehouse, Product } = require('../../models/inventory');
const {
  httpError, normalizeLocationInput, expandRanges, resolveProductLocation, compareLocationCodes,
} = require('../../services/inventory/warehouseLocations.service');

const tenantOf = (req) => req.user?.tenant_id || req.tenant_id;

const fail = (res, error, fallback) => {
  if (error.status) return res.status(error.status).json({ success: false, message: error.message });
  if (error.name === 'SequelizeUniqueConstraintError') {
    return res.status(400).json({ success: false, message: 'Ya existe una ubicación con ese código en la bodega' });
  }
  logger.error(`[warehouseLocations] ${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
};

const loadWarehouse = async (tenantId, warehouseId, transaction) => {
  if (!warehouseId) throw httpError(400, 'La bodega es obligatoria');
  const wh = await Warehouse.findOne({ where: { id: warehouseId, tenant_id: tenantId }, transaction });
  if (!wh) throw httpError(400, 'La bodega indicada no existe');
  return wh;
};

const codeTaken = async (tenantId, warehouseId, code, excludeId, transaction) => {
  const where = { tenant_id: tenantId, warehouse_id: warehouseId, [Op.and]: [sequelize.where(fn('LOWER', col('code')), code.toLowerCase())] };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return WarehouseLocation.findOne({ where, transaction });
};

/** GET /?warehouse_id=&search=&is_active=&page=&limit= — con cantidad de productos por ubicación. */
const list = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { warehouse_id, search = '', is_active } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 50), 500);

    const where = { tenant_id: tenantId };
    if (warehouse_id) where.warehouse_id = warehouse_id;
    if (is_active !== undefined && is_active !== '') where.is_active = is_active === 'true';
    if (search) {
      where[Op.or] = [
        { code: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
        { aisle: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await WarehouseLocation.findAndCountAll({
      where,
      include: [{ model: Warehouse, as: 'warehouse', attributes: ['id', 'name', 'code'] }],
      // Orden natural en memoria (A-2 antes de A-10): el volumen por bodega es
      // de cientos, no de millones, y la paginación se aplica después.
      order: [['code', 'ASC']],
    });

    const sorted = rows.map((r) => r.toJSON()).sort((a, b) => compareLocationCodes(a.code, b.code));
    const pageRows = sorted.slice((page - 1) * limit, page * limit);

    // Productos por ubicación (una consulta agrupada para toda la página).
    const ids = pageRows.map((r) => r.id);
    const counts = ids.length
      ? await Product.findAll({
        where: { tenant_id: tenantId, location_id: { [Op.in]: ids } },
        attributes: ['location_id', [fn('COUNT', col('id')), 'n']],
        group: ['location_id'],
        raw: true,
      })
      : [];
    const countById = new Map(counts.map((c) => [c.location_id, parseInt(c.n, 10)]));

    res.json({
      success: true,
      data: pageRows.map((r) => ({ ...r, product_count: countById.get(r.id) || 0 })),
      pagination: { total: count, page, limit, totalPages: Math.ceil(count / limit) },
    });
  } catch (error) {
    fail(res, error, 'Error al obtener las ubicaciones');
  }
};

/** POST / { warehouse_id, code?, aisle?, shelf?, level?, description? } */
const create = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const wh = await loadWarehouse(tenantId, req.body.warehouse_id);
    const data = normalizeLocationInput(req.body);
    if (await codeTaken(tenantId, wh.id, data.code)) throw httpError(400, `Ya existe la ubicación ${data.code} en la bodega ${wh.name}`);
    const location = await WarehouseLocation.create({ ...data, tenant_id: tenantId, warehouse_id: wh.id });
    audit({ tenant_id: tenantId, user_id: req.user.id, action: 'create', entity: 'warehouse_location', entity_id: location.id, changes: data, req });
    res.status(201).json({ success: true, message: 'Ubicación creada', data: location });
  } catch (error) {
    fail(res, error, 'Error al crear la ubicación');
  }
};

/**
 * POST /bulk { warehouse_id, aisles: ['A','B'], shelves: 5 | [..], levels: 3 | [..] }
 * Crea pasillo × estante × nivel; las que ya existen se omiten (no es error).
 */
const bulkCreate = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const tenantId = tenantOf(req);
    const wh = await loadWarehouse(tenantId, req.body.warehouse_id, t);
    const combos = expandRanges(req.body);

    const existing = await WarehouseLocation.findAll({ where: { tenant_id: tenantId, warehouse_id: wh.id }, attributes: ['code'], transaction: t });
    const taken = new Set(existing.map((e) => e.code.toLowerCase()));
    const fresh = combos.filter((c) => !taken.has(c.code.toLowerCase()));

    if (fresh.length) {
      await WarehouseLocation.bulkCreate(
        fresh.map((c) => ({ ...c, tenant_id: tenantId, warehouse_id: wh.id })),
        { transaction: t }
      );
    }
    await t.commit();
    audit({ tenant_id: tenantId, user_id: req.user.id, action: 'bulk_create', entity: 'warehouse_location', changes: { warehouse_id: wh.id, created: fresh.length, skipped: combos.length - fresh.length }, req });
    res.status(201).json({
      success: true,
      message: `${fresh.length} ubicación(es) creada(s)${combos.length - fresh.length ? `, ${combos.length - fresh.length} ya existían` : ''}`,
      data: { created: fresh.length, skipped: combos.length - fresh.length },
    });
  } catch (error) {
    if (!t.finished) await t.rollback();
    fail(res, error, 'Error al crear las ubicaciones');
  }
};

/** PUT /:id — no se cambia de bodega (habría que mover los productos). */
const update = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const location = await WarehouseLocation.findOne({ where: { id: req.params.id, tenant_id: tenantId } });
    if (!location) return res.status(404).json({ success: false, message: 'Ubicación no encontrada' });

    const merged = { ...location.toJSON(), ...req.body };
    // Si se cambia pasillo/estante/nivel sin mandar el código, se recompone.
    if (req.body.code === undefined && (req.body.aisle !== undefined || req.body.shelf !== undefined || req.body.level !== undefined)) merged.code = undefined;
    const data = normalizeLocationInput(merged);
    if (req.body.is_active !== undefined) data.is_active = Boolean(req.body.is_active);

    if (data.code.toLowerCase() !== location.code.toLowerCase() && await codeTaken(tenantId, location.warehouse_id, data.code, location.id)) {
      throw httpError(400, `Ya existe la ubicación ${data.code} en esta bodega`);
    }
    await location.update(data);
    audit({ tenant_id: tenantId, user_id: req.user.id, action: 'update', entity: 'warehouse_location', entity_id: location.id, changes: data, req });
    res.json({ success: true, message: 'Ubicación actualizada', data: location });
  } catch (error) {
    fail(res, error, 'Error al actualizar la ubicación');
  }
};

/** DELETE /:id — los productos que estaban ahí quedan sin ubicación (FK SET NULL). */
const remove = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const tenantId = tenantOf(req);
    const location = await WarehouseLocation.findOne({ where: { id: req.params.id, tenant_id: tenantId }, transaction: t });
    if (!location) { await t.rollback(); return res.status(404).json({ success: false, message: 'Ubicación no encontrada' }); }
    const [released] = await Product.update({ location_id: null }, { where: { tenant_id: tenantId, location_id: location.id }, transaction: t });
    await location.destroy({ transaction: t });
    await t.commit();
    audit({ tenant_id: tenantId, user_id: req.user.id, action: 'delete', entity: 'warehouse_location', entity_id: location.id, changes: { code: location.code, products_released: released }, req });
    res.json({
      success: true,
      message: released ? `Ubicación eliminada; ${released} producto(s) quedaron sin ubicación` : 'Ubicación eliminada',
      data: { products_released: released },
    });
  } catch (error) {
    if (!t.finished) await t.rollback();
    fail(res, error, 'Error al eliminar la ubicación');
  }
};

/**
 * POST /assign { location_id | null, product_ids: [] }
 * Asigna (o quita, con location_id null) la ubicación a varios productos a la
 * vez. Todos deben estar en la bodega de la ubicación; si alguno no, no se
 * mueve ninguno y se dice cuáles.
 */
const assign = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const tenantId = tenantOf(req);
    const { location_id = null, product_ids } = req.body;
    if (!Array.isArray(product_ids) || !product_ids.length) throw httpError(400, 'Selecciona al menos un producto');
    if (product_ids.length > 1000) throw httpError(400, 'Máximo 1000 productos por asignación');

    const products = await Product.findAll({ where: { id: { [Op.in]: product_ids }, tenant_id: tenantId }, attributes: ['id', 'sku', 'warehouse_id'], transaction: t });
    if (products.length !== new Set(product_ids).size) throw httpError(400, 'Algún producto no existe');

    if (location_id) {
      const loc = await WarehouseLocation.findOne({ where: { id: location_id, tenant_id: tenantId }, transaction: t });
      if (!loc) throw httpError(400, 'La ubicación indicada no existe');
      if (!loc.is_active) throw httpError(400, `La ubicación ${loc.code} está inactiva`);
      const wrong = products.filter((p) => p.warehouse_id !== loc.warehouse_id);
      if (wrong.length) {
        const sample = wrong.slice(0, 5).map((p) => p.sku).join(', ');
        throw httpError(400, `${wrong.length} producto(s) no están en la bodega de la ubicación ${loc.code} (${sample}${wrong.length > 5 ? '…' : ''})`);
      }
    }

    await Product.update({ location_id: location_id || null }, { where: { id: { [Op.in]: products.map((p) => p.id) }, tenant_id: tenantId }, transaction: t });
    await t.commit();
    audit({ tenant_id: tenantId, user_id: req.user.id, action: 'assign', entity: 'warehouse_location', entity_id: location_id, changes: { products: products.length }, req });
    res.json({ success: true, message: location_id ? `${products.length} producto(s) ubicados` : `${products.length} producto(s) sin ubicación`, data: { updated: products.length } });
  } catch (error) {
    if (!t.finished) await t.rollback();
    fail(res, error, 'Error al asignar la ubicación');
  }
};

module.exports = { list, create, bulkCreate, update, remove, assign, resolveProductLocation };
