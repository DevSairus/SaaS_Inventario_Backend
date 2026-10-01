// backend/src/controllers/inventory/combos.controller.js
//
// "Inventario > Combos" -- agrupaciones de productos/servicios que se cargan
// de una vez en factura, cotización (SaleFormPage) u orden de trabajo
// (POST /workshop/work-orders/:id/combos). El precio de cada componente
// arranca en el base_price del producto pero se guarda editado en el combo.
//
// En los documentos el combo se expande en sus componentes (líneas normales
// con combo_group_id) -- ver migración 2026092901-create-combos.

const { Op } = require('sequelize');
const { sequelize, Combo, ComboItem, Product } = require('../../models');
const logger = require('../../config/logger');

const PRODUCT_ATTRIBUTES = [
  'id', 'name', 'sku', 'base_price', 'has_tax', 'tax_percentage', 'price_includes_tax',
  'product_type', 'is_labor', 'track_inventory', 'current_stock', 'is_active', 'image_url',
];

const COMBO_INCLUDE = [{
  model: ComboItem,
  as: 'items',
  include: [{ model: Product, as: 'product', attributes: PRODUCT_ATTRIBUTES }],
}];

const COMBO_ORDER = [['name', 'ASC'], [{ model: ComboItem, as: 'items' }, 'sort_order', 'ASC']];

function toPositiveNumber(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toNonNegativeNumber(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Valida y normaliza los ítems del body contra los productos del tenant.
// Devuelve { rows } o { error }.
async function buildItemRows(tenant_id, items, transaction) {
  if (!Array.isArray(items) || items.length === 0)
    return { error: 'El combo debe tener al menos un producto o servicio' };

  const productIds = [...new Set(items.map(i => i?.product_id).filter(Boolean))];
  if (productIds.length !== items.length)
    return { error: 'Cada línea debe tener un producto y no se puede repetir el mismo producto' };

  const products = await Product.findAll({
    where: { id: { [Op.in]: productIds }, tenant_id },
    attributes: ['id', 'name', 'base_price', 'is_active'],
    transaction,
  });
  const byId = Object.fromEntries(products.map(p => [p.id, p]));

  const rows = [];
  for (const [index, item] of items.entries()) {
    const product = byId[item.product_id];
    if (!product) return { error: `Producto ${item.product_id} no encontrado` };
    if (!product.is_active) return { error: `El producto "${product.name}" está inactivo` };
    rows.push({
      tenant_id,
      product_id: product.id,
      quantity: toPositiveNumber(item.quantity, 1),
      unit_price: toNonNegativeNumber(item.unit_price, parseFloat(product.base_price) || 0),
      sort_order: index,
    });
  }
  return { rows };
}

async function findDuplicateName(tenant_id, name, excludeId) {
  const where = {
    tenant_id,
    [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())],
  };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return Combo.findOne({ where, attributes: ['id'] });
}

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { search, include_inactive = 'false' } = req.query;
    const where = { tenant_id };
    if (include_inactive !== 'true') where.is_active = true;
    if (search && search.trim()) where.name = { [Op.iLike]: `%${search.trim()}%` };

    const combos = await Combo.findAll({ where, include: COMBO_INCLUDE, order: COMBO_ORDER });
    res.json({ success: true, data: combos });
  } catch (error) {
    logger.error('Error listando combos:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los combos' });
  }
};

const getById = async (req, res) => {
  try {
    const combo = await Combo.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: COMBO_INCLUDE,
      order: COMBO_ORDER,
    });
    if (!combo) return res.status(404).json({ success: false, message: 'Combo no encontrado' });
    res.json({ success: true, data: combo });
  } catch (error) {
    logger.error('Error obteniendo combo:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el combo' });
  }
};

const create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const { name, description, show_breakdown = true, is_active = true, items } = req.body;
    if (!name || !String(name).trim()) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El nombre es requerido' });
    }
    const cleanName = String(name).trim().slice(0, 200);
    if (await findDuplicateName(tenant_id, cleanName)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Ya existe un combo con ese nombre' });
    }

    const { rows, error } = await buildItemRows(tenant_id, items, transaction);
    if (error) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: error });
    }

    const combo = await Combo.create({
      tenant_id,
      name: cleanName,
      description: description?.trim() || null,
      show_breakdown: !!show_breakdown,
      is_active: !!is_active,
      created_by: req.user.id || null,
    }, { transaction });
    await ComboItem.bulkCreate(rows.map(r => ({ ...r, combo_id: combo.id })), { transaction });
    await transaction.commit();

    const created = await Combo.findByPk(combo.id, { include: COMBO_INCLUDE, order: COMBO_ORDER });
    res.status(201).json({ success: true, message: 'Combo creado', data: created });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error creando combo:', error);
    res.status(500).json({ success: false, message: 'Error al crear el combo' });
  }
};

// Si viene `items` se reemplazan todos los componentes. Los documentos ya
// creados con el combo no cambian (guardan snapshot de sus líneas).
const update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const combo = await Combo.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!combo) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Combo no encontrado' });
    }

    const { name, description, show_breakdown, is_active, items } = req.body;
    let cleanName;
    if (name !== undefined) {
      cleanName = String(name).trim().slice(0, 200);
      if (!cleanName) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'El nombre es requerido' });
      }
      if (await findDuplicateName(tenant_id, cleanName, combo.id)) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'Ya existe un combo con ese nombre' });
      }
    }

    if (items !== undefined) {
      const { rows, error } = await buildItemRows(tenant_id, items, transaction);
      if (error) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: error });
      }
      await ComboItem.destroy({ where: { combo_id: combo.id }, transaction });
      await ComboItem.bulkCreate(rows.map(r => ({ ...r, combo_id: combo.id })), { transaction });
    }

    await combo.update({
      ...(cleanName !== undefined ? { name: cleanName } : {}),
      ...(description !== undefined ? { description: description?.trim() || null } : {}),
      ...(show_breakdown !== undefined ? { show_breakdown: !!show_breakdown } : {}),
      ...(is_active !== undefined ? { is_active: !!is_active } : {}),
    }, { transaction });
    await transaction.commit();

    const updated = await Combo.findByPk(combo.id, { include: COMBO_INCLUDE, order: COMBO_ORDER });
    res.json({ success: true, message: 'Combo actualizado', data: updated });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error actualizando combo:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el combo' });
  }
};

// Borrado real: las líneas de documentos que lo usaron quedan con
// combo_id = NULL (FK SET NULL) pero conservan combo_name / combo_group_id,
// así que siguen mostrándose agrupadas.
const remove = async (req, res) => {
  try {
    const combo = await Combo.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!combo) return res.status(404).json({ success: false, message: 'Combo no encontrado' });
    await combo.destroy();
    res.json({ success: true, message: 'Combo eliminado' });
  } catch (error) {
    logger.error('Error eliminando combo:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el combo' });
  }
};

module.exports = { list, getById, create, update, remove };
