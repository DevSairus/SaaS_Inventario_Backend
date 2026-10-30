// backend/src/controllers/inventory/orderLists.controller.js
//
// Listas de pedido a proveedor: la libreta donde se va anotando qué hay que
// pedirle a cada proveedor (desde alertas de stock, la ficha del producto o a
// mano). Sin precios ni contabilidad: NO es una orden de compra.
//   - Una sola lista abierta por proveedor; anotar un producto que ya está en
//     ella suma la cantidad en vez de duplicar la línea.
//   - Líneas libres (sin producto del catálogo) permitidas; para convertir la
//     lista en compra todas deben quedar enlazadas a un producto.
//   - Marcarla pedida (o descartarla) la archiva en el historial; la
//     siguiente anotación para ese proveedor abre una lista nueva.
// Base: /api/inventory/order-lists (roles en routes/inventory/orderLists.routes.js)

const { Op } = require('sequelize');
const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const {
  SupplierOrderList, SupplierOrderListItem, Supplier, Product,
  Purchase, PurchaseItem, Tenant, User,
} = require('../../models');
const ProductSupplier = require('../../models/inventory/ProductSupplier');

const productAttributes = ['id', 'sku', 'name', 'unit_of_measure', 'current_stock', 'available_stock', 'min_stock', 'max_stock', 'reorder_point', 'last_purchase_cost', 'is_active'];
const supplierAttributes = ['id', 'name', 'business_name', 'tax_id', 'contact_name', 'phone', 'mobile', 'email', 'contact_email', 'contact_phone', 'is_active'];
const userAttributes = ['id', 'first_name', 'last_name', 'email'];

const VALID_SOURCES = ['manual', 'stock_alert', 'product'];

// SQL crudo: calificar con el schema del tenant (los modelos lo resuelven
// solos, ver config/registerTenantSchemaHooks.js; las literales no).
const itemsTable = () => `"${getCurrentSchema() || 'public'}"."supplier_order_list_items"`;
const listsTable = () => `"${getCurrentSchema() || 'public'}"."supplier_order_lists"`;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const userName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || null;

// req.user es el JWT decodificado (id, correo, rol): no trae el nombre. Para
// el "Solicitado por" del PDF, la firma del correo y el historial de envíos
// se lee el usuario de la base.
async function currentUserName(req) {
  const user = await User.findByPk(req.user.id, { attributes: userAttributes });
  return userName(user) || req.user.email || null;
}

// Agrega user_name a cada envío del historial (los registrados antes solo
// guardaban user_id).
async function withSenderNames(sentLog = []) {
  const ids = [...new Set(sentLog.filter((s) => s.user_id && !s.user_name).map((s) => s.user_id))];
  if (!ids.length) return sentLog;
  const users = await User.findAll({ where: { id: ids }, attributes: userAttributes });
  const names = new Map(users.map((u) => [u.id, userName(u)]));
  return sentLog.map((s) => (s.user_name || !s.user_id ? s : { ...s, user_name: names.get(s.user_id) || null }));
}

/**
 * Cantidad sugerida para pedir: llevar el stock hasta el máximo; si el
 * producto no tiene máximo, hasta el doble del mínimo / punto de reorden.
 * Nunca menos de 1 (si se está anotando es porque se quiere pedir algo).
 */
const suggestQuantity = (product) => {
  const current = Number(product?.current_stock) || 0;
  const max = Number(product?.max_stock) || 0;
  const min = Math.max(Number(product?.min_stock) || 0, Number(product?.reorder_point) || 0);
  const target = max > 0 ? max : min * 2;
  return Math.max(Math.ceil(target - current), 1);
};

const parseQuantity = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

// Consecutivo PED-000001 por tenant. El advisory lock serializa la
// numeración entre transacciones concurrentes del mismo tenant.
async function nextListNumber(tenant_id, transaction) {
  await sequelize.query(`SELECT pg_advisory_xact_lock(hashtext(:key))`, {
    replacements: { key: `supplier_order_lists:${tenant_id}` }, transaction,
  });
  const last = await SupplierOrderList.findOne({
    where: { tenant_id, list_number: { [Op.like]: 'PED-%' } },
    order: [['list_number', 'DESC']],
    attributes: ['list_number'],
    transaction,
  });
  const n = last ? (parseInt(String(last.list_number).split('-')[1], 10) || 0) + 1 : 1;
  return `PED-${String(n).padStart(6, '0')}`;
}

async function findOrCreateOpenList(tenant_id, supplier_id, user_id, transaction) {
  const existing = await SupplierOrderList.findOne({
    where: { tenant_id, supplier_id, status: 'open' }, transaction, lock: transaction.LOCK.UPDATE,
  });
  if (existing) return existing;
  const list_number = await nextListNumber(tenant_id, transaction);
  return SupplierOrderList.create({ tenant_id, supplier_id, list_number, status: 'open', created_by: user_id }, { transaction });
}

