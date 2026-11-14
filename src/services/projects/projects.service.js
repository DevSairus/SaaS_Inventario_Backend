// backend/src/services/projects/projects.service.js
//
// Ciclo de vida del proyecto:
//   prospect → quoted → approved → in_progress ⇄ on_hold → completed → closed
//   (cancelled desde cualquier estado abierto)
// Cerrar o cancelar exige la bodega de la obra vacía y sin traslados en
// tránsito: lo que quedó hay que reintegrarlo (traslado a otra bodega) o
// registrarlo como consumo, para que el inventario no arrastre material que
// ya está instalado. Al cerrar se liberan las reservas y se inactiva la bodega.

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  Project, ProjectBudgetLine, ProjectBomItem, Customer, Sale, Warehouse, User, Branch, Product,
  Purchase, Expense, Transfer, SupplierOrderList, Supplier,
} = require('../../models');
const { getWarehouseBalance } = require('./projectStock.service');
const { initialProjectAiu, parseAiu, aiuColumns, aiuOf } = require('./projectAiu');
const { tenantAiuConfig } = require('../sales/aiu.service');

async function tenantTaxConfig(tenantId, transaction) {
  const { Tenant } = require('../../models');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'tax_config'], transaction });
  return tenant?.tax_config || {};
}

const httpError = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra || {});
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const blankToNull = (v) => (v === '' || v === undefined ? null : v);

const STATUS_LABELS = {
  prospect: 'Prospecto', quoted: 'Cotizado', approved: 'Aprobado', in_progress: 'En ejecución',
  on_hold: 'Suspendido', completed: 'Terminado', closed: 'Cerrado', cancelled: 'Cancelado',
};

const TRANSITIONS = {
  prospect: ['quoted', 'approved', 'cancelled'],
  quoted: ['prospect', 'approved', 'cancelled'],
  approved: ['in_progress', 'on_hold', 'cancelled'],
  in_progress: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  completed: ['in_progress', 'closed'],
  closed: [],
  cancelled: [],
};

const EDITABLE_FIELDS = [
  'name', 'customer_id', 'type', 'site_address', 'city', 'capacity_kwp', 'start_date',
  'end_date_planned', 'manager_id', 'contract_amount', 'notes', 'branch_id',
  'alert_warning_pct', 'alert_critical_pct', 'retention_pct',
];

const userAttrs = ['id', 'first_name', 'last_name', 'email'];
const customerAttrs = ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'email', 'phone', 'mobile', 'city'];

// Consecutivo PRY-0001 por tenant, serializado con un advisory lock.
async function nextProjectCode(tenantId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `projects:${tenantId}` }, transaction });
  const rows = await Project.findAll({
    where: { tenant_id: tenantId, code: { [Op.like]: 'PRY-%' } },
    attributes: ['code'],
    transaction,
  });
  const max = rows.reduce((m, r) => Math.max(m, parseInt(String(r.code).split('-')[1], 10) || 0), 0);
  return `PRY-${String(max + 1).padStart(4, '0')}`;
}

async function validateRefs(tenantId, data, transaction) {
  if (data.customer_id) {
    const c = await Customer.findOne({ where: { id: data.customer_id, tenant_id: tenantId }, attributes: ['id'], transaction });
    if (!c) throw httpError(400, 'Cliente no encontrado');
  }
  if (data.manager_id) {
    const u = await User.findOne({ where: { id: data.manager_id, tenant_id: tenantId }, attributes: ['id'], transaction });
    if (!u) throw httpError(400, 'Responsable no encontrado');
  }
  if (data.branch_id) {
    const b = await Branch.findOne({ where: { id: data.branch_id, tenant_id: tenantId }, attributes: ['id'], transaction });
    if (!b) throw httpError(400, 'Sede no encontrada');
  }
}

