const { ProductEquivalenceGroupMember, ProductEquivalenceGroup } = require('../models/inventory');

/**
 * Busca equivalentes con stock disponible para un producto.
 * Retorna array de { product_id, sku, name, available_stock, sale_price }
 * o array vacío si no tiene equivalencias o ninguno tiene stock.
 */
async function getEquivalentsWithStock(productId, tenantId) {
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
        attributes: ['id', 'sku', 'name', 'current_stock', 'available_stock', 'sale_price', 'is_active'],
        where: { is_active: true }
      }]
    });

    // Filtrar solo los que tienen stock > 0 y deduplicar por product_id
    const seen = new Set();
    const alternatives = [];

    for (const m of members) {
      if (!m.product || seen.has(m.product_id)) continue;
      const currentStock = parseFloat(m.product.current_stock || 0);
      const availableStock = parseFloat(m.product.available_stock || 0);
      const stock = availableStock > 0 ? availableStock : currentStock;
      if (stock > 0) {
        seen.add(m.product_id);
        alternatives.push({
          product_id: m.product_id,
          sku: m.product.sku,
          name: m.product.name,
          available_stock: stock,
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