async function loadList(tenant_id, id, { transaction, taxAttributes = false } = {}) {
  const list = await SupplierOrderList.findOne({
    where: { id, tenant_id },
    include: [
      { model: Supplier, as: 'supplier', attributes: supplierAttributes },
      {
        model: SupplierOrderListItem, as: 'items',
        include: [
          { model: Product, as: 'product', attributes: taxAttributes ? [...productAttributes, 'has_tax', 'tax_percentage', 'tax_config'] : productAttributes },
          { model: User, as: 'adder', attributes: userAttributes },
        ],
      },
      { model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number', 'status'] },
      { model: User, as: 'orderer', attributes: userAttributes },
      { model: User, as: 'creator', attributes: userAttributes },
      { model: User, as: 'canceller', attributes: userAttributes },
    ],
    order: [[{ model: SupplierOrderListItem, as: 'items' }, 'created_at', 'ASC']],
    transaction,
  });
  if (!list) throw httpError(404, 'Lista de pedido no encontrada');
  return list;
}

// Código con el que el proveedor identifica cada producto (si se conoce).
async function supplierCodesFor(tenant_id, supplier_id, productIds) {
  const ids = productIds.filter(Boolean);
  if (!ids.length) return new Map();
  const links = await ProductSupplier.findAll({
    where: { tenant_id, supplier_id, product_id: ids },
    attributes: ['product_id', 'supplier_code'],
  });
  return new Map(links.filter((l) => l.supplier_code).map((l) => [l.product_id, l.supplier_code]));
}

const sendError = (res, error, fallback, where) => {
  if (!error.statusCode) logger.error(`Error en ${where}:`, error);
  res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : fallback });
};

/**
 * GET /order-lists?status=open|ordered|cancelled|history|all&supplier_id&search&page&limit
 * history = pedidas + descartadas.
 */
const getOrderLists = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status = 'open', supplier_id, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const where = { tenant_id };
    if (status === 'history') where.status = { [Op.in]: ['ordered', 'cancelled'] };
    else if (status && status !== 'all') where.status = status;
    if (supplier_id) where.supplier_id = supplier_id;

    // search: número de lista o nombre del proveedor.
    const items = itemsTable();
    const { rows, count } = await SupplierOrderList.findAndCountAll({
      where: search
        ? { ...where, [Op.or]: [
          { list_number: { [Op.iLike]: `%${search}%` } },
          { '$supplier.name$': { [Op.iLike]: `%${search}%` } },
          { '$supplier.business_name$': { [Op.iLike]: `%${search}%` } },
        ] }
        : where,
      include: [
        { model: Supplier, as: 'supplier', attributes: supplierAttributes },
        { model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number', 'status'] },
        { model: User, as: 'orderer', attributes: userAttributes },
        { model: User, as: 'creator', attributes: userAttributes },
        { model: User, as: 'canceller', attributes: userAttributes },
      ],
      attributes: {
        include: [
          [sequelize.literal(`(SELECT COUNT(*) FROM ${items} i WHERE i.list_id = "SupplierOrderList"."id")`), 'items_count'],
          [sequelize.literal(`(SELECT COUNT(*) FROM ${items} i WHERE i.list_id = "SupplierOrderList"."id" AND i.product_id IS NULL)`), 'free_items_count'],
          [sequelize.literal(`(SELECT MAX(i.updated_at) FROM ${items} i WHERE i.list_id = "SupplierOrderList"."id")`), 'last_item_at'],
        ],
      },
      order: status === 'open' ? [['updated_at', 'DESC']] : [['ordered_at', 'DESC NULLS LAST'], ['cancelled_at', 'DESC NULLS LAST'], ['created_at', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
      subQuery: false,
    });

    res.json({ success: true, data: rows, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } });
  } catch (error) {
    sendError(res, error, 'Error al obtener las listas de pedido', 'getOrderLists');
  }
};

const getOrderListsStats = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const [[row]] = await sequelize.query(`
      SELECT COUNT(DISTINCT l.id)::int AS open_lists, COUNT(i.id)::int AS open_items
        FROM ${listsTable()} l
        LEFT JOIN ${itemsTable()} i ON i.list_id = l.id
       WHERE l.tenant_id = :tenant_id AND l.status = 'open'
    `, { replacements: { tenant_id } });
    res.json({ success: true, data: row });
  } catch (error) {
    sendError(res, error, 'Error al obtener las estadísticas de pedidos', 'getOrderListsStats');
  }
};

/**
 * Productos que ya están anotados en listas abiertas (para marcar "En pedido"
 * en alertas de stock). GET /order-lists/pending-products?product_ids=a,b,c
 * Sin product_ids devuelve todos los de listas abiertas.
 */
