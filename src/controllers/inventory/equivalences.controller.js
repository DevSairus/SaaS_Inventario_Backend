const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  Product, ProductEquivalenceGroup, ProductEquivalenceGroupMember, Purchase, PurchaseItem, Supplier
} = require('../../models/inventory');
const { getInProcessMap } = require('../../services/inventory/stockInProcess.service');
const { productSalePrice } = require('../../utils/salePricing');

// Resumen de compras por producto para la pestaña de equivalencias: la última
// compra recibida (proveedor, fecha, costo, cantidad) y a cuántos proveedores
// distintos se le ha comprado. Una sola consulta para todos los miembros.
async function getPurchaseSummaryMap(tenantId, productIds) {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  if (ids.length === 0) return {};

  const items = await PurchaseItem.findAll({
    where: { product_id: { [Op.in]: ids } },
    attributes: ['product_id', 'unit_cost', 'quantity', 'received_quantity'],
    include: [{
      model: Purchase,
      as: 'purchase',
      required: true,
      where: { tenant_id: tenantId, status: { [Op.in]: ['partially_received', 'received'] } },
      attributes: ['id', 'purchase_date', 'supplier_id'],
      include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name', 'phone'] }]
    }],
    order: [[{ model: Purchase, as: 'purchase' }, 'purchase_date', 'DESC']]
  });

  const map = {};
  for (const item of items) {
    const entry = map[item.product_id] || (map[item.product_id] = { last: null, suppliers: new Set() });
    if (item.purchase.supplier_id) entry.suppliers.add(item.purchase.supplier_id);
    if (entry.last) continue;
    const supplier = item.purchase.supplier;
    entry.last = {
      purchase_id: item.purchase.id,
      date: item.purchase.purchase_date,
      unit_cost: parseFloat(item.unit_cost) || 0,
      quantity: parseFloat(item.received_quantity ?? item.quantity) || 0,
      supplier_id: supplier?.id || null,
      supplier_name: supplier ? (supplier.business_name || supplier.name) : null,
      supplier_phone: supplier?.phone || null
    };
  }

  for (const id of Object.keys(map)) {
    map[id] = { last: map[id].last, suppliers_count: map[id].suppliers.size };
  }
  return map;
}

// GET /products/:id/equivalents
// Retorna los grupos de equivalencia donde está este producto, con todos sus miembros y stock en vivo
const getProductEquivalents = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    let whereClause = { id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }

    const product = await Product.findOne({ where: whereClause, attributes: ['id', 'sku', 'name'] });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    const tenantId = req.user.role === 'super_admin' ? null : req.user.tenant_id;

    // Buscar membresías de este producto
    const memberWhere = { product_id: id };
    if (tenantId) memberWhere.tenant_id = tenantId;

    const memberships = await ProductEquivalenceGroupMember.findAll({
      where: memberWhere,
      include: [{
        model: ProductEquivalenceGroup,
        as: 'group',
        attributes: ['id', 'name', 'notes', 'created_by', 'created_at']
      }]
    });

    if (memberships.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Para cada grupo, traer TODOS los miembros con datos de producto
    const groupMembersList = [];
    for (const membership of memberships) {
      const group = membership.group;
      const memberWhereClause = { group_id: group.id };
      if (tenantId) memberWhereClause.tenant_id = tenantId;

      const members = await ProductEquivalenceGroupMember.findAll({
        where: memberWhereClause,
        include: [{
          model: Product,
          as: 'product',
          attributes: [
            'id', 'sku', 'name', 'brand', 'unit_of_measure', 'current_stock', 'min_stock',
            'track_inventory', 'base_price', 'sale_price', 'average_cost', 'last_purchase_cost',
            'last_purchase_date', 'is_active', 'image_url'
          ]
        }],
        order: [['role', 'ASC'], ['created_at', 'ASC']]
      });

      groupMembersList.push({ group, members });
    }

    // "Disponible" real (current_stock - en trámite), no el available_stock
    // almacenado -- una sola consulta agrupada para todos los miembros de
    // todos los grupos (evita N+1 por producto).
    const allProductIds = groupMembersList.flatMap(({ members }) => members.map(m => m.product_id));
    const inProcessMap = tenantId ? await getInProcessMap(tenantId, allProductIds) : {};
    const purchaseMap = tenantId ? await getPurchaseSummaryMap(tenantId, allProductIds) : {};

    const groups = groupMembersList.map(({ group, members }) => ({
      group_id: group.id,
      group_name: group.name,
      group_notes: group.notes,
      created_by: group.created_by,
      created_at: group.created_at,
      members: members.map(m => {
        const currentStock = m.product ? parseFloat(m.product.current_stock) : 0;
        const inProcessQty = inProcessMap[m.product_id]?.total || 0;
        const purchases = purchaseMap[m.product_id];
        return {
          member_id: m.id,
          product_id: m.product_id,
          role: m.role,
          notes: m.notes,
          sku: m.product?.sku,
          name: m.product?.name,
          brand: m.product?.brand || null,
          unit_of_measure: m.product?.unit_of_measure || null,
          track_inventory: m.product?.track_inventory !== false,
          current_stock: currentStock,
          in_process_stock: inProcessQty,
          available_stock: currentStock - inProcessQty,
          min_stock: m.product ? parseFloat(m.product.min_stock) || 0 : 0,
          sale_price: m.product ? productSalePrice(m.product) : 0,
          average_cost: m.product ? parseFloat(m.product.average_cost) || 0 : 0,
          last_purchase_cost: m.product ? parseFloat(m.product.last_purchase_cost) || 0 : 0,
          last_purchase: purchases?.last || null,
          suppliers_count: purchases?.suppliers_count || 0,
          is_active: m.product?.is_active,
          image_url: m.product?.image_url
        };
      })
    }));

    res.json({ success: true, data: groups });
  } catch (error) {
    console.error('Error en getProductEquivalents:', error);
    res.status(500).json({ success: false, message: 'Error al obtener equivalencias' });
  }
};