function pickFields(body) {
  const data = {};
  for (const k of EDITABLE_FIELDS) if (body[k] !== undefined) data[k] = blankToNull(body[k]);
  if (data.name !== undefined) {
    data.name = String(data.name || '').trim().slice(0, 200);
    if (!data.name) throw httpError(400, 'El nombre del proyecto es obligatorio');
  }
  if (data.type !== undefined && data.type !== null && !Project.TYPES.includes(data.type)) throw httpError(400, 'Tipo de proyecto inválido');
  if (data.type === null) data.type = 'otro';
  if (data.retention_pct !== undefined) {
    const n = data.retention_pct === null || data.retention_pct === '' ? 0 : Number(data.retention_pct);
    if (!Number.isFinite(n) || n < 0 || n > 30) throw httpError(400, 'La retención de garantía va de 0 % a 30 %');
    data.retention_pct = n;
  }
  for (const k of ['alert_warning_pct', 'alert_critical_pct']) {
    if (data[k] === null) delete data[k];
    else if (data[k] !== undefined) {
      const n = Number(data[k]);
      if (!Number.isFinite(n) || n <= 0 || n > 500) throw httpError(400, 'Los umbrales de alerta van de 1 % a 500 %');
      data[k] = n;
    }
  }
  if (data.alert_warning_pct !== undefined && data.alert_critical_pct !== undefined && data.alert_warning_pct > data.alert_critical_pct) {
    throw httpError(400, 'El umbral de aviso no puede ser mayor que el de sobrecosto');
  }
  for (const k of ['capacity_kwp', 'contract_amount']) {
    if (data[k] !== undefined && data[k] !== null) {
      const n = Number(data[k]);
      if (!Number.isFinite(n) || n < 0) throw httpError(400, `${k === 'contract_amount' ? 'Valor del contrato' : 'Capacidad'} inválido`);
      data[k] = n;
    }
  }
  return data;
}

async function createProjectWarehouse(project, { branchId, transaction }) {
  if (project.warehouse_id) return Warehouse.findByPk(project.warehouse_id, { transaction });
  const warehouse = await Warehouse.create({
    tenant_id: project.tenant_id,
    branch_id: project.branch_id || branchId || null,
    code: project.code,
    name: `${project.code} · ${project.name}`.slice(0, 100),
    city: project.city || null,
    address: project.site_address || null,
    is_main: false,
    is_default: false,
    is_active: true,
    project_id: project.id,
  }, { transaction });
  await project.update({ warehouse_id: warehouse.id }, { transaction });
  return warehouse;
}

/**
 * Crea un proyecto. Opcional: quote_id (cotización de la que nace; queda
 * enlazada y aporta cliente y valor del contrato) y create_warehouse.
 */