const getPendingProducts = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const ids = String(req.query.product_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    const items = await SupplierOrderListItem.findAll({
      where: { tenant_id, product_id: ids.length ? ids : { [Op.ne]: null } },
      include: [{
        model: SupplierOrderList, as: 'list', where: { status: 'open' }, attributes: ['id', 'list_number', 'supplier_id'],
        include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name'] }],
      }],
      attributes: ['id', 'product_id', 'quantity'],
    });
    res.json({
      success: true,
      data: items.map((i) => ({
        product_id: i.product_id,
        quantity: Number(i.quantity),
        list_id: i.list.id,
        list_number: i.list.list_number,
        supplier_id: i.list.supplier_id,
        supplier_name: i.list.supplier?.business_name || i.list.supplier?.name || '',
      })),
    });
  } catch (error) {
    sendError(res, error, 'Error al obtener los productos en pedido', 'getPendingProducts');
  }
};

/**
 * Datos para el modal "Agregar a pedido": stock del producto, cantidad
 * sugerida, proveedores vinculados (el de la compra más reciente primero) y
 * en qué listas abiertas está ya. GET /order-lists/suggestion/:productId
 */
const getProductSuggestion = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const product = await Product.findOne({ where: { id: req.params.productId, tenant_id }, attributes: productAttributes });
    if (!product) throw httpError(404, 'Producto no encontrado');

    const links = await ProductSupplier.findAll({
      where: { tenant_id, product_id: product.id },
      attributes: ['supplier_id', 'supplier_code', 'last_purchase_date'],
    });
    let supplierIds = links.map((l) => l.supplier_id);

    // Sin vínculo en el pivote: proveedores de las compras del producto.
    let lastPurchaseBySupplier = new Map();
    if (!supplierIds.length) {
      const rows = await PurchaseItem.findAll({
        where: { product_id: product.id },
        include: [{ model: Purchase, as: 'purchase', where: { tenant_id, status: { [Op.ne]: 'cancelled' } }, attributes: ['supplier_id', 'purchase_date'] }],
        attributes: ['id'],
        order: [[{ model: Purchase, as: 'purchase' }, 'purchase_date', 'DESC']],
        limit: 50,
      });
      for (const r of rows) {
        if (!lastPurchaseBySupplier.has(r.purchase.supplier_id)) lastPurchaseBySupplier.set(r.purchase.supplier_id, r.purchase.purchase_date);
      }
      supplierIds = [...lastPurchaseBySupplier.keys()];
    }

    const suppliers = supplierIds.length
      ? await Supplier.findAll({ where: { tenant_id, id: supplierIds, is_active: true }, attributes: ['id', 'name', 'business_name'] })
      : [];
    const linkBy = new Map(links.map((l) => [l.supplier_id, l]));
    const list = suppliers.map((s) => ({
      id: s.id,
      name: s.business_name || s.name,
      supplier_code: linkBy.get(s.id)?.supplier_code || null,
      last_purchase_date: linkBy.get(s.id)?.last_purchase_date || lastPurchaseBySupplier.get(s.id) || null,
    })).sort((a, b) => String(b.last_purchase_date || '').localeCompare(String(a.last_purchase_date || '')));

    const pending = await SupplierOrderListItem.findAll({
      where: { tenant_id, product_id: product.id },
      include: [{ model: SupplierOrderList, as: 'list', where: { status: 'open' }, attributes: ['id', 'list_number', 'supplier_id'] }],
      attributes: ['id', 'quantity'],
    });

    res.json({
      success: true,
      data: {
        product,
        suggested_quantity: suggestQuantity(product),
        suppliers: list,
        default_supplier_id: list[0]?.id || null,
        pending: pending.map((p) => ({ list_id: p.list.id, list_number: p.list.list_number, supplier_id: p.list.supplier_id, quantity: Number(p.quantity) })),
      },
    });
  } catch (error) {
    sendError(res, error, 'Error al calcular la sugerencia de pedido', 'getProductSuggestion');
  }
};

const getOrderListById = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const list = await loadList(tenant_id, req.params.id);
    const codes = await supplierCodesFor(tenant_id, list.supplier_id, list.items.map((i) => i.product_id));
    const data = list.toJSON();
    data.items = data.items.map((i) => ({ ...i, supplier_code: codes.get(i.product_id) || null }));
    data.sent_log = await withSenderNames(data.sent_log);
    // Para ofrecer el envío del PDF por la Cloud API desde el detalle.
    try {
      const status = await require('../../services/whatsappCloud.service').getWhatsAppStatus(tenant_id);
      data.whatsapp_cloud = !!status.operational;
    } catch {
      data.whatsapp_cloud = false;
    }
    delete data.share_token;
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 'Error al obtener la lista de pedido', 'getOrderListById');
  }
};

/**
 * Anotar una línea en la lista abierta del proveedor (la crea si no existe).
 * POST /order-lists/items { supplier_id, product_id?, description?, quantity?, notes?, source? }
 * Si el producto ya está en la lista abierta, suma la cantidad.
 */