// POST /products/:id/equivalents
// Body: { group_id?, new_group_name?, notes?, role? }
// Crea un grupo nuevo o agrega el producto a un grupo existente
const addToEquivalenceGroup = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { group_id, new_group_name, notes, role = 'equivalente' } = req.body;
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }

    const tenantId = req.user.role === 'super_admin' ? (req.body.tenant_id || null) : req.user.tenant_id;
    if (!tenantId) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    // Verificar que el producto existe
    const product = await Product.findOne({ where: { id, tenant_id: tenantId }, transaction });
    if (!product) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    // Validar role
    const validRoles = ['referencia', 'equivalente'];
    const safeRole = validRoles.includes(role) ? role : 'equivalente';

    let group;

    if (group_id) {
      // Agregar a grupo existente
      group = await ProductEquivalenceGroup.findOne({ where: { id: group_id, tenant_id: tenantId }, transaction });
      if (!group) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: 'Grupo de equivalencia no encontrado' });
      }
    } else if (new_group_name) {
      // Crear grupo nuevo
      group = await ProductEquivalenceGroup.create({
        tenant_id: tenantId,
        name: new_group_name.trim(),
        notes: notes || null,
        created_by: req.user.id
      }, { transaction });
    } else {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Debe proporcionar group_id o new_group_name' });
    }

    // Verificar que el producto no esté ya en este grupo
    const existing = await ProductEquivalenceGroupMember.findOne({
      where: { group_id: group.id, product_id: id, tenant_id: tenantId },
      transaction
    });
    if (existing) {
      await transaction.rollback();
      return res.status(409).json({ success: false, message: 'Este producto ya pertenece a este grupo' });
    }

    const member = await ProductEquivalenceGroupMember.create({
      tenant_id: tenantId,
      group_id: group.id,
      product_id: id,
      role: safeRole,
      notes: notes || null
    }, { transaction });

    await transaction.commit();
    res.status(201).json({
      success: true,
      message: 'Producto agregado al grupo de equivalencia',
      data: {
        member_id: member.id,
        group_id: group.id,
        group_name: group.name,
        product_id: id,
        role: safeRole
      }
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error en addToEquivalenceGroup:', error);
    res.status(500).json({ success: false, message: 'Error al agregar a grupo de equivalencia' });
  }
};

// DELETE /products/:id/equivalents/:groupId
// Saca el producto de ese grupo
const removeFromEquivalenceGroup = async (req, res) => {
  try {
    const { id, groupId } = req.params;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    let whereClause = { product_id: id, group_id: groupId };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }

    const member = await ProductEquivalenceGroupMember.findOne({ where: whereClause });
    if (!member) return res.status(404).json({ success: false, message: 'Miembro no encontrado en este grupo' });

    await member.destroy();

    // Si el grupo quedó vacío, eliminarlo también
    const remainingMembers = await ProductEquivalenceGroupMember.count({ where: { group_id: groupId } });
    if (remainingMembers === 0) {
      await ProductEquivalenceGroup.destroy({ where: { id: groupId } });
    }

    res.json({ success: true, message: 'Producto removido del grupo de equivalencia' });
  } catch (error) {
    console.error('Error en removeFromEquivalenceGroup:', error);
    res.status(500).json({ success: false, message: 'Error al remover del grupo' });
  }
};

