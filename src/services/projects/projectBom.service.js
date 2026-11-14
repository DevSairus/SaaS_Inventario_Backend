// backend/src/services/projects/projectBom.service.js
//
// Lista de materiales (BOM) de un proyecto -- caso de demo 1 de SOLIER:
// pegar 100 ítems desde Excel, emparejarlos con el catálogo, ver el
// disponible, reservar lo que hay, pedir lo que falta (agrupado por
// proveedor) y despachar lo reservado a la bodega de la obra.
//
//   preview   parsea y empareja sin guardar
//   save      guarda las líneas (reemplaza o agrega)
//   reserve   aparta stock disponible (qty_reserved); se calcula al leer como
//             "en trámite", no toca products.reserved_stock
//   orderLists anota los faltantes en pedidos a proveedor del proyecto
//   dispatch  traslado bodega → bodega de la obra, ya enviado (en tránsito);
//             se recibe desde Traslados como cualquier otro

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const {
  Project, ProjectBomItem, ProjectBudgetLine, Product, Supplier, Warehouse,
  Transfer, TransferItem, SupplierOrderListItem,
} = require('../../models');
const ProductSupplier = require('../../models/inventory/ProductSupplier');
const { parseBomText, normalize } = require('./bomParser');
const { getInProcessMap } = require('../inventory/stockInProcess.service');
const { getWarehouseBalance, INACTIVE_STATUSES } = require('./projectStock.service');

const httpError = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra || {});
const num = (v) => Number(v) || 0;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const table = (name) => `"${getCurrentSchema() || 'public'}"."${name}"`;

const PRODUCT_ATTRS = ['id', 'sku', 'barcode', 'name', 'unit_of_measure', 'current_stock', 'average_cost', 'last_purchase_cost', 'track_inventory', 'product_type', 'is_active', 'allow_negative_stock'];

// Estados en los que el BOM ya no mueve stock.
const STOCK_LOCKED_STATUSES = [...INACTIVE_STATUSES, 'completed'];

function assertEditable(project) {
  if (INACTIVE_STATUSES.includes(project.status)) {
    throw httpError(400, `El proyecto está ${project.status === 'closed' ? 'cerrado' : 'cancelado'}`);
  }
}

// Entregado a la obra: lo despachado desde el BOM o lo que ya está en la
// bodega del proyecto (un traslado hecho desde Traslados o una compra
// recibida allá también cuenta), lo que sea mayor.
const deliveredOf = (line, onSite = 0) => Math.max(num(line.qty_dispatched), num(onSite));
// Pendiente de conseguir: lo que falta después de lo entregado, reservado y pedido.
const shortageOf = (line, onSite = 0) => Math.max(round4(num(line.qty_required) - deliveredOf(line, onSite) - num(line.qty_reserved) - num(line.qty_ordered)), 0);
// Lo que todavía se puede reservar (no se reserva más de lo que falta por entregar).
const reservableOf = (line, onSite = 0) => Math.max(round4(num(line.qty_required) - deliveredOf(line, onSite) - num(line.qty_reserved)), 0);

// Saldo de la bodega de la obra repartido entre las líneas del mismo
// producto, en orden y sin pasar de lo requerido. Map línea → cantidad.
function allocateOnSite(lines, balanceByProduct) {
  const left = new Map(balanceByProduct);
  const result = new Map();
  for (const l of lines) {
    let qty = 0;
    if (l.product_id && left.has(l.product_id)) {
      qty = Math.min(Math.max(left.get(l.product_id), 0), num(l.qty_required));
      left.set(l.product_id, left.get(l.product_id) - qty);
    }
    result.set(l.id, round4(qty));
  }
  return result;
}

async function onSiteForProject(tenantId, project, transaction) {
  const balance = await getWarehouseBalance(tenantId, project.warehouse_id, { transaction });
  const lines = await ProjectBomItem.findAll({
    where: { project_id: project.id }, attributes: ['id', 'product_id', 'qty_required'], order: [['line_no', 'ASC']], transaction,
  });
  return allocateOnSite(lines, new Map(balance.map((b) => [b.product_id, b.quantity])));
}