const addItem = async (req, res) => {
  const tenant_id = req.user.tenant_id;
  const { supplier_id, product_id, notes } = req.body || {};
  const description = String(req.body?.description || '').trim();
  const source = VALID_SOURCES.includes(req.body?.source) ? req.body.source : 'manual';

  const attempt = async () => {
    const t = await sequelize.transaction();
    try {
      if (!supplier_id) throw httpError(400, 'Indica el proveedor');
      const supplier = await Supplier.findOne({ where: { id: supplier_id, tenant_id }, attributes: ['id', 'is_active'], transaction: t });
      if (!supplier) throw httpError(404, 'Proveedor no encontrado');

      let product = null;
      if (product_id) {
        product = await Product.findOne({ where: { id: product_id, tenant_id }, attributes: productAttributes, transaction: t });
        if (!product) throw httpError(404, 'Producto no encontrado');
      } else if (!description) {
        throw httpError(400, 'Elige un producto o escribe la descripción de la línea libre');
      }

      let quantity = parseQuantity(req.body?.quantity);
      if (req.body?.quantity !== undefined && req.body?.quantity !== null && req.body?.quantity !== '' && quantity === null) {
        throw httpError(400, 'La cantidad debe ser mayor que cero');
      }
      if (quantity === null) quantity = product ? suggestQuantity(product) : 1;

      const list = await findOrCreateOpenList(tenant_id, supplier_id, req.user.id, t);

      let item = product
        ? await SupplierOrderListItem.findOne({ where: { list_id: list.id, product_id: product.id }, transaction: t, lock: t.LOCK.UPDATE })
        : null;
      let merged = false;
      if (item) {
        merged = true;
        const mergedNotes = [item.notes, notes].map((n) => String(n || '').trim()).filter(Boolean);
        await item.update({
          quantity: Math.round((Number(item.quantity) + quantity) * 100) / 100,
          notes: [...new Set(mergedNotes)].join(' · ') || null,
        }, { transaction: t });
      } else {
        item = await SupplierOrderListItem.create({
          tenant_id,
          list_id: list.id,
          product_id: product?.id || null,
          description: product ? null : description.slice(0, 255),
          quantity,
          notes: String(notes || '').trim() || null,
          source,
          added_by: req.user.id,
        }, { transaction: t });
      }
      // Toca la lista para que suba en el listado de abiertas.
      list.changed('updated_at', true);
      await list.save({ transaction: t });

      await t.commit();
      return { list, item, merged };
    } catch (error) {
      if (!t.finished) await t.rollback();
      throw error;
    }
  };

  try {
    let result;
    try {
      result = await attempt();
    } catch (error) {
      // Dos anotaciones simultáneas al mismo proveedor sin lista abierta:
      // una crea la lista y la otra choca con el índice único; se reintenta
      // y esta vez encuentra la lista ya creada.
      if (error.name !== 'SequelizeUniqueConstraintError') throw error;
      result = await attempt();
    }
    const { list, item, merged } = result;
    res.status(merged ? 200 : 201).json({
      success: true,
      message: merged ? `Cantidad sumada en el pedido ${list.list_number}` : `Agregado al pedido ${list.list_number}`,
      data: { list_id: list.id, list_number: list.list_number, item, merged },
    });
  } catch (error) {
    sendError(res, error, 'Error al agregar al pedido', 'addOrderListItem');
  }
};

async function loadOpenItem(tenant_id, itemId, transaction) {
  const item = await SupplierOrderListItem.findOne({
    where: { id: itemId, tenant_id },
    include: [{ model: SupplierOrderList, as: 'list', attributes: ['id', 'status', 'supplier_id'] }],
    transaction,
  });
  if (!item) throw httpError(404, 'Línea no encontrada');
  if (item.list.status !== 'open') throw httpError(400, 'El pedido ya está cerrado; no se puede modificar');
  return item;
}

/**
 * PATCH /order-lists/items/:itemId { quantity?, notes?, description?, product_id? }
 * product_id enlaza una línea libre a un producto del catálogo; si ese
 * producto ya estaba en la lista, las dos líneas se unen.
 */
