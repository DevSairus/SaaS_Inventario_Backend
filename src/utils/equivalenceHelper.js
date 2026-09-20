const { ProductEquivalenceGroupMember, ProductEquivalenceGroup } = require('../models/inventory');
const { getInProcessMap } = require('../services/inventory/stockInProcess.service');

/**
 * Busca equivalentes con stock disponible para un producto.
 * Retorna array de { product_id, sku, name, available_stock, sale_price }
 * o array vacío si no tiene equivalencias o ninguno tiene stock.
 *
 * "Disponible" = disponible REAL (current_stock - en trámite), no el
 * products.available_stock almacenado (desincronizado, ver H3 del
 * documento de análisis de inventario) -- se calcula en batch con
 * getInProcessMap para no hacer una consulta por cada equivalente.
 */
async function getEquivalentsWithStock(productId, tenantId, opts = {}) {
  try {
    // Buscar membresías de este producto
    const memberWhere = { product_id: productId };
    if (tenantId) memberWhere.tenant_id = tenantId;

    const memberships = await ProductEquivalenceGroupMember.findAll({
      where: memberWhere,
      attributes: ['group_id']
    });

    if (memberships.length === 0) return [];

    const groupIds = memberships.map(m => m.group_id);

    // Traer todos los miembros de esos grupos (excepto el producto actual)
    const memberWhereClause = {
      group_id: groupIds,
      product_id: { [require('sequelize').Op.ne]: productId }
    };
    if (tenantId) memberWhereClause.tenant_id = tenantId;

    const members = await ProductEquivalenceGroupMember.findAll({
      where: memberWhereClause,
      include: [{
        model: require('../models/inventory').Product,
        as: 'product',
        attributes: ['id', 'sku', 'name', 'current_stock', 'sale_price', 'is_active'],
        where: { is_active: true }
      }]
    });

    // Deduplicar por product_id antes de calcular en trámite (batch)
    const seen = new Set();
    const uniqueMembers = [];
    for (const m of members) {
      if (!m.product || seen.has(m.product_id)) continue;
      seen.add(m.product_id);
      uniqueMembers.push(m);
    }

    const inProcessMap = await getInProcessMap(tenantId, uniqueMembers.map(m => m.product_id), {
      excludeSaleId: opts.excludeSaleId,
      excludeWorkOrderId: opts.excludeWorkOrderId,
    });

    const alternatives = [];
    for (const m of uniqueMembers) {
      const currentStock = parseFloat(m.product.current_stock || 0);
      const inProcessQty = inProcessMap[m.product_id]?.total || 0;
      const availableReal = currentStock - inProcessQty;
      if (availableReal > 0) {
        alternatives.push({
          product_id: m.product_id,
          sku: m.product.sku,
          name: m.product.name,
          available_stock: availableReal,
          sale_price: parseFloat(m.product.sale_price || 0)
        });
      }
    }

    return alternatives;
  } catch (error) {
    console.error('Error buscando equivalentes:', error);
    return [];
  }
}

module.exports = { getEquivalentsWithStock };