// ── Emparejamiento con el catálogo ───────────────────────────────────────
// Código (SKU, código de barras o código de proveedor) → nombre exacto →
// nombre parecido (trigram). Lo parecido nunca se da por bueno solo: queda
// 'ambiguous' con la sugerencia para que el usuario la confirme.
async function matchRows(tenantId, rows, { transaction } = {}) {
  const codes = [...new Set(rows.map((r) => String(r.input_code || '').trim().toUpperCase()).filter(Boolean))];
  const byCode = new Map(); // CODE → Set(product_id)
  const addCode = (code, id) => {
    const key = String(code || '').trim().toUpperCase();
    if (!key) return;
    if (!byCode.has(key)) byCode.set(key, new Set());
    byCode.get(key).add(id);
  };
  if (codes.length) {
    const [products, links] = await Promise.all([
      Product.findAll({
        where: {
          tenant_id: tenantId,
          is_active: true,
          [Op.or]: [
            sequelize.where(sequelize.fn('UPPER', sequelize.col('sku')), { [Op.in]: codes }),
            sequelize.where(sequelize.fn('UPPER', sequelize.col('barcode')), { [Op.in]: codes }),
          ],
        },
        attributes: ['id', 'sku', 'barcode'],
        transaction,
      }),
      ProductSupplier.findAll({
        where: { tenant_id: tenantId, [Op.and]: [sequelize.where(sequelize.fn('UPPER', sequelize.col('supplier_code')), { [Op.in]: codes })] },
        attributes: ['product_id', 'supplier_code'],
        transaction,
      }),
    ]);
    // SKU primero: si un código es SKU de un producto y código de barras de
    // otro, gana el SKU.
    const skuHits = new Map();
    for (const p of products) {
      const sku = String(p.sku || '').toUpperCase();
      if (codes.includes(sku)) skuHits.set(sku, p.id);
    }
    for (const [code, id] of skuHits) addCode(code, id);
    for (const p of products) {
      const bc = String(p.barcode || '').toUpperCase();
      if (bc && !skuHits.has(bc)) addCode(bc, p.id);
    }
    for (const l of links) if (!skuHits.has(String(l.supplier_code).toUpperCase())) addCode(l.supplier_code, l.product_id);
  }

  // Descripciones de las filas que el código no resolvió.
  const pending = rows
    .map((r, idx) => ({ idx, q: String(r.input_description || r.input_code || '').trim() }))
    .filter(({ idx, q }) => {
      const code = String(rows[idx].input_code || '').trim().toUpperCase();
      return q && !(code && byCode.get(code)?.size === 1);
    });

  const candidatesByIdx = new Map();
  if (pending.length) {
    const values = pending.map(({ idx, q }) => `(${idx}, ${sequelize.escape(q.slice(0, 255))})`).join(', ');
    // LATERAL + LIMIT: cada descripción usa el índice trigram de
    // products.name por separado (ver migración 2026102903). word_similarity
    // cubre el caso típico: el nombre del catálogo es más corto que la
    // descripción del Excel ("Panel 550W" dentro de "Panel solar mono 550W").
    const found = await sequelize.query(`
      SELECT v.idx, p.id, p.sku, p.name, p.score
        FROM (VALUES ${values}) AS v(idx, q)
        CROSS JOIN LATERAL (
          SELECT pp.id, pp.sku, pp.name,
                 GREATEST(public.similarity(pp.name, v.q), public.word_similarity(pp.name, v.q), public.word_similarity(v.q, pp.name)) AS score
            FROM ${table('products')} pp
           WHERE pp.tenant_id = :tenantId AND pp.is_active = true
             AND (pp.name OPERATOR(public.%) v.q OR pp.name OPERATOR(public.<%) v.q OR pp.name OPERATOR(public.%>) v.q
                  OR lower(pp.name) = lower(v.q))
           ORDER BY score DESC, pp.current_stock DESC NULLS LAST, pp.name
           LIMIT 3
        ) p
    `, { replacements: { tenantId }, type: sequelize.QueryTypes.SELECT, transaction });
    for (const r of found) {
      if (!candidatesByIdx.has(r.idx)) candidatesByIdx.set(r.idx, []);
      candidatesByIdx.get(r.idx).push({ id: r.id, sku: r.sku, name: r.name, score: Math.round(num(r.score) * 100) / 100 });
    }
  }

  return rows.map((row, idx) => {
    const code = String(row.input_code || '').trim().toUpperCase();
    const codeHits = code ? [...(byCode.get(code) || [])] : [];
    if (codeHits.length === 1) return { ...row, product_id: codeHits[0], match_status: 'matched', match_by: 'code', candidates: [] };
    const candidates = candidatesByIdx.get(idx) || [];
    const desc = normalize(row.input_description || row.input_code);
    const exact = candidates.filter((c) => normalize(c.name) === desc);
    if (exact.length === 1) return { ...row, product_id: exact[0].id, match_status: 'matched', match_by: 'name', candidates: [] };
    if (codeHits.length > 1) {
      // Mismo código en varios productos (barras/proveedor): que elija el usuario.
      const extra = codeHits.filter((id) => !candidates.some((c) => c.id === id)).map((id) => ({ id }));
      return { ...row, product_id: null, match_status: 'ambiguous', match_by: 'code', candidates: [...candidates, ...extra] };
    }
    if (candidates.length) return { ...row, product_id: null, match_status: 'ambiguous', match_by: 'name', suggested_product_id: candidates[0].id, candidates };
    return { ...row, product_id: null, match_status: 'unmatched', match_by: null, candidates: [] };
  });
}

