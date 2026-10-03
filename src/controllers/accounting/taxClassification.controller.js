// backend/src/controllers/accounting/taxClassification.controller.js
//
// "Clasificación tributaria": la pantalla del CONTADOR para decidir el
// concepto de retención (compras, servicios, honorarios…) de lo que compra el
// tenant, sin que el dueño del negocio tenga que entenderlo ni el contador
// revisar producto por producto:
//  - por categoría (pocas): se asigna el concepto y lo heredan sus productos;
//  - excepciones por producto, en bloque;
//  - resumen de compras del año por concepto (con detalle) para validar
//    antes de la Exógena 1001.
// Sin asignar nada, el sistema clasifica solo: servicio → "servicios", lo
// demás → "compras" (ver retentionEngine.service.js).

'use strict';

const { Op, QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { Product, Category, Tenant } = require('../../models');
const { resolveFiscalProfile } = require('../../services/retentionEngine.service');
const { fetchPurchaseRows, purchaseItemsSql } = require('../../services/exogena/format1001.service');

const fail = (res, error, msg) => {
  console.error(msg, error);
  res.status(500).json({ success: false, message: msg });
};

async function loadConcepts(tenantId) {
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['tax_config'] });
  return resolveFiscalProfile(tenant?.tax_config || {}).concepts;
}