const updateItem = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const item = await loadOpenItem(tenant_id, req.params.itemId, t);
    const body = req.body || {};
    const updates = {};

    if (body.quantity !== undefined) {
      const q = parseQuantity(body.quantity);
      if (q === null) throw httpError(400, 'La cantidad debe ser mayor que cero');
      updates.quantity = q;
    }
    if (body.notes !== undefined) updates.notes = String(body.notes || '').trim() || null;
    if (body.description !== undefined && !item.product_id) {
      const d = String(body.description || '').trim();
      if (!d) throw httpError(400, 'La línea libre necesita una descripción');
      updates.description = d.slice(0, 255);
    }

    let mergedInto = null;
    if (body.product_id && body.product_id !== item.product_id) {
      const product = await Product.findOne({ where: { id: body.product_id, tenant_id }, attributes: ['id'], transaction: t });
      if (!product) throw httpError(404, 'Producto no encontrado');
      const twin = await SupplierOrderListItem.findOne({
        where: { list_id: item.list_id, product_id: product.id, id: { [Op.ne]: item.id } }, transaction: t, lock: t.LOCK.UPDATE,
      });
      if (twin) {
        const qty = updates.quantity ?? Number(item.quantity);
        const notes = [twin.notes, updates.notes ?? item.notes, item.description].map((n) => String(n || '').trim()).filter(Boolean);
        await twin.update({ quantity: Math.round((Number(twin.quantity) + qty) * 100) / 100, notes: [...new Set(notes)].join(' · ') || null }, { transaction: t });
        await item.destroy({ transaction: t });
        mergedInto = twin;
      } else {
        updates.product_id = product.id;
        // La descripción libre queda como nota para no perder lo que se escribió.
        if (item.description) {
          const notes = [updates.notes ?? item.notes, item.description].map((n) => String(n || '').trim()).filter(Boolean);
          updates.notes = [...new Set(notes)].join(' · ');
        }
        updates.description = null;
      }
    }

    if (!mergedInto) await item.update(updates, { transaction: t });
    await t.commit();
    res.json({ success: true, message: mergedInto ? 'Línea unida con la del mismo producto' : 'Línea actualizada', data: mergedInto || item });
  } catch (error) {
    if (!t.finished) await t.rollback();
    sendError(res, error, 'Error al actualizar la línea', 'updateOrderListItem');
  }
};

const deleteItem = async (req, res) => {
  try {
    const item = await loadOpenItem(req.user.tenant_id, req.params.itemId);
    await item.destroy();
    res.json({ success: true, message: 'Línea eliminada' });
  } catch (error) {
    sendError(res, error, 'Error al eliminar la línea', 'deleteOrderListItem');
  }
};

// PATCH /order-lists/:id { notes }
const updateOrderList = async (req, res) => {
  try {
    const list = await SupplierOrderList.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!list) throw httpError(404, 'Lista de pedido no encontrada');
    if (list.status !== 'open') throw httpError(400, 'El pedido ya está cerrado; no se puede modificar');
    await list.update({ notes: String(req.body?.notes || '').trim() || null });
    res.json({ success: true, message: 'Observaciones guardadas', data: list });
  } catch (error) {
    sendError(res, error, 'Error al actualizar la lista de pedido', 'updateOrderList');
  }
};

/**
 * Marcar el pedido como realizado: queda en el historial y la próxima
 * anotación para el proveedor abre una lista nueva.
 * PATCH /order-lists/:id/close { notes? }
 */
const closeOrderList = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const list = await SupplierOrderList.findOne({ where: { id: req.params.id, tenant_id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!list) throw httpError(404, 'Lista de pedido no encontrada');
    if (list.status !== 'open') throw httpError(400, 'El pedido ya fue cerrado');
    const items = await SupplierOrderListItem.count({ where: { list_id: list.id }, transaction: t });
    if (!items) throw httpError(400, 'La lista está vacía');

    const updates = { status: 'ordered', ordered_at: new Date(), ordered_by: req.user.id };
    if (req.body?.notes !== undefined) updates.notes = String(req.body.notes || '').trim() || null;
    await list.update(updates, { transaction: t });
    await t.commit();

    setImmediate(() => audit({
      tenant_id, user_id: req.user.id, action: 'ORDER_LIST_CLOSED',
      entity: 'supplier_order_list', entity_id: list.id,
      changes: { list_number: list.list_number, supplier_id: list.supplier_id, items },
      req,
    }));
    res.json({ success: true, message: `Pedido ${list.list_number} marcado como realizado`, data: list });
  } catch (error) {
    if (!t.finished) await t.rollback();
    sendError(res, error, 'Error al cerrar el pedido', 'closeOrderList');
  }
};

// PATCH /order-lists/:id/cancel — descarta la lista (queda en el historial).
const cancelOrderList = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const list = await SupplierOrderList.findOne({ where: { id: req.params.id, tenant_id } });
    if (!list) throw httpError(404, 'Lista de pedido no encontrada');
    if (list.status !== 'open') throw httpError(400, 'El pedido ya fue cerrado');
    await list.update({ status: 'cancelled', cancelled_at: new Date(), cancelled_by: req.user.id });
    setImmediate(() => audit({
      tenant_id, user_id: req.user.id, action: 'ORDER_LIST_CANCELLED',
      entity: 'supplier_order_list', entity_id: list.id,
      changes: { list_number: list.list_number, supplier_id: list.supplier_id },
      req,
    }));
    res.json({ success: true, message: `Pedido ${list.list_number} descartado`, data: list });
  } catch (error) {
    sendError(res, error, 'Error al descartar el pedido', 'cancelOrderList');
  }
};

/**
 * Datos para precargar una compra desde la lista. Exige que todas las líneas
 * estén enlazadas a un producto y que la lista no tenga ya una compra.
 * GET /order-lists/:id/purchase-draft
 */