// Proveedor sugerido: el último al que se le compró (product_suppliers).
async function suggestedSuppliers(tenantId, productIds, { transaction } = {}) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const links = await ProductSupplier.findAll({
    where: { tenant_id: tenantId, product_id: ids },
    attributes: ['product_id', 'supplier_id', 'last_price', 'last_purchase_date'],
    order: [['last_purchase_date', 'DESC NULLS LAST'], ['last_price', 'DESC NULLS LAST']],
    transaction,
  });
  const supplierIds = [...new Set(links.map((l) => l.supplier_id))];
  const suppliers = new Map(supplierIds.length
    ? (await Supplier.findAll({ where: { id: supplierIds, tenant_id: tenantId, is_active: true }, attributes: ['id', 'name', 'business_name'], transaction }))
      .map((s) => [s.id, s])
    : []);
  const map = new Map();
  for (const l of links) {
    const supplier = suppliers.get(l.supplier_id);
    if (map.has(l.product_id) || !supplier) continue;
    map.set(l.product_id, { id: supplier.id, name: supplier.business_name || supplier.name, last_price: num(l.last_price) || null });
  }
  return map;
}

// Datos de stock para mostrar junto a cada línea.
async function stockContext(tenantId, project, productIds, { transaction } = {}) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return { products: new Map(), inProcess: {}, suppliers: new Map(), onSite: new Map() };
  const [products, inProcess, suppliers, balance] = await Promise.all([
    Product.findAll({ where: { id: ids, tenant_id: tenantId }, attributes: PRODUCT_ATTRS, transaction }),
    getInProcessMap(tenantId, ids, { excludeProjectId: project.id, transaction }),
    suggestedSuppliers(tenantId, ids, { transaction }),
    getWarehouseBalance(tenantId, project.warehouse_id, { transaction }),
  ]);
  return {
    products: new Map(products.map((p) => [p.id, p])),
    inProcess,
    suppliers,
    onSite: new Map(balance.map((b) => [b.product_id, b.quantity])),
  };
}

function productSummary(product, ctx) {
  if (!product) return null;
  const current = num(product.current_stock);
  const otherCommitted = ctx.inProcess[product.id]?.total || 0;
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    unit_of_measure: product.unit_of_measure,
    track_inventory: product.track_inventory !== false && product.product_type !== 'service',
    current_stock: current,
    committed_elsewhere: round4(otherCommitted),
    available: round4(current - otherCommitted),
    average_cost: num(product.average_cost),
    last_purchase_cost: num(product.last_purchase_cost),
  };
}

/**
 * Parsea lo pegado y lo empareja con el catálogo, sin guardar.
 */
async function previewBom(tenantId, project, text) {
  const { rows, errors, header } = parseBomText(text);
  const matched = await matchRows(tenantId, rows);
  const productIds = matched.flatMap((r) => [r.product_id, r.suggested_product_id, ...(r.candidates || []).map((c) => c.id)]);
  const ctx = await stockContext(tenantId, project, productIds);

  // Candidatos solo con id (código repetido): completar nombre/sku.
  const enriched = matched.map((r) => {
    const product = ctx.products.get(r.product_id) || null;
    return {
      ...r,
      product: productSummary(product, ctx),
      candidates: (r.candidates || []).map((c) => {
        const p = ctx.products.get(c.id);
        return { ...c, sku: c.sku ?? p?.sku, name: c.name ?? p?.name, available: p ? productSummary(p, ctx).available : null };
      }),
      supplier: r.product_id ? ctx.suppliers.get(r.product_id) || null : null,
    };
  });
  return {
    header,
    rows: enriched,
    errors,
    summary: {
      lines: enriched.length,
      matched: enriched.filter((r) => r.match_status === 'matched').length,
      ambiguous: enriched.filter((r) => r.match_status === 'ambiguous').length,
      unmatched: enriched.filter((r) => r.match_status === 'unmatched').length,
      errors: errors.length,
    },
  };
}

/**
 * Guarda las líneas revisadas por el usuario.
 *   mode 'replace': borra el BOM anterior (solo si nada se despachó ni pidió)
 *   mode 'append' : agrega al final
 * update_budget: reemplaza la línea de presupuesto "Materiales (BOM)".
 */