// GET /equivalence-groups?search=
// Busca grupos existentes por nombre (para el flujo "agregar a grupo existente")
const searchEquivalenceGroups = async (req, res) => {
  try {
    const { search = '', limit = 20 } = req.query;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 100);

    let whereClause = {};
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }

    if (search) {
      whereClause.name = { [Op.iLike]: `%${search}%` };
    }

    const groups = await ProductEquivalenceGroup.findAll({
      where: whereClause,
      attributes: ['id', 'name', 'notes', 'created_at'],
      include: [{
        model: ProductEquivalenceGroupMember,
        as: 'members',
        attributes: ['id'],
        include: [{
          model: Product,
          as: 'product',
          attributes: ['id', 'sku', 'name']
        }]
      }],
      order: [['name', 'ASC']],
      limit: safeLimit
    });

    const data = groups.map(g => ({
      id: g.id,
      name: g.name,
      notes: g.notes,
      created_at: g.created_at,
      member_count: g.members.length,
      members_preview: g.members.slice(0, 5).map(m => ({
        sku: m.product?.sku,
        name: m.product?.name
      }))
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en searchEquivalenceGroups:', error);
    res.status(500).json({ success: false, message: 'Error al buscar grupos' });
  }
};

// PUT /products/:id/equivalents/:groupId/member/:memberId
// Actualiza el rol o notas de un miembro dentro de un grupo
const updateMember = async (req, res) => {
  try {
    const { id, groupId, memberId } = req.params;
    const { role, notes } = req.body;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });

    let whereClause = { id: memberId, group_id: groupId, product_id: id };
    if (req.user.role !== 'super_admin') {
      if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
      whereClause.tenant_id = req.user.tenant_id;
    }

    const member = await ProductEquivalenceGroupMember.findOne({ where: whereClause });
    if (!member) return res.status(404).json({ success: false, message: 'Miembro no encontrado' });

    const updateData = {};
    if (role && ['referencia', 'equivalente'].includes(role)) updateData.role = role;
    if (notes !== undefined) updateData.notes = notes;

    await member.update(updateData);

    res.json({ success: true, message: 'Miembro actualizado', data: { member_id: member.id, role: member.role, notes: member.notes } });
  } catch (error) {
    console.error('Error en updateMember:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar miembro' });
  }
};

// POST /products/equivalents/batch-check
// Body: { product_ids: [...] }
// Retorna para cada producto: cuántos equivalentes con stock tiene
const batchCheckEquivalents = async (req, res) => {
  try {
    const { product_ids } = req.body;
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      return res.json({ success: true, data: {} });
    }

    const tenantId = req.user.role === 'super_admin' ? null : req.user.tenant_id;

    const memberWhere = { product_id: { [Op.in]: product_ids } };
    if (tenantId) memberWhere.tenant_id = tenantId;

    const memberships = await ProductEquivalenceGroupMember.findAll({
      where: memberWhere,
      attributes: ['product_id', 'group_id']
    });

    if (memberships.length === 0) {
      const empty = {};
      product_ids.forEach(id => { empty[id] = 0; });
      return res.json({ success: true, data: empty });
    }

    const groupIds = [...new Set(memberships.map(m => m.group_id))];
    const productGroupMap = {};
    memberships.forEach(m => {
      if (!productGroupMap[m.product_id]) productGroupMap[m.product_id] = new Set();
      productGroupMap[m.product_id].add(m.group_id);
    });

    const allMemberWhere = { group_id: { [Op.in]: groupIds } };
    if (tenantId) allMemberWhere.tenant_id = tenantId;

    const allMembers = await ProductEquivalenceGroupMember.findAll({
      where: allMemberWhere,
      include: [{
        model: Product,
        as: 'product',
        attributes: ['id', 'current_stock', 'is_active'],
        where: { is_active: true }
      }]
    });

    // Disponible real (current_stock - en trámite), una sola consulta
    // agrupada para todos los productos involucrados en vez de leer
    // available_stock (desincronizado, ver H3).
    const inProcessMap = tenantId
      ? await getInProcessMap(tenantId, allMembers.map(m => m.product_id))
      : {};

    const result = {};
    product_ids.forEach(id => { result[id] = 0; });

    for (const productId of product_ids) {
      const groups = productGroupMap[productId];
      if (!groups) continue;

      const seen = new Set();
      for (const member of allMembers) {
        if (member.product_id === productId) continue;
        if (!groups.has(member.group_id)) continue;
        if (seen.has(member.product_id)) continue;

        const currentStock = parseFloat(member.product?.current_stock || 0);
        const inProcessQty = inProcessMap[member.product_id]?.total || 0;
        const stock = currentStock - inProcessQty;
        if (stock > 0) {
          seen.add(member.product_id);
          result[productId] = (result[productId] || 0) + 1;
        }
      }
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error en batchCheckEquivalents:', error);
    res.status(500).json({ success: false, message: 'Error al verificar equivalentes' });
  }
};

module.exports = {
  getProductEquivalents,
  addToEquivalenceGroup,
  removeFromEquivalenceGroup,
  searchEquivalenceGroups,
  updateMember,
  batchCheckEquivalents
};