const yearRange = (year) => {
  const y = Number(year) || new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31`, year: y };
};

// GET /tax-classification?year=
// Resumen del año por concepto + categorías con su concepto y movimiento.
exports.overview = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const schema = getCurrentSchema() || 'public';
    const { from, to, year } = yearRange(req.query.year);
    const concepts = await loadConcepts(tenantId);

    // Resumen por concepto (mismo cálculo que la Exógena 1001).
    const rows = await fetchPurchaseRows(tenantId, from, to);
    const byConcept = new Map();
    for (const r of rows) {
      const id = r.source_key.replace(/^purchase:/, '');
      if (!byConcept.has(id)) byConcept.set(id, { concept_id: id, base: 0, retefuente: 0, reteiva: 0, suppliers: new Set() });
      const c = byConcept.get(id);
      c.base += Number(r.pago || 0);
      c.retefuente += Number(r.retp || 0);
      c.reteiva += Number(r.comun || 0);
      c.suppliers.add(r.supplier_id);
    }
    const names = new Map(concepts.map((c) => [c.id, c.name]));
    const summary = [...byConcept.values()]
      .map((c) => ({ ...c, name: names.get(c.concept_id) || c.concept_id, suppliers: c.suppliers.size, base: Math.round(c.base), retefuente: Math.round(c.retefuente), reteiva: Math.round(c.reteiva) }))
      .sort((a, b) => b.base - a.base);

    // Categorías: productos, excepciones y compras del año.
    const categories = await sequelize.query(
      `SELECT c.id, c.name, c.retention_concept,
              (SELECT COUNT(*) FROM "${schema}"."products" p WHERE p.category_id = c.id AND p.tenant_id = :tenantId) AS products,
              (SELECT COUNT(*) FROM "${schema}"."products" p WHERE p.category_id = c.id AND p.tenant_id = :tenantId AND p.product_type = 'service') AS services,
              (SELECT COUNT(*) FROM "${schema}"."products" p WHERE p.category_id = c.id AND p.tenant_id = :tenantId AND COALESCE(p.retention_concept, '') <> '') AS overrides,
              COALESCE((SELECT SUM(pi.subtotal) FROM "${schema}"."purchase_items" pi
                        JOIN "${schema}"."purchases" pu ON pu.id = pi.purchase_id
                        JOIN "${schema}"."products" p ON p.id = pi.product_id
                        WHERE p.category_id = c.id AND pu.tenant_id = :tenantId
                          AND pu.status NOT IN ('draft', 'cancelled')
                          AND pu.purchase_date BETWEEN :from AND :to), 0) AS purchased
       FROM "${schema}"."categories" c
       WHERE c.tenant_id = :tenantId AND COALESCE(c.is_active, true) = true
       ORDER BY purchased DESC, c.name ASC`,
      { replacements: { tenantId, from, to }, type: QueryTypes.SELECT }
    );

    const uncategorized = await sequelize.query(
      `SELECT COUNT(*) AS products FROM "${schema}"."products" WHERE tenant_id = :tenantId AND category_id IS NULL`,
      { replacements: { tenantId }, type: QueryTypes.SELECT }
    );

    res.json({
      success: true,
      data: {
        year,
        concepts,
        summary,
        categories: categories.map((c) => ({
          ...c,
          products: Number(c.products), services: Number(c.services), overrides: Number(c.overrides), purchased: Math.round(Number(c.purchased)),
        })),
        uncategorized_products: Number(uncategorized[0]?.products || 0),
      },
    });
  } catch (error) {
    fail(res, error, 'Error cargando la clasificación tributaria');
  }
};

// GET /tax-classification/lines?year=&concept_id=
// Detalle de lo comprado bajo un concepto (para revisar antes de la Exógena).
exports.lines = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const schema = getCurrentSchema() || 'public';
    const { from, to } = yearRange(req.query.year);
    const conceptId = String(req.query.concept_id || '');
    const items = await sequelize.query(
      `SELECT x.*, pu.purchase_number, pu.purchase_date, COALESCE(s.business_name, s.name) AS supplier_name,
              pr.id AS product_id, pr.name AS product_name, pr.sku, pr.product_type, pr.retention_concept AS product_concept,
              c.name AS category_name, c.retention_concept AS category_concept
       FROM (${purchaseItemsSql(schema).replace('SELECT p.id AS purchase_id,', 'SELECT pi.id AS item_id, pi.product_id AS item_product_id, p.id AS purchase_id,')}) x
       JOIN "${schema}"."purchases" pu ON pu.id = x.purchase_id
       JOIN "${schema}"."suppliers" s ON s.id = x.supplier_id
       LEFT JOIN "${schema}"."products" pr ON pr.id = x.item_product_id
       LEFT JOIN "${schema}"."categories" c ON c.id = pr.category_id
       WHERE x.concept_id = :conceptId
       ORDER BY pu.purchase_date DESC
       LIMIT 500`,
      { replacements: { tenantId, from, to, conceptId }, type: QueryTypes.SELECT }
    );
    res.json({
      success: true,
      data: items.map((i) => ({
        item_id: i.item_id,
        purchase_id: i.purchase_id,
        purchase_number: i.purchase_number,
        purchase_date: i.purchase_date,
        supplier_name: i.supplier_name,
        product_id: i.product_id,
        product_name: i.product_name,
        sku: i.sku,
        category_name: i.category_name,
        subtotal: Number(i.subtotal),
        // De dónde sale el concepto, para que el contador sepa qué cambiar.
        source: i.product_concept ? 'producto' : (i.category_concept ? 'categoría' : 'automático'),
      })),
    });
  } catch (error) {
    fail(res, error, 'Error cargando el detalle del concepto');
  }
};

// PUT /tax-classification/categories  { assignments: [{ category_id, concept_id|null }] }
exports.saveCategories = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const concepts = new Set((await loadConcepts(tenantId)).map((c) => c.id));
    const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    let updated = 0;
    for (const a of assignments) {
      if (!a?.category_id) continue;
      const concept = a.concept_id && concepts.has(a.concept_id) ? a.concept_id : null;
      const [n] = await Category.update({ retention_concept: concept }, { where: { id: a.category_id, tenant_id: tenantId } });
      updated += n;
    }
    res.json({ success: true, data: { updated } });
  } catch (error) {
    fail(res, error, 'Error guardando la clasificación de categorías');
  }
};

// GET /tax-classification/products?search=&category_id=&type=&only_overrides=&page=
exports.products = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { search, category_id, type, only_overrides } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = 50;
    const where = { tenant_id: tenantId };
    if (search) {
      const like = `%${String(search).trim()}%`;
      where[Op.or] = [{ name: { [Op.iLike]: like } }, { sku: { [Op.iLike]: like } }];
    }
    if (category_id === 'none') where.category_id = null;
    else if (category_id) where.category_id = category_id;
    if (type === 'service') where.product_type = 'service';
    else if (type === 'goods') where.product_type = { [Op.ne]: 'service' };
    if (only_overrides === 'true') where.retention_concept = { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] };

    const { count, rows } = await Product.findAndCountAll({
      where,
      attributes: ['id', 'sku', 'name', 'product_type', 'category_id', 'retention_concept'],
      include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'retention_concept'], required: false }],
      order: [['name', 'ASC']],
      limit,
      offset: (page - 1) * limit,
    });

    res.json({
      success: true,
      data: rows.map((p) => {
        const inherited = p.category?.retention_concept || (p.product_type === 'service' ? 'servicios' : 'compras');
        return {
          id: p.id, sku: p.sku, name: p.name, product_type: p.product_type,
          category_name: p.category?.name || null,
          retention_concept: p.retention_concept || null,
          effective_concept: p.retention_concept || inherited,
          inherited_concept: inherited,
          inherited_from: p.category?.retention_concept ? 'categoría' : 'automático',
        };
      }),
      pagination: { page, limit, total: count, pages: Math.ceil(count / limit) },
    });
  } catch (error) {
    fail(res, error, 'Error listando productos');
  }
};

// PUT /tax-classification/products  { product_ids: [], concept_id|null }
// concept_id null = quitar la excepción (vuelve a heredar de su categoría).
exports.saveProducts = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const ids = Array.isArray(req.body?.product_ids) ? req.body.product_ids.slice(0, 1000) : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'Selecciona al menos un producto' });
    const concepts = new Set((await loadConcepts(tenantId)).map((c) => c.id));
    const conceptId = req.body?.concept_id || null;
    if (conceptId && !concepts.has(conceptId)) return res.status(400).json({ success: false, message: 'Concepto no válido' });
    const [n] = await Product.update({ retention_concept: conceptId }, { where: { id: ids, tenant_id: tenantId } });
    res.json({ success: true, data: { updated: n } });
  } catch (error) {
    fail(res, error, 'Error guardando la clasificación de productos');
  }
};