async function saveBom(tenantId, project, { rows, mode = 'replace', update_budget = true }, userId) {
  assertEditable(project);
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, 'No hay líneas para guardar');
  if (!['replace', 'append'].includes(mode)) throw httpError(400, 'Modo inválido');

  return sequelize.transaction(async (t) => {
    await Project.findByPk(project.id, { transaction: t, lock: t.LOCK.UPDATE });
    const existing = await ProjectBomItem.findAll({ where: { project_id: project.id }, transaction: t });
    if (mode === 'replace' && existing.some((l) => num(l.qty_dispatched) > 0 || num(l.qty_ordered) > 0)) {
      throw httpError(409, 'El BOM actual ya tiene despachos o pedidos: agrega las líneas nuevas en vez de reemplazarlo, o edita las líneas una por una.');
    }

    const productIds = [...new Set(rows.map((r) => r.product_id).filter(Boolean))];
    const products = productIds.length
      ? await Product.findAll({ where: { id: productIds, tenant_id: tenantId }, attributes: PRODUCT_ATTRS, transaction: t })
      : [];
    const productById = new Map(products.map((p) => [p.id, p]));

    const toCreate = [];
    let lineNo = mode === 'append' ? Math.max(0, ...existing.map((l) => l.line_no)) : 0;
    for (const [i, r] of rows.entries()) {
      const qty = round4(num(r.quantity ?? r.qty_required));
      if (!(qty > 0)) throw httpError(400, `Línea ${i + 1}: la cantidad debe ser mayor que cero`);
      const product = r.product_id ? productById.get(r.product_id) : null;
      if (r.product_id && !product) throw httpError(400, `Línea ${i + 1}: producto no encontrado`);
      const code = String(r.input_code || '').trim().slice(0, 100) || null;
      const description = String(r.input_description || '').trim().slice(0, 255) || null;
      if (!product && !code && !description) throw httpError(400, `Línea ${i + 1}: sin producto, código ni descripción`);
      const unitCost = r.unit_cost === null || r.unit_cost === undefined || r.unit_cost === '' ? null : round2(r.unit_cost);
      toCreate.push({
        tenant_id: tenantId,
        project_id: project.id,
        line_no: ++lineNo,
        input_code: code,
        input_description: description,
        unit: String(r.unit || '').trim().slice(0, 30) || null,
        product_id: product?.id || null,
        match_status: !product ? (r.match_status === 'ambiguous' ? 'ambiguous' : 'unmatched')
          : (['matched', 'manual'].includes(r.match_status) ? r.match_status : 'manual'),
        qty_required: qty,
        budget_unit_cost: unitCost,
        created_by: userId,
      });
    }

    if (mode === 'replace') await ProjectBomItem.destroy({ where: { project_id: project.id }, transaction: t });
    await ProjectBomItem.bulkCreate(toCreate, { transaction: t, validate: true });

    if (update_budget) await syncBomBudget(tenantId, project, userId, t);
    return { created: toCreate.length };
  });
}

// Una sola línea de presupuesto de materiales con el costo estimado del BOM:
// costo del Excel si vino; si no, costo promedio (o último costo) del producto.
async function syncBomBudget(tenantId, project, userId, transaction) {
  const lines = await ProjectBomItem.findAll({
    where: { project_id: project.id },
    include: [{ model: Product, as: 'product', attributes: ['id', 'average_cost', 'last_purchase_cost'] }],
    transaction,
  });
  const total = round2(lines.reduce((sum, l) => {
    const unit = l.budget_unit_cost !== null ? num(l.budget_unit_cost) : (num(l.product?.average_cost) || num(l.product?.last_purchase_cost));
    return sum + num(l.qty_required) * unit;
  }, 0));
  await ProjectBudgetLine.destroy({ where: { project_id: project.id, source: 'bom' }, transaction });
  if (total > 0) {
    await ProjectBudgetLine.create({
      tenant_id: tenantId, project_id: project.id, category: 'materials',
      description: `Materiales según lista de materiales (${lines.length} líneas)`,
      budget_amount: total, source: 'bom', created_by: userId,
    }, { transaction });
  }
  return total;
}

/**
 * BOM con stock actual, lo que hay en la obra y el proveedor sugerido.
 */