const getPurchaseDraft = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const list = await loadList(tenant_id, req.params.id, { taxAttributes: true });
    if (list.status === 'cancelled') throw httpError(400, 'El pedido fue descartado');
    if (list.purchase_id) throw httpError(400, `Este pedido ya tiene la compra ${list.purchase?.purchase_number || ''}`.trim());
    if (!list.items.length) throw httpError(400, 'La lista está vacía');

    const free = list.items.filter((i) => !i.product_id);
    if (free.length) {
      return res.status(400).json({
        success: false,
        code: 'FREE_LINES',
        message: `Hay ${free.length} línea(s) libre(s) sin producto del catálogo. Enlázalas a un producto (o elimínalas) para crear la compra.`,
        data: { free_items: free.map((i) => ({ id: i.id, description: i.description })) },
      });
    }
    const inactive = list.items.filter((i) => i.product && i.product.is_active === false);
    if (inactive.length) {
      throw httpError(400, `Productos inactivos en la lista: ${inactive.map((i) => i.product.name).join(', ')}`);
    }

    const prices = await ProductSupplier.findAll({
      where: { tenant_id, supplier_id: list.supplier_id, product_id: list.items.map((i) => i.product_id) },
      attributes: ['product_id', 'last_price'],
    });
    const priceBy = new Map(prices.map((p) => [p.product_id, Number(p.last_price) || 0]));

    res.json({
      success: true,
      data: {
        order_list_id: list.id,
        list_number: list.list_number,
        supplier_id: list.supplier_id,
        supplier_name: list.supplier?.business_name || list.supplier?.name || '',
        notes: list.notes || '',
        items: list.items.map((i) => ({
          product_id: i.product_id,
          name: i.product.name,
          sku: i.product.sku,
          quantity: Number(i.quantity),
          last_price: priceBy.get(i.product_id) || Number(i.product.last_purchase_cost) || 0,
          // Mismo IVA por defecto que PurchaseFormPage al elegir el producto.
          tax_rate: i.product.tax_config?.iva_status === 'excluido' || i.product.has_tax === false
            ? 0 : (Number(i.product.tax_percentage) || 0),
        })),
      },
    });
  } catch (error) {
    sendError(res, error, 'Error al preparar la compra', 'getPurchaseDraft');
  }
};

/**
 * Enlaza la compra creada a partir de la lista. Si la lista seguía abierta,
 * queda marcada como pedida. PATCH /order-lists/:id/link-purchase { purchase_id }
 */
const linkPurchase = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const list = await SupplierOrderList.findOne({ where: { id: req.params.id, tenant_id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!list) throw httpError(404, 'Lista de pedido no encontrada');
    if (list.status === 'cancelled') throw httpError(400, 'El pedido fue descartado');
    if (list.purchase_id) throw httpError(400, 'Este pedido ya tiene una compra enlazada');

    const purchase = await Purchase.findOne({ where: { id: req.body?.purchase_id, tenant_id }, attributes: ['id', 'supplier_id', 'purchase_number'], transaction: t });
    if (!purchase) throw httpError(404, 'Compra no encontrada');
    if (purchase.supplier_id !== list.supplier_id) throw httpError(400, 'La compra es de otro proveedor');

    const updates = { purchase_id: purchase.id };
    if (list.status === 'open') Object.assign(updates, { status: 'ordered', ordered_at: new Date(), ordered_by: req.user.id });
    await list.update(updates, { transaction: t });
    await t.commit();
    res.json({ success: true, message: `Pedido ${list.list_number} enlazado a la compra ${purchase.purchase_number}`, data: list });
  } catch (error) {
    if (!t.finished) await t.rollback();
    sendError(res, error, 'Error al enlazar la compra', 'linkOrderListPurchase');
  }
};

async function loadPdfData(req) {
  const tenant_id = req.user.tenant_id;
  const list = await loadList(tenant_id, req.params.id);
  if (!list.items.length) throw httpError(400, 'La lista está vacía');
  const supplierCodes = await supplierCodesFor(tenant_id, list.supplier_id, list.items.map((i) => i.product_id));
  const tenant = await Tenant.findByPk(tenant_id);
  return { list, tenant, opts: { supplierCodes, requestedBy: await currentUserName(req) } };
}

// GET /order-lists/:id/pdf
const getOrderListPdf = async (req, res) => {
  try {
    const { list, tenant, opts } = await loadPdfData(req);
    const { generateOrderListPDFBuffer } = require('../../services/orderListPdf.service');
    const buffer = await generateOrderListPDFBuffer(list, tenant, opts);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Pedido-${list.list_number}.pdf"`);
    res.send(buffer);
  } catch (error) {
    sendError(res, error, 'Error generando el PDF del pedido', 'getOrderListPdf');
  }
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);
const escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Envía el pedido al proveedor por correo con el PDF adjunto.
 * POST /order-lists/:id/send-email { to?, cc?, message? }
 */