async function createProject(req, body) {
  const tenantId = req.user.tenant_id;
  const data = pickFields(body);
  if (!data.name) throw httpError(400, 'El nombre del proyecto es obligatorio');
  const status = body.status && Project.STATUSES.includes(body.status) && !['closed', 'cancelled', 'completed'].includes(body.status)
    ? body.status : 'prospect';

  return sequelize.transaction(async (t) => {
    let quote = null;
    if (body.quote_id) {
      quote = await Sale.findOne({ where: { id: body.quote_id, tenant_id: tenantId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!quote) throw httpError(400, 'Cotización no encontrada');
      if (quote.project_id) throw httpError(409, 'Esa cotización ya pertenece a otro proyecto');
      if (!data.customer_id && quote.customer_id) data.customer_id = quote.customer_id;
      if (data.contract_amount === undefined || data.contract_amount === null) {
        data.contract_amount = round2(num(quote.total_amount) - num(quote.tax_amount));
      }
    }
    await validateRefs(tenantId, data, t);
    // AIU del proyecto (1.6): el del formulario, o el de la cotización si es AIU.
    const aiu = initialProjectAiu(body, quote, await tenantTaxConfig(tenantId, t));

    const code = await nextProjectCode(tenantId, t);
    const project = await Project.create({
      ...data,
      ...aiuColumns(aiu),
      tenant_id: tenantId,
      branch_id: data.branch_id || req.branch_id || null,
      code,
      status: quote && status === 'prospect' ? 'quoted' : status,
      quote_id: quote?.id || null,
      created_by: req.user.id,
    }, { transaction: t });

    if (quote) await quote.update({ project_id: project.id }, { transaction: t });
    if (body.create_warehouse) await createProjectWarehouse(project, { branchId: req.branch_id, transaction: t });
    return project;
  });
}

async function updateProject(req, project, body) {
  if (['closed', 'cancelled'].includes(project.status)) throw httpError(400, 'El proyecto está cerrado o cancelado: no se puede editar');
  const data = pickFields(body);
  await validateRefs(req.user.tenant_id, data, null);
  // AIU del proyecto: valor por defecto de los cortes nuevos (los ya hechos guardan el suyo).
  const cfg = tenantAiuConfig(await tenantTaxConfig(req.user.tenant_id));
  const current = aiuOf(project);
  const aiu = parseAiu(body, { fallback: current || cfg, tenantEnabled: cfg.enabled, wasEnabled: Boolean(current) });
  if (aiu !== undefined) Object.assign(data, aiuColumns(aiu));
  await project.update(data);
  // La bodega sigue el nombre del proyecto.
  if (project.warehouse_id && (data.name || data.city !== undefined || data.site_address !== undefined)) {
    await Warehouse.update({
      name: `${project.code} · ${project.name}`.slice(0, 100),
      city: project.city || null,
      address: project.site_address || null,
    }, { where: { id: project.warehouse_id, project_id: project.id } }).catch(() => {});
  }
  return project;
}

// Bodega de la obra vacía y sin traslados en tránsito, o error con el detalle.
async function assertWarehouseClear(project) {
  if (!project.warehouse_id) return;
  const inTransit = await Transfer.count({
    where: {
      tenant_id: project.tenant_id,
      status: 'sent',
      [Op.or]: [{ to_warehouse_id: project.warehouse_id }, { from_warehouse_id: project.warehouse_id }],
    },
  });
  if (inTransit > 0) {
    throw httpError(409, `Hay ${inTransit} traslado(s) en tránsito con la bodega del proyecto: recíbelos o cancélalos primero.`, { code: 'TRANSFERS_IN_TRANSIT' });
  }
  const balance = (await getWarehouseBalance(project.tenant_id, project.warehouse_id)).filter((b) => b.quantity > 0.00005);
  if (balance.length) {
    const products = await Product.findAll({ where: { id: balance.map((b) => b.product_id) }, attributes: ['id', 'sku', 'name'] });
    const byId = new Map(products.map((p) => [p.id, p]));
    throw httpError(409, `La bodega del proyecto aún tiene ${balance.length} producto(s). Reintegra el sobrante con un traslado a otra bodega o regístralo como consumo interno antes de cerrar.`, {
      code: 'WAREHOUSE_NOT_EMPTY',
      data: balance.map((b) => ({ product_id: b.product_id, sku: byId.get(b.product_id)?.sku, name: byId.get(b.product_id)?.name, quantity: b.quantity })),
    });
  }
}

async function changeStatus(req, project, nextStatus) {
  const allowed = TRANSITIONS[project.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw httpError(400, `No se puede pasar de "${STATUS_LABELS[project.status]}" a "${STATUS_LABELS[nextStatus] || nextStatus}"`);
  }
  if (['closed', 'cancelled'].includes(nextStatus)) await assertWarehouseClear(project);

  return sequelize.transaction(async (t) => {
    const updates = { status: nextStatus };
    const today = new Date().toISOString().slice(0, 10);
    if (nextStatus === 'in_progress' && !project.start_date) updates.start_date = today;
    if (nextStatus === 'completed') updates.end_date_actual = project.end_date_actual || today;
    if (nextStatus === 'in_progress' && project.status === 'completed') updates.end_date_actual = null;
    if (['closed', 'cancelled'].includes(nextStatus)) {
      updates.closed_at = new Date();
      updates.closed_by = req.user.id;
      await ProjectBomItem.update({ qty_reserved: 0 }, { where: { project_id: project.id, qty_reserved: { [Op.gt]: 0 } }, transaction: t });
      if (project.warehouse_id) await Warehouse.update({ is_active: false }, { where: { id: project.warehouse_id, project_id: project.id }, transaction: t });
    }
    await project.update(updates, { transaction: t });
    return project;
  });
}

async function loadProject(tenantId, id, { transaction } = {}) {
  const project = await Project.findOne({ where: { id, tenant_id: tenantId }, transaction });
  if (!project) throw httpError(404, 'Proyecto no encontrado');
  return project;
}

async function getProjectDetail(tenantId, id) {
  const project = await Project.findOne({
    where: { id, tenant_id: tenantId },
    include: [
      { model: Customer, as: 'customer', attributes: customerAttrs },
      { model: Sale, as: 'quote', attributes: ['id', 'sale_number', 'quote_status', 'total_amount', 'tax_amount', 'sale_date'] },
      { model: Warehouse, as: 'warehouse', attributes: ['id', 'code', 'name', 'is_active', 'branch_id'] },
      { model: Branch, as: 'branch', attributes: ['id', 'name'] },
      { model: User, as: 'manager', attributes: userAttrs },
      { model: User, as: 'creator', attributes: userAttrs },
      { model: User, as: 'closer', attributes: userAttrs },
      { model: ProjectBudgetLine, as: 'budget_lines', include: [{ model: Product, as: 'product', attributes: ['id', 'sku', 'name'] }] },
    ],
    order: [[{ model: ProjectBudgetLine, as: 'budget_lines' }, 'created_at', 'ASC']],
  });
  if (!project) throw httpError(404, 'Proyecto no encontrado');
  const json = project.toJSON();
  json.allowed_transitions = TRANSITIONS[project.status] || [];
  return json;
}

// Documentos del proyecto (pestaña Documentos). Máx. 200 por tipo.
async function getProjectDocuments(tenantId, project) {
  const limit = 200;
  const transferWhere = { tenant_id: tenantId, [Op.or]: [{ project_id: project.id }] };
  if (project.warehouse_id) {
    transferWhere[Op.or].push({ to_warehouse_id: project.warehouse_id }, { from_warehouse_id: project.warehouse_id });
  }
  // Lazy: projectCuts.service no depende de este, pero así no hay ciclo si algún día lo hace.
  const { contractProgress } = require('./projectCuts.service');
  const salesWhere = project.quote_id
    ? { tenant_id: tenantId, [Op.or]: [{ project_id: project.id }, { id: project.quote_id }] }
    : { tenant_id: tenantId, project_id: project.id };
  const [sales, purchases, expenses, transfers, orderLists, contract] = await Promise.all([
    Sale.findAll({
      where: salesWhere,
      attributes: ['id', 'sale_number', 'document_type', 'status', 'quote_status', 'sale_date', 'total_amount', 'tax_amount', 'customer_name', 'payment_status', 'project_cut_id'],
      order: [['sale_date', 'DESC']], limit,
    }),
    Purchase.findAll({
      where: { tenant_id: tenantId, project_id: project.id },
      attributes: ['id', 'purchase_number', 'status', 'purchase_date', 'subtotal', 'total_amount', 'invoice_number', 'warehouse_id', 'supplier_name'],
      include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name'] }],
      order: [['purchase_date', 'DESC']], limit,
    }),
    Expense.findAll({
      where: { tenant_id: tenantId, project_id: project.id },
      attributes: ['id', 'expense_number', 'category', 'description', 'expense_date', 'subtotal', 'total_amount', 'payment_status'],
      order: [['expense_date', 'DESC']], limit,
    }),
    Transfer.findAll({
      where: transferWhere,
      attributes: ['id', 'transfer_number', 'status', 'transfer_date', 'from_warehouse_id', 'to_warehouse_id', 'project_id'],
      include: [
        { model: Warehouse, as: 'fromWarehouse', attributes: ['id', 'name'] },
        { model: Warehouse, as: 'toWarehouse', attributes: ['id', 'name'] },
      ],
      order: [['transfer_date', 'DESC']], limit,
    }),
    SupplierOrderList.findAll({
      where: { tenant_id: tenantId, project_id: project.id },
      attributes: ['id', 'list_number', 'status', 'created_at', 'purchase_id'],
      include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name'] }],
      order: [['created_at', 'DESC']], limit,
    }),
    contractProgress(tenantId, project),
  ]);
  return {
    sales,
    contract,
    purchases,
    expenses,
    transfers: transfers.map((tr) => ({
      ...tr.toJSON(),
      direction: tr.to_warehouse_id === project.warehouse_id ? 'to_project' : (tr.from_warehouse_id === project.warehouse_id ? 'from_project' : 'other'),
    })),
    order_lists: orderLists,
  };
}

// ── Presupuesto ──────────────────────────────────────────────────────────
function budgetPayload(body) {
  const category = body.category;
  if (!ProjectBudgetLine.CATEGORIES.includes(category)) throw httpError(400, 'Categoría de presupuesto inválida');
  const description = String(body.description || '').trim().slice(0, 255);
  if (!description) throw httpError(400, 'La descripción es obligatoria');
  const quantity = body.quantity === '' || body.quantity === null || body.quantity === undefined ? null : Number(body.quantity);
  const unitCost = body.unit_cost === '' || body.unit_cost === null || body.unit_cost === undefined ? null : Number(body.unit_cost);
  let amount = body.budget_amount === '' || body.budget_amount === undefined || body.budget_amount === null ? null : Number(body.budget_amount);
  if (amount === null && quantity !== null && unitCost !== null) amount = round2(quantity * unitCost);
  if (amount === null || !Number.isFinite(amount) || amount < 0) throw httpError(400, 'Indica el valor presupuestado (o cantidad y costo unitario)');
  if ((quantity !== null && (!Number.isFinite(quantity) || quantity < 0)) || (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0))) {
    throw httpError(400, 'Cantidad o costo inválidos');
  }
  return { category, description, quantity, unit_cost: unitCost, budget_amount: round2(amount), product_id: body.product_id || null };
}

async function addBudgetLine(req, project, body) {
  if (['closed', 'cancelled'].includes(project.status)) throw httpError(400, 'El proyecto está cerrado o cancelado');
  return ProjectBudgetLine.create({ ...budgetPayload(body), tenant_id: req.user.tenant_id, project_id: project.id, source: 'manual', created_by: req.user.id });
}

async function updateBudgetLine(project, lineId, body) {
  if (['closed', 'cancelled'].includes(project.status)) throw httpError(400, 'El proyecto está cerrado o cancelado');
  const line = await ProjectBudgetLine.findOne({ where: { id: lineId, project_id: project.id } });
  if (!line) throw httpError(404, 'Línea de presupuesto no encontrada');
  await line.update({ ...budgetPayload({ ...line.toJSON(), ...body }), source: line.source === 'bom' ? 'manual' : line.source });
  return line;
}

async function deleteBudgetLine(project, lineId) {
  if (['closed', 'cancelled'].includes(project.status)) throw httpError(400, 'El proyecto está cerrado o cancelado');
  const deleted = await ProjectBudgetLine.destroy({ where: { id: lineId, project_id: project.id } });
  if (!deleted) throw httpError(404, 'Línea de presupuesto no encontrada');
}

// ── Reintegro de sobrantes ───────────────────────────────────────────────
// Lo que queda en la bodega de la obra (kárdex), con nombre y costo.
async function getSiteStock(tenantId, project) {
  const balance = (await getWarehouseBalance(tenantId, project.warehouse_id)).filter((b) => b.quantity > 0.00005);
  if (!balance.length) return [];
  const products = await Product.findAll({
    where: { id: balance.map((b) => b.product_id), tenant_id: tenantId },
    attributes: ['id', 'sku', 'name', 'unit_of_measure', 'average_cost'],
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  return balance
    .map((b) => {
      const p = byId.get(b.product_id);
      return { product_id: b.product_id, sku: p?.sku, name: p?.name, unit_of_measure: p?.unit_of_measure, quantity: b.quantity, value: round2(b.value), average_cost: num(p?.average_cost) };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Traslado de la bodega de la obra a otra bodega con lo que sobró.
 * items: [{ product_id, quantity }]; sin items, todo el saldo. Con
 * receive_now el traslado queda recibido de una vez (el material ya llegó);
 * si no, en tránsito y se recibe desde Traslados. En el estado de resultados
 * descuenta el costo de materiales del proyecto (MATERIAL_OUT_REASONS).
 */
async function returnSurplus(req, project, { to_warehouse_id, items, receive_now = false, notes } = {}) {
  const tenantId = req.user.tenant_id;
  if (!project.warehouse_id) throw httpError(400, 'El proyecto no tiene bodega');
  if (project.status === 'closed' || project.status === 'cancelled') throw httpError(400, 'El proyecto ya está cerrado o cancelado');
  if (!to_warehouse_id || to_warehouse_id === project.warehouse_id) throw httpError(400, 'Elige la bodega a la que vuelve el material');

  const { generateTransferNumber, assertBranchOwnsWarehouse } = require('../../controllers/inventory/transfers.controller');
  const { createMovementsBatch } = require('../../controllers/inventory/movements.controller');
  const { TransferItem } = require('../../models');

  const toWarehouse = await Warehouse.findOne({ where: { id: to_warehouse_id, tenant_id: tenantId, is_active: true } });
  if (!toWarehouse) throw httpError(404, 'Bodega de destino no encontrada');
  for (const whId of receive_now ? [project.warehouse_id, to_warehouse_id] : [project.warehouse_id]) {
    const authError = await assertBranchOwnsWarehouse(req, whId);
    if (authError) throw httpError(authError.status, authError.message);
  }

  return sequelize.transaction(async (t) => {
    const siteRows = await getWarehouseBalance(tenantId, project.warehouse_id, { transaction: t });
    const balance = new Map(siteRows.map((b) => [b.product_id, b.quantity]));
    // Costo al que el material está en la obra (valor ÷ cantidad del kárdex de
    // esa bodega): el reintegro descuenta lo mismo que costó entregarlo, aunque
    // el costo promedio del producto haya cambiado después.
    const siteCost = new Map(siteRows.filter((b) => b.quantity > 0).map((b) => [b.product_id, Math.round((b.value / b.quantity) * 100) / 100]));
    const requested = Array.isArray(items) && items.length
      ? items.map((i) => ({ product_id: i.product_id, quantity: Math.round(num(i.quantity) * 10000) / 10000 })).filter((i) => i.quantity > 0)
      : [...balance].filter(([, q]) => q > 0.00005).map(([product_id, quantity]) => ({ product_id, quantity }));
    if (!requested.length) throw httpError(400, 'No hay material para reintegrar');

    const products = new Map((await Product.findAll({
      where: { id: requested.map((r) => r.product_id), tenant_id: tenantId },
      attributes: ['id', 'name', 'average_cost'],
      transaction: t,
    })).map((p) => [p.id, p]));
    for (const r of requested) {
      const p = products.get(r.product_id);
      if (!p) throw httpError(400, 'Producto no encontrado');
      const onSite = balance.get(r.product_id) || 0;
      if (r.quantity > onSite + 0.00005) throw httpError(400, `${p.name}: en la obra hay ${onSite}, no se pueden reintegrar ${r.quantity}`);
    }

    const transfer_number = await generateTransferNumber(tenantId, t);
    const now = new Date();
    const transfer = await Transfer.create({
      tenant_id: tenantId,
      transfer_number,
      from_warehouse_id: project.warehouse_id,
      to_warehouse_id,
      project_id: project.id,
      transfer_date: now,
      notes: String(notes || '').trim() || `Reintegro de sobrante · proyecto ${project.code} - ${project.name}`.slice(0, 1000),
      status: receive_now ? 'received' : 'sent',
      sent_date: now,
      sent_by: req.user.id,
      ...(receive_now ? { received_date: now, received_by: req.user.id } : {}),
      created_by: req.user.id,
    }, { transaction: t });

    const costOf = (id) => (siteCost.has(id) ? siteCost.get(id) : num(products.get(id).average_cost));
    await TransferItem.bulkCreate(requested.map((r) => ({
      transfer_id: transfer.id,
      product_id: r.product_id,
      quantity_sent: r.quantity,
      quantity_received: receive_now ? r.quantity : null,
      unit_cost: costOf(r.product_id),
    })), { transaction: t });

    const base = (r) => ({
      tenant_id: tenantId, product_id: r.product_id, quantity: r.quantity, unit_cost: costOf(r.product_id),
      reference_type: 'transfer', reference_id: transfer.id, user_id: req.user.id,
    });
    await createMovementsBatch([
      ...requested.map((r) => ({ ...base(r), movement_type: 'salida', movement_reason: 'transfer_send', warehouse_id: project.warehouse_id, notes: `Transferencia ${transfer_number} - Reintegro desde obra ${project.code}` })),
      ...(receive_now ? requested.map((r) => ({ ...base(r), movement_type: 'entrada', movement_reason: 'transfer_receive', warehouse_id: to_warehouse_id, notes: `Transferencia ${transfer_number} - Reintegro recibido de obra ${project.code}` })) : []),
    ], t);

    return { transfer_id: transfer.id, transfer_number, lines: requested.length, status: transfer.status };
  });
}

module.exports = {
  getSiteStock,
  returnSurplus,
  STATUS_LABELS,
  TRANSITIONS,
  createProject,
  updateProject,
  changeStatus,
  createProjectWarehouse,
  loadProject,
  getProjectDetail,
  getProjectDocuments,
  addBudgetLine,
  updateBudgetLine,
  deleteBudgetLine,
  assertWarehouseClear,
  nextProjectCode,
};