async function getBom(tenantId, project) {
  const lines = await ProjectBomItem.findAll({ where: { project_id: project.id }, order: [['line_no', 'ASC']] });
  const ctx = await stockContext(tenantId, project, lines.map((l) => l.product_id));
  const onSiteByLine = allocateOnSite(lines, ctx.onSite);
  const data = lines.map((l) => {
    const json = l.toJSON();
    const product = ctx.products.get(l.product_id);
    const onSite = onSiteByLine.get(l.id) || 0;
    return {
      ...json,
      qty_required: num(l.qty_required),
      qty_reserved: num(l.qty_reserved),
      qty_dispatched: num(l.qty_dispatched),
      qty_ordered: num(l.qty_ordered),
      qty_shortage: shortageOf(l, onSite),
      qty_on_site: round4(onSite),
      qty_delivered: round4(deliveredOf(l, onSite)),
      budget_unit_cost: l.budget_unit_cost === null ? null : num(l.budget_unit_cost),
      product: productSummary(product, ctx),
      supplier: l.product_id ? ctx.suppliers.get(l.product_id) || null : null,
    };
  });
  const sum = (k) => round4(data.reduce((s, l) => s + num(l[k]), 0));
  return {
    lines: data,
    summary: {
      lines: data.length,
      unmatched: data.filter((l) => !l.product_id).length,
      qty_required: sum('qty_required'),
      qty_reserved: sum('qty_reserved'),
      qty_dispatched: sum('qty_dispatched'),
      qty_delivered: sum('qty_delivered'),
      qty_ordered: sum('qty_ordered'),
      qty_shortage: sum('qty_shortage'),
      lines_complete: data.filter((l) => l.product_id && l.qty_shortage === 0).length,
    },
  };
}

async function loadLine(project, itemId, transaction) {
  const line = await ProjectBomItem.findOne({ where: { id: itemId, project_id: project.id }, transaction, lock: transaction?.LOCK.UPDATE });
  if (!line) throw httpError(404, 'Línea del BOM no encontrada');
  return line;
}

async function updateBomItem(tenantId, project, itemId, body) {
  assertEditable(project);
  return sequelize.transaction(async (t) => {
    const line = await loadLine(project, itemId, t);
    const updates = {};
    if (body.product_id !== undefined && body.product_id !== line.product_id) {
      if (num(line.qty_dispatched) > 0 || num(line.qty_ordered) > 0 || num(line.qty_reserved) > 0) {
        throw httpError(409, 'La línea ya tiene reservas, pedidos o despachos: no se le puede cambiar el producto');
      }
      if (body.product_id) {
        const product = await Product.findOne({ where: { id: body.product_id, tenant_id: tenantId }, attributes: ['id'], transaction: t });
        if (!product) throw httpError(400, 'Producto no encontrado');
      }
      updates.product_id = body.product_id || null;
      updates.match_status = body.product_id ? 'manual' : 'unmatched';
    }
    if (body.qty_required !== undefined) {
      const qty = round4(num(body.qty_required));
      if (!(qty > 0)) throw httpError(400, 'La cantidad debe ser mayor que cero');
      if (qty < num(line.qty_dispatched)) throw httpError(400, `Ya se despacharon ${num(line.qty_dispatched)}: la cantidad no puede ser menor`);
      updates.qty_required = qty;
      // Lo reservado nunca supera lo que falta por despachar.
      updates.qty_reserved = Math.min(num(line.qty_reserved), round4(qty - num(line.qty_dispatched)));
    }
    if (body.budget_unit_cost !== undefined) {
      updates.budget_unit_cost = body.budget_unit_cost === null || body.budget_unit_cost === '' ? null : round2(body.budget_unit_cost);
    }
    if (body.notes !== undefined) updates.notes = String(body.notes || '').trim() || null;
    await line.update(updates, { transaction: t });
    return line;
  });
}

async function deleteBomItem(tenantId, project, itemId) {
  assertEditable(project);
  return sequelize.transaction(async (t) => {
    const line = await loadLine(project, itemId, t);
    if (num(line.qty_dispatched) > 0 || num(line.qty_ordered) > 0) {
      throw httpError(409, 'La línea ya tiene despachos o pedidos: no se puede eliminar');
    }
    await line.destroy({ transaction: t });
  });
}

/**
 * Reserva el disponible para las líneas (todas o item_ids). El disponible es
 * current_stock menos lo comprometido por otros documentos y proyectos; un
 * lock por tenant evita que dos proyectos aparten la misma unidad a la vez.
 */