const sendOrderListEmail = async (req, res) => {
  try {
    const { list, tenant, opts } = await loadPdfData(req);
    if (list.status === 'cancelled') throw httpError(400, 'No se puede enviar un pedido descartado');

    const supplier = list.supplier || {};
    const to = toList(req.body?.to).length ? toList(req.body.to) : [supplier.email, supplier.contact_email].filter(Boolean);
    const cc = toList(req.body?.cc);
    const invalid = [...to, ...cc].filter((e) => !isEmail(e));
    if (to.length === 0) throw httpError(400, 'El proveedor no tiene correo registrado: indica a quién enviar el pedido');
    if (invalid.length) throw httpError(400, `Correo(s) inválido(s): ${invalid.join(', ')}`);

    const { generateOrderListPDFBuffer } = require('../../services/orderListPdf.service');
    const pdf = await generateOrderListPDFBuffer(list, tenant, opts);

    const cfg = tenant?.dian_config || {};
    const company = cfg.company_name || tenant?.company_name || 'Nuestra empresa';
    const replyEmail = tenant?.email || cfg.email || req.user.email || null;
    const message = String(req.body?.message || '').trim();
    const html = `
      <p>Estimado(a) ${escapeHtml(supplier.contact_name || supplier.business_name || supplier.name || 'proveedor')},</p>
      ${message ? `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : `<p>Adjuntamos nuestro pedido <strong>${escapeHtml(list.list_number)}</strong> (${list.items.length} ítem(s)). Por favor confírmenos disponibilidad, precios y tiempo de entrega.</p>`}
      <p>${replyEmail ? `Para cualquier inquietud responda a este correo (${escapeHtml(replyEmail)}).` : ''}</p>
      <p>Cordialmente,<br>${escapeHtml(opts.requestedBy || '')}<br><strong>${escapeHtml(company)}</strong></p>
    `;

    const emailService = require('../../services/emailService');
    const result = await emailService.sendEmail({
      to,
      cc,
      replyTo: replyEmail ? { email: replyEmail, name: company } : undefined,
      subject: `Pedido ${list.list_number} — ${company}`,
      html,
      attachments: [{ filename: `Pedido-${list.list_number}.pdf`, content: pdf }],
    });
    if (result?.mode === 'log') {
      throw httpError(503, 'El envío de correos no está configurado en el servidor (Brevo). Descarga el PDF y envíalo manualmente.');
    }

    await SupplierOrderList.update(
      { sent_log: [...(list.sent_log || []), { date: new Date(), channel: 'email', to, cc, user_id: req.user.id, user_name: opts.requestedBy }] },
      { where: { id: list.id, tenant_id: list.tenant_id } }
    );
    res.json({ success: true, message: `Pedido enviado a ${to.join(', ')}`, data: { to, cc } });
  } catch (error) {
    sendError(res, error, 'Error enviando el pedido por correo', 'sendOrderListEmail');
  }
};

/**
 * Registra un envío hecho fuera del sistema (WhatsApp abierto desde el
 * navegador). POST /order-lists/:id/log-send { channel: 'whatsapp', to? }
 */
const logOrderListSend = async (req, res) => {
  try {
    const list = await SupplierOrderList.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!list) throw httpError(404, 'Lista de pedido no encontrada');
    const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : null;
    if (!channel) throw httpError(400, 'Canal no válido');
    const via = ['wa_me', 'file'].includes(req.body?.via) ? req.body.via : 'wa_me';
    await list.update({ sent_log: [...(list.sent_log || []), { date: new Date(), channel, via, to: req.body?.to || null, user_id: req.user.id, user_name: await currentUserName(req) }] });
    res.json({ success: true, data: list });
  } catch (error) {
    sendError(res, error, 'Error registrando el envío', 'logOrderListSend');
  }
};

const backendBaseUrl = (req) => (process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '').replace(/\/api$/, '');

/**
 * Enlace público al PDF del pedido, para compartirlo por WhatsApp sin la
 * Cloud API (wa.me no adjunta archivos). Lo crea la primera vez.
 * POST /order-lists/:id/share-link → { pdf_url }
 */
const getShareLink = async (req, res) => {
  try {
    const list = await SupplierOrderList.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!list) throw httpError(404, 'Lista de pedido no encontrada');
    if (list.status === 'cancelled') throw httpError(400, 'No se puede enviar un pedido descartado');
    if (!list.share_token) await list.update({ share_token: require('crypto').randomUUID() });
    res.json({ success: true, data: { pdf_url: `${backendBaseUrl(req)}/api/public/order-lists/${list.share_token}/pdf` } });
  } catch (error) {
    sendError(res, error, 'Error generando el enlace del pedido', 'getShareLink');
  }
};

/**
 * Envía el PDF del pedido como documento por la WhatsApp Cloud API del
 * tenant. Meta solo deja enviar un documento suelto si el proveedor escribió
 * en las últimas 24 h; si no, responde 409 (code WA_WINDOW_CLOSED) y la
 * pantalla ofrece el enlace al PDF.
 * POST /order-lists/:id/send-whatsapp { to }
 */
const sendOrderListWhatsApp = async (req, res) => {
  try {
    const to = String(req.body?.to || '').replace(/\D/g, '');
    if (to.length < 10) throw httpError(400, 'Escribe el celular del proveedor con indicativo (ej. 573001234567)');
    const { list, tenant, opts } = await loadPdfData(req);
    if (list.status === 'cancelled') throw httpError(400, 'No se puede enviar un pedido descartado');

    const waCloud = require('../../services/whatsappCloud.service');
    const status = await waCloud.getWhatsAppStatus(req.user.tenant_id);
    if (!status.operational) throw httpError(400, 'WhatsApp no está conectado');

    const { generateOrderListPDFBuffer } = require('../../services/orderListPdf.service');
    const pdf = await generateOrderListPDFBuffer(list, tenant, opts);
    const company = tenant?.dian_config?.company_name || tenant?.company_name || '';
    try {
      await waCloud.sendMediaFromTenant({
        tenantId: req.user.tenant_id,
        to,
        type: 'document',
        fileBuffer: pdf,
        mimeType: 'application/pdf',
        filename: `Pedido-${list.list_number}.pdf`,
        caption: `Pedido ${list.list_number}${company ? ` de ${company}` : ''} (${list.items.length} ítem(s)). Por favor confírmanos disponibilidad y tiempo de entrega.`,
        userId: req.user.id,
        source: 'api',
      });
    } catch (err) {
      if (err.code === 'WA_WINDOW_CLOSED') {
        return res.status(409).json({
          success: false,
          code: 'WA_WINDOW_CLOSED',
          message: 'El proveedor no te ha escrito por WhatsApp en las últimas 24 h, así que Meta no deja enviarle el PDF directo. Envíale el enlace al PDF.',
        });
      }
      throw err;
    }

    await SupplierOrderList.update(
      { sent_log: [...(list.sent_log || []), { date: new Date(), channel: 'whatsapp', via: 'cloud_api', to, user_id: req.user.id, user_name: opts.requestedBy }] },
      { where: { id: list.id, tenant_id: list.tenant_id } }
    );
    res.json({ success: true, message: `PDF enviado por WhatsApp a ${to}` });
  } catch (error) {
    sendError(res, error, 'Error enviando el pedido por WhatsApp', 'sendOrderListWhatsApp');
  }
};

/**
 * PDF público del pedido (sin sesión), por su share_token.
 * GET /api/public/order-lists/:token/pdf
 */
const getPublicOrderListPdf = async (req, res) => {
  const { resolveRecordSchemaByToken } = require('../../utils/publicTokenResolver');
  const { runWithTenantSchema } = require('../../config/tenantContext');
  try {
    const resolved = await resolveRecordSchemaByToken({ table: 'supplier_order_lists', column: 'share_token', token: req.params.token });
    if (!resolved) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    await runWithTenantSchema(resolved.schemaName, async () => {
      const base = await SupplierOrderList.findOne({ where: { id: resolved.id }, attributes: ['id', 'tenant_id', 'status'] });
      if (!base || base.status === 'cancelled') return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
      const list = await loadList(base.tenant_id, base.id);
      const supplierCodes = await supplierCodesFor(base.tenant_id, list.supplier_id, list.items.map((i) => i.product_id));
      const tenant = await Tenant.findByPk(base.tenant_id);
      // Responsable: quien lo marcó como pedido o, si sigue abierto, quien
      // lo compartió por última vez (o quien lo abrió).
      const sentLog = await withSenderNames(list.sent_log || []);
      const lastSender = [...sentLog].reverse().find((s) => s.user_name)?.user_name;
      const requestedBy = userName(list.orderer) || lastSender || userName(list.creator);
      const { generateOrderListPDFBuffer } = require('../../services/orderListPdf.service');
      const pdf = await generateOrderListPDFBuffer(list, tenant, { supplierCodes, requestedBy });
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Pedido-${list.list_number}.pdf"`,
        'Cache-Control': 'no-store',
      });
      res.send(pdf);
    });
  } catch (error) {
    logger.error('Error sirviendo el PDF público del pedido:', error);
    res.status(500).json({ success: false, message: 'Error generando el PDF del pedido' });
  }
};

module.exports = {
  suggestQuantity,
  getOrderLists,
  getOrderListsStats,
  getPendingProducts,
  getProductSuggestion,
  getOrderListById,
  addItem,
  updateItem,
  deleteItem,
  updateOrderList,
  closeOrderList,
  cancelOrderList,
  getPurchaseDraft,
  linkPurchase,
  getOrderListPdf,
  sendOrderListEmail,
  logOrderListSend,
  getShareLink,
  sendOrderListWhatsApp,
  getPublicOrderListPdf,
};
