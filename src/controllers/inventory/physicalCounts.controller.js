// backend/src/controllers/inventory/physicalCounts.controller.js
//
// Inventario físico (conteo por Excel). Ver Punto 2 del análisis
// "Pitbox-Tecnicos-InventarioFisico-EnTramite-Analisis-y-Plan.md".
//
// El stock es un solo Product.current_stock global (no hay stock por bodega
// real) -- "conteo por bodega/categoría" es solo un filtro sobre
// Product.warehouse_id / category_id al generar la plantilla.
//
// Sesión persistida (physical_counts/physical_count_items) en vez de un Excel
// "sin estado": permite detectar movimientos ocurridos entre la descarga y la
// subida (conflictos) y evitar aplicar la misma sesión dos veces.

'use strict';

const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { sequelize } = require('../../config/database');
const { runWithTenantSchema } = require('../../config/tenantContext');
const {
  Product, Category, Warehouse, PhysicalCount, PhysicalCountItem,
  InventoryAdjustment
} = require('../../models/inventory');
const { createAdjustmentCore, confirmAdjustmentCore } = require('./adjustments.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const { cellToText, parseLocaleNumber } = require('../../utils/excelCell');

const MAX_REPORTED_ERRORS = 300;
const CONFLICT_EPSILON = 0.001; // tolerancia para comparar decimales de stock

const round2 = (n) => Math.round((parseFloat(n) + Number.EPSILON) * 100) / 100;

function httpError(statusCode, payload) {
  const err = new Error(payload.message);
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

// ── Número TF-YYYY-##### (mismo patrón que AJ-YYYY-##### de adjustments) ────
async function generateCountNumber(tenant_id, transaction) {
  const year = new Date().getFullYear();
  const last = await PhysicalCount.findOne({
    where: { tenant_id, count_number: { [Op.like]: `TF-${year}-%` } },
    order: [['count_number', 'DESC']],
    transaction
  });
  if (last) {
    const lastNumber = parseInt(last.count_number.split('-')[2]);
    return `TF-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
  }
  return `TF-${year}-00001`;
}

/**
 * POST /api/inventory/physical-counts
 * body: { warehouse_id?, category_id?, include_inactive? }
 * Crea la sesión y toma el snapshot de system_qty (current_stock) para cada
 * producto que aplica. No genera el Excel todavía (ver /template).
 */
const createPhysicalCount = async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
  if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

  const tenant_id = req.user.tenant_id;
  const user_id = req.user.id;
  const { warehouse_id = null, category_id = null } = req.body;
  const include_inactive = req.body.include_inactive === true || req.body.include_inactive === 'true';

  const t = await sequelize.transaction();
  try {
    if (warehouse_id) {
      const wh = await Warehouse.findOne({ where: { id: warehouse_id, tenant_id }, transaction: t });
      if (!wh) throw httpError(400, { success: false, message: 'La bodega indicada no existe' });
    }
    if (category_id) {
      const cat = await Category.findOne({ where: { id: category_id, tenant_id }, transaction: t });
      if (!cat) throw httpError(400, { success: false, message: 'La categoría indicada no existe' });
    }

    const where = {
      tenant_id,
      track_inventory: true,
      product_type: { [Op.ne]: 'service' }
    };
    if (!include_inactive) where.is_active = true;
    if (warehouse_id) where.warehouse_id = warehouse_id;
    if (category_id) where.category_id = category_id;

    const products = await Product.findAll({
      where,
      attributes: ['id', 'sku', 'name', 'current_stock', 'average_cost'],
      order: [['sku', 'ASC']],
      transaction: t
    });

    if (products.length === 0) {
      throw httpError(400, { success: false, message: 'No hay productos que cumplan estos filtros para generar el conteo' });
    }

    const count_number = await generateCountNumber(tenant_id, t);

    const physicalCount = await PhysicalCount.create({
      tenant_id,
      count_number,
      warehouse_id,
      category_id,
      include_inactive,
      status: 'open',
      generated_by: user_id,
      generated_at: new Date(),
      total_products: products.length
    }, { transaction: t });

    const itemsPayload = products.map((p) => ({
      count_id: physicalCount.id,
      tenant_id,
      product_id: p.id,
      product_sku: p.sku,
      product_name: p.name,
      system_qty: parseFloat(p.current_stock) || 0,
      unit_cost: parseFloat(p.average_cost) || 0,
      counted_qty: null,
      diff_qty: null,
      has_conflict: false,
      applied: false
    }));
    await PhysicalCountItem.bulkCreate(itemsPayload, { transaction: t });

    await t.commit();

    return res.status(201).json({
      success: true,
      message: 'Sesión de conteo físico creada',
      data: {
        id: physicalCount.id,
        count_number,
        status: 'open',
        warehouse_id,
        category_id,
        include_inactive,
        total_products: products.length,
        generated_at: physicalCount.generated_at
      }
    });
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    if (error.statusCode && error.payload) return res.status(error.statusCode).json(error.payload);
    logger.error('Error en createPhysicalCount:', error);
    return res.status(500).json({ success: false, message: 'Error al crear la sesión de conteo físico' });
  }
};

/**
 * GET /api/inventory/physical-counts
 * Historial paginado. Query: page, limit, status, warehouse_id, search (count_number)
 */
const getPhysicalCounts = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const tenant_id = req.user.tenant_id;
    const { status, warehouse_id, search = '', page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const where = { tenant_id };
    if (status) where.status = status;
    if (warehouse_id) where.warehouse_id = warehouse_id;
    if (search) where.count_number = { [Op.iLike]: `%${search}%` };

    const { count, rows } = await PhysicalCount.findAndCountAll({
      where,
      include: [
        { model: Warehouse, as: 'warehouse', attributes: ['id', 'name'] },
        { model: Category, as: 'category', attributes: ['id', 'name'] }
      ],
      order: [['generated_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    return res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    logger.error('Error en getPhysicalCounts:', error);
    return res.status(500).json({ success: false, message: 'Error al obtener el historial de conteos físicos' });
  }
};

/**
 * GET /api/inventory/physical-counts/:id
 */
const getPhysicalCountById = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const physicalCount = await PhysicalCount.findOne({
      where: { id, tenant_id },
      include: [
        { model: PhysicalCountItem, as: 'items' },
        { model: Warehouse, as: 'warehouse', attributes: ['id', 'name'] },
        { model: Category, as: 'category', attributes: ['id', 'name'] },
        { model: InventoryAdjustment, as: 'entry_adjustment', attributes: ['id', 'adjustment_number', 'status'] },
        { model: InventoryAdjustment, as: 'exit_adjustment', attributes: ['id', 'adjustment_number', 'status'] }
      ]
    });

    if (!physicalCount) return res.status(404).json({ success: false, message: 'Sesión de conteo no encontrada' });

    return res.json({ success: true, data: physicalCount });
  } catch (error) {
    logger.error('Error en getPhysicalCountById:', error);
    return res.status(500).json({ success: false, message: 'Error al obtener la sesión de conteo' });
  }
};

/**
 * GET /api/inventory/physical-counts/:id/template
 * Genera y descarga el .xlsx a partir del snapshot ya guardado (no re-consulta
 * stock actual). Solo la columna "Conteo físico" queda editable.
 */
const downloadTemplate = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const physicalCount = await PhysicalCount.findOne({
      where: { id, tenant_id },
      include: [{ model: PhysicalCountItem, as: 'items' }]
    });
    if (!physicalCount) return res.status(404).json({ success: false, message: 'Sesión de conteo no encontrada' });

    const items = [...physicalCount.items].sort((a, b) => (a.product_sku || '').localeCompare(b.product_sku || ''));
    const productIds = items.map((it) => it.product_id);
    const products = await Product.findAll({
      where: { id: { [Op.in]: productIds } },
      attributes: ['id', 'unit_of_measure', 'category_id'],
      include: [{ model: Category, as: 'category', attributes: ['id', 'name'] }]
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Pitbox';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Conteo');
    sheet.columns = [
      { header: 'Código (SKU)', key: 'sku', width: 18 },
      { header: 'Nombre', key: 'name', width: 42 },
      { header: 'Categoría', key: 'category', width: 22 },
      { header: 'Unidad', key: 'unit', width: 10 },
      { header: 'Cantidad en sistema', key: 'system_qty', width: 18 },
      { header: 'Conteo físico', key: 'counted_qty', width: 16 },
      { header: 'Diferencia', key: 'diff', width: 14 },
      { header: 'product_id', key: 'product_id', width: 38 }
    ];
    sheet.getRow(1).font = { bold: true };

    items.forEach((item, idx) => {
      const rowNumber = idx + 2;
      const product = productById.get(item.product_id);
      sheet.addRow({
        sku: item.product_sku,
        name: item.product_name,
        category: product?.category?.name || '',
        unit: product?.unit_of_measure || '',
        system_qty: parseFloat(item.system_qty) || 0,
        counted_qty: null,
        diff: null,
        product_id: item.product_id
      });
      sheet.getCell(`G${rowNumber}`).value = { formula: `IF(F${rowNumber}="","",F${rowNumber}-E${rowNumber})` };
    });

    // Bloquear todas las celdas por defecto; desbloquear solo "Conteo físico".
    sheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.protection = { locked: true };
      });
    });
    for (let r = 2; r <= items.length + 1; r++) {
      sheet.getCell(`F${r}`).protection = { locked: false };
    }
    sheet.getColumn('product_id').hidden = true;
    await sheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });

    // Hoja oculta con metadatos de la descarga.
    const metaSheet = workbook.addWorksheet('meta', { state: 'veryHidden' });
    metaSheet.addRow(['count_id', physicalCount.id]);
    metaSheet.addRow(['count_number', physicalCount.count_number]);
    metaSheet.addRow(['downloaded_at', new Date().toISOString()]);
    metaSheet.addRow(['tenant_id', tenant_id]);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${physicalCount.count_number}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error('Error en downloadTemplate:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Error al generar la plantilla de conteo físico' });
    } else {
      res.end();
    }
  }
};

// ── Lectura tolerante del Excel subido ──────────────────────────────────────
async function readCountRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = cellToText(cell.value).trim();
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      const text = cellToText(cell.value).trim();
      data[key] = text;
      if (text !== '' && key !== 'Diferencia') hasValue = true;
    });
    if (hasValue) rows.push({ rowNumber, data });
  });

  // Hoja oculta 'meta' (ver downloadTemplate): permite detectar que el
  // usuario subió la plantilla de OTRA sesión (pestaña equivocada, archivo
  // viejo) antes de emparejar filas por product_id/SKU contra esta sesión.
  let metaCountId = null;
  const metaSheet = workbook.getWorksheet('meta');
  if (metaSheet) {
    metaSheet.eachRow((row) => {
      if (cellToText(row.getCell(1).value).trim() === 'count_id') {
        metaCountId = cellToText(row.getCell(2).value).trim();
      }
    });
  }

  return { headers, rows, metaCountId };
}

// Empareja cada fila del archivo con su PhysicalCountItem (product_id primero,
// SKU como respaldo), marca duplicados y valida el valor de "Conteo físico".
// Celda vacía = "no contado" salvo que treatEmptyAsZero venga explícito.
function parseAndValidateRows(count, rows, { treatEmptyAsZero }) {
  const itemsByProductId = new Map(count.items.map((it) => [it.product_id, it]));
  const itemsBySku = new Map(
    count.items.filter((it) => it.product_sku).map((it) => [it.product_sku.trim().toUpperCase(), it])
  );
  const seenItemIds = new Set();

  const matched = []; // { rowNumber, item, countedQty }
  const notCountedFromFile = []; // items con celda vacía (informativo, no error)
  const errors = [];

  for (const { rowNumber, data } of rows) {
    const productIdRaw = (data['product_id'] || '').trim();
    const skuRaw = (data['Código (SKU)'] || '').trim();

    let item = null;
    if (productIdRaw && itemsByProductId.has(productIdRaw)) item = itemsByProductId.get(productIdRaw);
    else if (skuRaw && itemsBySku.has(skuRaw.toUpperCase())) item = itemsBySku.get(skuRaw.toUpperCase());

    if (!item) {
      errors.push({ row: rowNumber, sku: skuRaw || productIdRaw || '(sin identificar)', errors: ['Producto no pertenece a esta sesión de conteo o no fue encontrado (SKU/ID de otro tenant o inexistente)'] });
      continue;
    }

    if (seenItemIds.has(item.id)) {
      errors.push({ row: rowNumber, sku: item.product_sku, errors: ['Producto duplicado en el archivo'] });
      continue;
    }
    seenItemIds.add(item.id);

    const countedText = (data['Conteo físico'] || '').trim();
    if (countedText === '') {
      if (treatEmptyAsZero) {
        matched.push({ rowNumber, item, countedQty: 0 });
      } else {
        notCountedFromFile.push(item);
      }
      continue;
    }

    const parsed = parseLocaleNumber(countedText);
    if (Number.isNaN(parsed)) {
      errors.push({ row: rowNumber, sku: item.product_sku, errors: [`Valor de conteo no numérico: "${countedText}"`] });
      continue;
    }
    if (parsed < 0) {
      errors.push({ row: rowNumber, sku: item.product_sku, errors: ['El conteo no puede ser negativo'] });
      continue;
    }

    matched.push({ rowNumber, item, countedQty: round2(parsed) });
  }

  const notCountedItems = count.items.filter((it) => !seenItemIds.has(it.id));

  return { matched, notCountedFromFile, notCountedItems, errors };
}

/**
 * POST /api/inventory/physical-counts/:id/upload?dry_run=true|false
 * multipart/form-data, campo "archivo".
 * body opcionales: treat_empty_as_zero ('true'|'false'), apply_despite_conflict ('true'|'false')
 *
 * El multer.single() intermedio rompe la propagación del AsyncLocalStorage
 * que tenantMiddleware usa para fijar el schema del tenant -- mismo problema
 * ya resuelto en productsBulkImport.controller.js. Se re-fija acá con el
 * schema_name que tenantMiddleware dejó en req.tenant.
 */
const uploadPhysicalCount = (req, res) => {
  if (req.tenant?.schema_name) {
    return runWithTenantSchema(req.tenant.schema_name, () => uploadPhysicalCountInner(req, res));
  }
  return uploadPhysicalCountInner(req, res);
};

const uploadPhysicalCountInner = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    if (!req.file) return res.status(400).json({ success: false, message: 'Debe adjuntar un archivo Excel' });

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;
    const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === 'true' ? true
      : (req.query.dry_run === 'false' || req.body?.dry_run === 'false' ? false : true);
    const treatEmptyAsZero = req.body?.treat_empty_as_zero === 'true';
    const applyDespiteConflict = req.body?.apply_despite_conflict === 'true';

    const count = await PhysicalCount.findOne({
      where: { id, tenant_id },
      include: [{ model: PhysicalCountItem, as: 'items' }]
    });
    if (!count) return res.status(404).json({ success: false, message: 'Sesión de conteo no encontrada' });
    if (count.status !== 'open') {
      return res.status(400).json({ success: false, message: `Esta sesión ya está en estado "${count.status}" y no admite una nueva carga` });
    }

    let headers, rows, metaCountId;
    try {
      ({ headers, rows, metaCountId } = await readCountRows(req.file.buffer));
    } catch (err) {
      return res.status(400).json({ success: false, message: 'No se pudo leer el archivo Excel: ' + err.message });
    }

    if (metaCountId && metaCountId !== count.id) {
      return res.status(400).json({ success: false, message: 'Este archivo corresponde a otra sesión de conteo físico (plantilla equivocada)' });
    }

    const requiredHeaders = ['product_id', 'Código (SKU)', 'Conteo físico'];
    const missing = requiredHeaders.filter((h) => !headers.includes(h));
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `El archivo no corresponde a la plantilla de conteo físico. Faltan columnas: ${missing.join(', ')}` });
    }

    const { matched, notCountedItems, errors } = parseAndValidateRows(count, rows, { treatEmptyAsZero });

    // Stock en vivo de todos los productos referenciados en filas válidas, para
    // detectar conflictos (movimientos entre la descarga y la subida) y
    // calcular el costo/diferencia informativa del preview.
    const productIds = [...new Set(matched.map((m) => m.item.product_id))];
    const products = await Product.findAll({ where: { id: { [Op.in]: productIds }, tenant_id } });
    const productById = new Map(products.map((p) => [p.id, p]));

    const okRows = [];
    const conflictRows = [];

    for (const m of matched) {
      const product = productById.get(m.item.product_id);
      if (!product) {
        errors.push({ row: m.rowNumber, sku: m.item.product_sku, errors: ['El producto ya no existe'] });
        continue;
      }
      const liveStock = parseFloat(product.current_stock) || 0;
      const snapshotStock = parseFloat(m.item.system_qty) || 0;
      const hasConflict = Math.abs(liveStock - snapshotStock) > CONFLICT_EPSILON;
      const unitCost = parseFloat(product.average_cost) || 0;
      const diffQty = round2(m.countedQty - liveStock);

      const rowData = {
        item: m.item,
        product,
        countedQty: m.countedQty,
        liveStock,
        snapshotStock,
        diffQty,
        unitCost,
        zeroCostWarning: unitCost === 0 && diffQty !== 0
      };

      if (hasConflict) conflictRows.push(rowData);
      else okRows.push(rowData);
    }

    const applicableRows = applyDespiteConflict ? [...okRows, ...conflictRows] : okRows;
    const surplusRows = applicableRows.filter((r) => r.diffQty > 0);
    const shortageRows = applicableRows.filter((r) => r.diffQty < 0);

    const summary = {
      total_productos: count.total_products,
      filas_en_archivo: rows.length,
      contados: matched.length,
      no_contados: notCountedItems.length,
      conflictos: conflictRows.length,
      con_errores: errors.length,
      sobrantes: {
        productos: surplusRows.length,
        unidades: round2(surplusRows.reduce((s, r) => s + r.diffQty, 0)),
        valor: round2(surplusRows.reduce((s, r) => s + r.diffQty * r.unitCost, 0))
      },
      faltantes: {
        productos: shortageRows.length,
        unidades: round2(shortageRows.reduce((s, r) => s + Math.abs(r.diffQty), 0)),
        valor: round2(shortageRows.reduce((s, r) => s + Math.abs(r.diffQty) * r.unitCost, 0))
      },
      productos_costo_cero: applicableRows.filter((r) => r.zeroCostWarning).length
    };

    if (dryRun) {
      return res.json({
        success: true,
        data: {
          id: count.id,
          count_number: count.count_number,
          summary,
          filas: applicableRows.filter((r) => r.diffQty !== 0).map((r) => ({
            product_id: r.item.product_id,
            sku: r.item.product_sku,
            name: r.item.product_name,
            system_qty: r.snapshotStock,
            current_stock: r.liveStock,
            counted_qty: r.countedQty,
            diff_qty: r.diffQty,
            unit_cost: r.unitCost,
            value: round2(r.diffQty * r.unitCost),
            zero_cost_warning: r.zeroCostWarning
          })),
          conflictos: conflictRows.map((r) => ({
            product_id: r.item.product_id,
            sku: r.item.product_sku,
            name: r.item.product_name,
            system_qty: r.snapshotStock,
            current_stock: r.liveStock,
            counted_qty: r.countedQty,
            would_be_diff: r.diffQty
          })),
          errores: errors.slice(0, MAX_REPORTED_ERRORS),
          errores_truncados: errors.length > MAX_REPORTED_ERRORS
        }
      });
    }

    // ------- Aplicación real (dry_run=false), una sola transacción -------
    const t = await sequelize.transaction();
    try {
      // Re-lockear y re-chequear el estado DENTRO de la transacción: el
      // check de status==='open' de arriba se hizo fuera de cualquier lock,
      // así que dos uploads dry_run=false concurrentes para la misma sesión
      // (doble click, reintento) podían pasar ambos esa validación y aplicar
      // el conteo dos veces. Con el lock de fila, el segundo espera a que el
      // primero libere el commit y ve status='applied'.
      const lockedCount = await PhysicalCount.findOne({
        where: { id: count.id, tenant_id },
        lock: t.LOCK.UPDATE,
        transaction: t
      });
      if (!lockedCount || lockedCount.status !== 'open') {
        throw httpError(400, { success: false, message: `Esta sesión ya está en estado "${lockedCount?.status || 'desconocido'}" y no admite una nueva carga` });
      }

      // InventoryMovement.warehouse_id es NOT NULL; createMovement ya hace
      // fallback a product.warehouse_id si no se pasa uno, pero si el
      // producto TAMPOCO tiene bodega asignada y la sesión no filtró por
      // bodega, no hay con qué completar la columna. Se resuelve una bodega
      // por defecto del tenant como último recurso (mismo caso límite que ya
      // existe hoy en un ajuste manual sin warehouse_id sobre un producto sin
      // bodega -- no es nuevo de este endpoint, solo se evita que reviente).
      let movementWarehouseId = count.warehouse_id;
      if (!movementWarehouseId) {
        const fallbackWarehouse = await Warehouse.findOne({
          where: { tenant_id },
          order: [['is_default', 'DESC'], ['is_main', 'DESC'], ['created_at', 'ASC']],
          transaction: t
        });
        movementWarehouseId = fallbackWarehouse ? fallbackWarehouse.id : null;
      }

      const entryItems = [];
      const exitItems = [];
      const itemUpdates = []; // { item, counted_qty, diff_qty, has_conflict }

      for (const r of applicableRows) {
        // Lock de fila (igual que createMovement) para recalcular la
        // diferencia contra el stock ACTUAL al momento de confirmar, no
        // contra el snapshot ni contra la lectura hecha arriba para el
        // preview -- evita condiciones de carrera con otro proceso que
        // mueva stock justo antes de aplicar.
        const lockedProduct = await Product.findByPk(r.item.product_id, {
          lock: t.LOCK.UPDATE,
          transaction: t
        });
        if (!lockedProduct) continue; // ya fue reportado como error arriba

        const finalDiff = round2(r.countedQty - (parseFloat(lockedProduct.current_stock) || 0));
        itemUpdates.push({ item: r.item, counted_qty: r.countedQty, diff_qty: finalDiff, has_conflict: r.hasConflict || false });

        if (finalDiff > 0) entryItems.push({ product_id: r.item.product_id, quantity: finalDiff });
        else if (finalDiff < 0) exitItems.push({ product_id: r.item.product_id, quantity: Math.abs(finalDiff) });
      }

      // Filas contadas pero sin diferencia aplicable (ya coincide el stock):
      // se marcan como aplicadas igual, con diff 0.
      for (const r of applicableRows) {
        if (!itemUpdates.find((u) => u.item.id === r.item.id)) {
          itemUpdates.push({ item: r.item, counted_qty: r.countedQty, diff_qty: 0, has_conflict: r.hasConflict || false });
        }
      }

      let entry_adjustment_id = null;
      let exit_adjustment_id = null;
      const affectedProductIds = new Set();
      // Se guardan para contabilizar DESPUÉS del commit (ver setImmediate más
      // abajo) -- confirmAdjustmentCore ya trae items+unit_cost cargados, así
      // no hace falta re-consultarlos.
      let entryAdjustment = null;
      let exitAdjustment = null;

      if (entryItems.length > 0) {
        const created = await createAdjustmentCore({
          tenant_id, user_id, adjustment_type: 'entrada', reason: 'toma_fisica',
          warehouse_id: movementWarehouseId, adjustment_date: new Date(),
          notes: `Toma física ${count.count_number}`, items: entryItems, physical_count_id: count.id
        }, t);
        const confirmed = await confirmAdjustmentCore({ tenant_id, user_id, adjustment_id: created.adjustment_id }, t);
        entry_adjustment_id = created.adjustment_id;
        entryAdjustment = confirmed.adjustment;
        confirmed.product_ids.forEach((pid) => affectedProductIds.add(pid));
      }

      if (exitItems.length > 0) {
        const created = await createAdjustmentCore({
          tenant_id, user_id, adjustment_type: 'salida', reason: 'toma_fisica',
          warehouse_id: movementWarehouseId, adjustment_date: new Date(),
          notes: `Toma física ${count.count_number}`, items: exitItems, physical_count_id: count.id
        }, t);
        const confirmed = await confirmAdjustmentCore({ tenant_id, user_id, adjustment_id: created.adjustment_id }, t);
        exit_adjustment_id = created.adjustment_id;
        exitAdjustment = confirmed.adjustment;
        confirmed.product_ids.forEach((pid) => affectedProductIds.add(pid));
      }

      for (const u of itemUpdates) {
        await PhysicalCountItem.update(
          { counted_qty: u.counted_qty, diff_qty: u.diff_qty, has_conflict: u.has_conflict, applied: true },
          { where: { id: u.item.id }, transaction: t }
        );
      }

      await count.update({
        status: 'applied',
        applied_by: user_id,
        applied_at: new Date(),
        entry_adjustment_id,
        exit_adjustment_id,
        counted_products: matched.length,
        not_counted_products: notCountedItems.length,
        conflict_products: conflictRows.length,
        error_rows: errors.length,
        surplus_products: summary.sobrantes.productos,
        surplus_qty: summary.sobrantes.unidades,
        surplus_value: summary.sobrantes.valor,
        shortage_products: summary.faltantes.productos,
        shortage_qty: summary.faltantes.unidades,
        shortage_value: summary.faltantes.valor
      }, { transaction: t });

      await t.commit();

      // Asientos contables en borrador (no bloqueante: si falla, solo se
      // loguea) -- uno por cada ajuste de entrada/salida que haya generado
      // esta aplicación.
      setImmediate(async () => {
        try {
          const { generateAdjustmentEntry } = require('../../services/accounting/autoEntries.service');
          if (entryAdjustment) await generateAdjustmentEntry(entryAdjustment, entryAdjustment.items, tenant_id, user_id);
          if (exitAdjustment) await generateAdjustmentEntry(exitAdjustment, exitAdjustment.items, tenant_id, user_id);
        } catch (err) {
          logger.warn(`[accounting] Error generando asiento del conteo físico ${count.id}: ${err.message}`);
        }
      });

      const productIdsArr = [...affectedProductIds];
      markProductsForAlertCheck(res, productIdsArr, tenant_id);
      setImmediate(() => audit({
        tenant_id, user_id, action: 'PHYSICAL_COUNT_APPLIED',
        entity: 'physical_count', entity_id: count.id,
        changes: { count_number: count.count_number, entry_adjustment_id, exit_adjustment_id, products_affected: productIdsArr.length },
        req
      }));

      return res.json({
        success: true,
        message: 'Conteo físico aplicado. Inventario ajustado exitosamente.',
        data: {
          id: count.id,
          count_number: count.count_number,
          status: 'applied',
          entry_adjustment_id,
          exit_adjustment_id,
          summary
        }
      });
    } catch (error) {
      if (t && !t.finished) await t.rollback();
      if (error.statusCode && error.payload) return res.status(error.statusCode).json(error.payload);
      throw error;
    }
  } catch (error) {
    logger.error('Error en uploadPhysicalCount:', error);
    return res.status(500).json({ success: false, message: 'Error al procesar el archivo de conteo físico' });
  }
};

/**
 * GET /api/inventory/physical-counts/:id/report
 * Informe en Excel de los resultados ya aplicados (opcional).
 */
const downloadReport = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const count = await PhysicalCount.findOne({
      where: { id, tenant_id },
      include: [{ model: PhysicalCountItem, as: 'items' }]
    });
    if (!count) return res.status(404).json({ success: false, message: 'Sesión de conteo no encontrada' });
    if (count.status !== 'applied') {
      return res.status(400).json({ success: false, message: 'Esta sesión todavía no ha sido aplicada' });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Resultado');
    sheet.columns = [
      { header: 'Código (SKU)', key: 'sku', width: 18 },
      { header: 'Nombre', key: 'name', width: 42 },
      { header: 'Cantidad en sistema', key: 'system_qty', width: 18 },
      { header: 'Conteo físico', key: 'counted_qty', width: 16 },
      { header: 'Diferencia', key: 'diff_qty', width: 14 },
      { header: 'Costo unitario', key: 'unit_cost', width: 16 },
      { header: 'Valor diferencia', key: 'value', width: 16 }
    ];
    sheet.getRow(1).font = { bold: true };

    count.items
      .filter((it) => it.applied)
      .sort((a, b) => (a.product_sku || '').localeCompare(b.product_sku || ''))
      .forEach((it) => {
        const diff = it.diff_qty !== null ? parseFloat(it.diff_qty) : null;
        sheet.addRow({
          sku: it.product_sku,
          name: it.product_name,
          system_qty: parseFloat(it.system_qty) || 0,
          counted_qty: it.counted_qty !== null ? parseFloat(it.counted_qty) : null,
          diff_qty: diff,
          unit_cost: parseFloat(it.unit_cost) || 0,
          value: diff !== null ? round2(diff * (parseFloat(it.unit_cost) || 0)) : null
        });
      });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${count.count_number}-resultado.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error('Error en downloadReport:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Error al generar el informe de conteo físico' });
    } else {
      res.end();
    }
  }
};

module.exports = {
  createPhysicalCount,
  getPhysicalCounts,
  getPhysicalCountById,
  downloadTemplate,
  uploadPhysicalCount,
  downloadReport
};