async function reserveBom(tenantId, project, { item_ids } = {}) {
  assertEditable(project);
  if (STOCK_LOCKED_STATUSES.includes(project.status)) throw httpError(400, 'El proyecto ya terminó: no reserva stock');
  return sequelize.transaction(async (t) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `project_reserve:${tenantId}` }, transaction: t });
    const where = { project_id: project.id, product_id: { [Op.ne]: null } };
    if (Array.isArray(item_ids) && item_ids.length) where.id = item_ids;
    const lines = await ProjectBomItem.findAll({ where, order: [['line_no', 'ASC']], transaction: t, lock: t.LOCK.UPDATE });
    const ids = lines.map((l) => l.product_id);
    const [products, inProcess] = await Promise.all([
      Product.findAll({ where: { id: ids, tenant_id: tenantId }, attributes: PRODUCT_ATTRS, transaction: t }),
      getInProcessMap(tenantId, ids, { excludeProjectId: project.id, transaction: t }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));

    // Disponible por producto, descontando también lo que este mismo
    // proyecto ya tiene reservado en otras líneas (las no incluidas).
    const ownOther = await ProjectBomItem.findAll({
      where: { project_id: project.id, product_id: ids, id: { [Op.notIn]: lines.map((l) => l.id) } },
      attributes: ['product_id', 'qty_reserved'],
      transaction: t,
    });
    const available = new Map();
    for (const p of products) available.set(p.id, num(p.current_stock) - (inProcess[p.id]?.total || 0));
    for (const o of ownOther) available.set(o.product_id, (available.get(o.product_id) || 0) - num(o.qty_reserved));
    // Lo que ya está reservado en las líneas incluidas también ocupa disponible.
    for (const l of lines) available.set(l.product_id, (available.get(l.product_id) || 0) - num(l.qty_reserved));

    const onSite = await onSiteForProject(tenantId, project, t);
    const result = { reserved_lines: 0, reserved_qty: 0, short_lines: 0, skipped_service: 0, already_on_site: 0 };
    for (const line of lines) {
      const product = productById.get(line.product_id);
      if (!product) continue;
      if (product.track_inventory === false || product.product_type === 'service') { result.skipped_service++; continue; }
      // Lo que llegó a la obra por otro camino (traslado manual, compra
      // recibida allá) ya no necesita reserva: se suelta lo que sobre.
      const lineOnSite = onSite.get(line.id) || 0;
      const maxReserved = Math.max(round4(num(line.qty_required) - deliveredOf(line, lineOnSite)), 0);
      if (num(line.qty_reserved) > maxReserved) {
        available.set(line.product_id, round4((available.get(line.product_id) || 0) + num(line.qty_reserved) - maxReserved));
        await line.update({ qty_reserved: maxReserved }, { transaction: t });
      }
      if (lineOnSite > num(line.qty_dispatched)) result.already_on_site++;
      const want = reservableOf(line, lineOnSite);
      if (want <= 0) continue;
      const can = Math.max(Math.min(want, round4(available.get(line.product_id) || 0)), 0);
      if (can > 0) {
        await line.update({ qty_reserved: round4(num(line.qty_reserved) + can) }, { transaction: t });
        available.set(line.product_id, round4((available.get(line.product_id) || 0) - can));
        result.reserved_lines++;
        result.reserved_qty = round4(result.reserved_qty + can);
      }
      if (can < want) result.short_lines++;
    }
    return result;
  });
}

async function releaseBom(tenantId, project, { item_ids } = {}) {
  const where = { project_id: project.id, qty_reserved: { [Op.gt]: 0 } };
  if (Array.isArray(item_ids) && item_ids.length) where.id = item_ids;
  const [count] = await ProjectBomItem.update({ qty_reserved: 0 }, { where });
  return { released_lines: count };
}

/**
 * Anota los faltantes en pedidos a proveedor del proyecto (uno abierto por
 * proveedor y proyecto, ver orderLists.controller.js#findOrCreateOpenList).
 * supplier_overrides: { [item_id]: supplier_id } para elegir otro proveedor.
 */
async function createOrderLists(tenantId, project, { item_ids, supplier_overrides = {} } = {}, userId) {
  assertEditable(project);
  const { findOrCreateOpenList } = require('../../controllers/inventory/orderLists.controller');
  return sequelize.transaction(async (t) => {
    const where = { project_id: project.id, product_id: { [Op.ne]: null } };
    if (Array.isArray(item_ids) && item_ids.length) where.id = item_ids;
    const onSite = await onSiteForProject(tenantId, project, t);
    const lines = (await ProjectBomItem.findAll({ where, order: [['line_no', 'ASC']], transaction: t, lock: t.LOCK.UPDATE }))
      .filter((l) => shortageOf(l, onSite.get(l.id)) > 0);
    if (!lines.length) return { lists: [], without_supplier: [], lines: 0 };

    const suggested = await suggestedSuppliers(tenantId, lines.map((l) => l.product_id), { transaction: t });
    const overrideIds = [...new Set(Object.values(supplier_overrides || {}).filter(Boolean))];
    const validOverrides = new Set(overrideIds.length
      ? (await Supplier.findAll({ where: { id: overrideIds, tenant_id: tenantId }, attributes: ['id'], transaction: t })).map((s) => s.id)
      : []);

    const bySupplier = new Map();
    const withoutSupplier = [];
    for (const line of lines) {
      const override = supplier_overrides?.[line.id];
      const supplierId = override && validOverrides.has(override) ? override : suggested.get(line.product_id)?.id;
      if (!supplierId) { withoutSupplier.push({ id: line.id, line_no: line.line_no, product_id: line.product_id }); continue; }
      if (!bySupplier.has(supplierId)) bySupplier.set(supplierId, []);
      bySupplier.get(supplierId).push(line);
    }

    const lists = [];
    const notes = `Proyecto ${project.code} - ${project.name}`.slice(0, 500);
    for (const [supplierId, supplierLines] of bySupplier) {
      const list = await findOrCreateOpenList(tenantId, supplierId, userId, t, { project_id: project.id, notes });
      let added = 0;
      for (const line of supplierLines) {
        const qty = round2(shortageOf(line, onSite.get(line.id)));
        if (qty <= 0) continue;
        const item = await SupplierOrderListItem.findOne({ where: { list_id: list.id, product_id: line.product_id }, transaction: t, lock: t.LOCK.UPDATE });
        if (item) {
          await item.update({ quantity: round2(num(item.quantity) + qty) }, { transaction: t });
        } else {
          await SupplierOrderListItem.create({
            tenant_id: tenantId, list_id: list.id, product_id: line.product_id, quantity: qty,
            notes: `${project.code} · línea ${line.line_no}`, source: 'product', added_by: userId,
          }, { transaction: t });
        }
        await line.update({ qty_ordered: round4(num(line.qty_ordered) + qty) }, { transaction: t });
        added++;
      }
      list.changed('updated_at', true);
      await list.save({ transaction: t });
      lists.push({ id: list.id, list_number: list.list_number, supplier_id: supplierId, lines: added });
    }
    return { lists, without_supplier: withoutSupplier, lines: lines.length - withoutSupplier.length };
  });
}

/**
 * Despacha a la bodega del proyecto: traslado ya enviado (en tránsito) desde
 * from_warehouse_id. items: [{ item_id, quantity }]; sin items, todo lo
 * reservado. Primero consume lo reservado de la línea; se puede despachar más
 * (hasta lo que falta por despachar) si hay stock.
 */
async function dispatchBom(req, project, { from_warehouse_id, items, notes, stage_id, signatures } = {}) {
  const tenantId = req.user.tenant_id;
  const stages = require('./projectStages.service');
  assertEditable(project);
  if (STOCK_LOCKED_STATUSES.includes(project.status)) throw httpError(400, 'El proyecto ya terminó: no recibe despachos');
  if (!project.warehouse_id) throw httpError(400, 'El proyecto no tiene bodega. Créala en la pestaña Resumen antes de despachar.');
  if (!from_warehouse_id) throw httpError(400, 'Elige la bodega de origen');
  if (from_warehouse_id === project.warehouse_id) throw httpError(400, 'La bodega de origen no puede ser la del proyecto');

  const { generateTransferNumber, assertBranchOwnsWarehouse } = require('../../controllers/inventory/transfers.controller');
  const { createMovementsBatch } = require('../../controllers/inventory/movements.controller');

  // Firmas de quienes reciben/entregan (dibujadas en pantalla): se validan antes de mover stock.
  const signaturesIn = stages.normalizeSignatures(signatures);

  const fromWarehouse = await Warehouse.findOne({ where: { id: from_warehouse_id, tenant_id: tenantId, is_active: true } });
  if (!fromWarehouse) throw httpError(404, 'Bodega de origen no encontrada');
  const authError = await assertBranchOwnsWarehouse(req, from_warehouse_id);
  if (authError) throw httpError(authError.status, authError.message);

  const result = await sequelize.transaction(async (t) => {
    const lockedProject = await Project.findByPk(project.id, { transaction: t, lock: t.LOCK.UPDATE });
    const where = { project_id: project.id, product_id: { [Op.ne]: null } };
    const requested = Array.isArray(items) && items.length ? new Map(items.map((i) => [i.item_id, round4(num(i.quantity))])) : null;
    // Despacho de una etapa: solo sus líneas y hasta su saldo (planeado − despachado).
    let stage = null;
    let stageSaldo = null;
    if (stage_id) {
      stage = await stages.loadOpenStage(tenantId, project, stage_id, t);
      stageSaldo = await stages.stageSaldoMap(tenantId, project, stage, t);
      if (requested) {
        for (const id of requested.keys()) {
          if (!stageSaldo.has(id)) throw httpError(400, `Hay líneas que no pertenecen a la etapa ${stage.stage_no} · ${stage.name}`);
        }
      }
      where.id = [...(requested ? requested.keys() : stageSaldo.keys())];
    } else if (requested) {
      where.id = [...requested.keys()];
    }
    const lines = await ProjectBomItem.findAll({ where, order: [['line_no', 'ASC']], transaction: t, lock: t.LOCK.UPDATE });

    const onSite = await onSiteForProject(tenantId, project, t);
    const plan = [];
    for (const line of lines) {
      const globalPending = round4(num(line.qty_required) - deliveredOf(line, onSite.get(line.id)));
      const stageLeft = stageSaldo ? num(stageSaldo.get(line.id)) : Infinity;
      const pendingDispatch = Math.min(globalPending, stageLeft);
      const qty = requested ? requested.get(line.id) : Math.min(num(line.qty_reserved), Math.max(pendingDispatch, 0));
      if (!(qty > 0)) continue;
      if (qty > pendingDispatch + 0.00005) {
        throw httpError(400, `Línea ${line.line_no}: se piden ${qty} pero solo faltan ${pendingDispatch} por despachar${stageLeft < globalPending ? ' en la etapa' : ''}`);
      }
      plan.push({ line, qty });
    }
    if (!plan.length) throw httpError(400, requested ? 'Indica cantidades a despachar' : 'No hay nada reservado para despachar. Reserva primero o indica cantidades.');

    const products = await Product.findAll({ where: { id: plan.map((p) => p.line.product_id), tenant_id: tenantId }, attributes: PRODUCT_ATTRS, transaction: t });
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const p of plan) {
      const product = productById.get(p.line.product_id);
      if (!product) throw httpError(400, `Línea ${p.line.line_no}: producto no encontrado`);
      if (product.track_inventory === false || product.product_type === 'service') {
        throw httpError(400, `Línea ${p.line.line_no}: "${product.name}" no maneja inventario, no se despacha`);
      }
    }

    const transfer_number = await generateTransferNumber(tenantId, t);
    const transfer = await Transfer.create({
      tenant_id: tenantId,
      transfer_number,
      from_warehouse_id,
      to_warehouse_id: project.warehouse_id,
      project_id: project.id,
      transfer_date: new Date(),
      notes: String(notes || '').trim() || `Despacho de materiales · proyecto ${project.code} - ${project.name}`.slice(0, 1000),
      status: 'sent',
      sent_date: new Date(),
      sent_by: req.user.id,
      created_by: req.user.id,
    }, { transaction: t });

    await TransferItem.bulkCreate(plan.map(({ line, qty }) => ({
      transfer_id: transfer.id,
      product_id: line.product_id,
      quantity_sent: qty,
      unit_cost: num(productById.get(line.product_id).average_cost),
      project_bom_item_id: line.id,
    })), { transaction: t });

    // Salida de la bodega origen (igual que sendTransfer); la entrada a la
    // obra la hace la recepción del traslado.
    await createMovementsBatch(plan.map(({ line, qty }) => ({
      tenant_id: tenantId,
      movement_type: 'salida',
      movement_reason: 'transfer_send',
      product_id: line.product_id,
      warehouse_id: from_warehouse_id,
      quantity: qty,
      unit_cost: num(productById.get(line.product_id).average_cost),
      reference_type: 'transfer',
      reference_id: transfer.id,
      user_id: req.user.id,
      notes: `Transferencia ${transfer_number} - Despacho a obra ${project.code}`,
    })), t);

    for (const { line, qty } of plan) {
      await line.update({
        qty_reserved: Math.max(round4(num(line.qty_reserved) - qty), 0),
        qty_dispatched: round4(num(line.qty_dispatched) + qty),
      }, { transaction: t });
    }

    // Primer despacho de un proyecto aprobado: arranca la ejecución.
    if (lockedProject.status === 'approved') {
      await lockedProject.update({ status: 'in_progress', start_date: lockedProject.start_date || new Date() }, { transaction: t });
    }

    // Acta de despacho (con o sin etapa) con las firmas que hayan llegado.
    const dispatch = await stages.createDispatchRecord({
      tenantId, project, stage, transfer, fromWarehouseId: from_warehouse_id,
      notes, userId: req.user.id, signatures: signaturesIn, transaction: t,
    });
    return {
      transfer_id: transfer.id, transfer_number, lines: plan.length,
      dispatch_id: dispatch.id, dispatch_no: dispatch.dispatch_no, stage_id: stage ? stage.id : null,
    };
  });
  return result;
}

module.exports = {
  previewBom,
  saveBom,
  getBom,
  updateBomItem,
  deleteBomItem,
  reserveBom,
  releaseBom,
  createOrderLists,
  dispatchBom,
  syncBomBudget,
  matchRows,
  shortageOf,
  reservableOf,
  deliveredOf,
  allocateOnSite,
};
