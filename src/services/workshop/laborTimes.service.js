// backend/src/services/workshop/laborTimes.service.js
//
// Tempario y productividad de técnicos.
//
// Tempario = los servicios de mano de obra (products.is_labor) con sus horas
// estándar (standard_hours) y su modo de precio:
//   - 'hourly': base_price = horas × valor hora de la empresa
//     (business_config.labor_hour_rate). Se recalcula al cambiar las horas,
//     el modo o el valor hora; así OT, ventas y cotizaciones toman el precio
//     de siempre (base_price) sin cambios.
//   - 'fixed' o NULL: precio propio del servicio, como hasta hoy.
// No depende del tipo de vehículo: cada taller configura sus servicios.
//
// Productividad = horas tempario de las OT terminadas del técnico ÷ horas
// disponibles. Horas tempario = work_order_items.standard_hours (copia al
// agregar la línea) × cantidad, del técnico de la línea (o el de la OT).
// Horas disponibles = jornada del técnico (technician_schedules; sin
// configurar: la de la empresa) en los días del periodo hasta hoy, sin
// festivos y menos ausencias (technician_absences). No usa nómina: no todas
// las empresas la tienen.
const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { loadXlsx } = require('../../utils/loadXlsx');
const { cellToText, parseLocaleNumber } = require('../../utils/excelCell');
const { isHoliday } = require('../radian/businessDays');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const schema = () => getCurrentSchema() || 'public';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRICING_MODES = ['fixed', 'hourly'];
// Lunes a viernes 8 h, sábado 4 h, domingo 0. Clave = día de la semana (0 = domingo).
const DEFAULT_SCHEDULE = { 0: 0, 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 4 };
const ABSENCE_REASONS = ['vacaciones', 'incapacidad', 'permiso', 'licencia', 'otro'];

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/* ═════════════════════ Valor hora y precio por hora ═════════════════════ */

async function laborSettings(tenantId, transaction) {
  const { Tenant } = require('../../models');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'business_config'], transaction });
  const cfg = tenant?.business_config || {};
  return {
    labor_hour_rate: Number(cfg.labor_hour_rate) > 0 ? Number(cfg.labor_hour_rate) : 0,
    default_pricing_mode: PRICING_MODES.includes(cfg.labor_default_pricing_mode) ? cfg.labor_default_pricing_mode : 'fixed',
    default_schedule: normalizeSchedule(cfg.labor_default_schedule) || { ...DEFAULT_SCHEDULE },
  };
}

// Pesos enteros: el valor hora y las horas dan el precio del servicio.
const hourlyPrice = (hours, rate) => Math.round(Number(hours) * Number(rate));

/**
 * Hook de Product.beforeSave: un servicio de mano de obra "por hora" toma su
 * precio al crearse o al cambiarle horas/modo. Sin valor hora configurado no
 * toca el precio.
 */
async function applyHourlyPrice(product, transaction) {
  if (product.labor_pricing_mode != null && !PRICING_MODES.includes(product.labor_pricing_mode)) product.labor_pricing_mode = null;
  if (product.standard_hours != null && !(Number(product.standard_hours) > 0)) product.standard_hours = null;
  if (!product.is_labor || product.labor_pricing_mode !== 'hourly' || !(Number(product.standard_hours) > 0)) return;
  const relevant = product.isNewRecord || product.changed('standard_hours') || product.changed('labor_pricing_mode') || product.changed('is_labor') || product.changed('base_price');
  if (!relevant || !product.tenant_id) return;
  const { labor_hour_rate: rate } = await laborSettings(product.tenant_id, transaction);
  if (rate > 0) product.base_price = hourlyPrice(product.standard_hours, rate);
}

// Recalcula todos los servicios "por hora" con el valor hora vigente.
async function recomputeHourlyPrices(tenantId, rate, transaction) {
  if (!(Number(rate) > 0)) return 0;
  const [, meta] = await sequelize.query(
    `UPDATE "${schema()}"."products"
        SET base_price = ROUND(standard_hours * :rate), updated_at = NOW()
      WHERE tenant_id = :tenantId AND is_labor = true AND labor_pricing_mode = 'hourly'
        AND standard_hours > 0 AND base_price IS DISTINCT FROM ROUND(standard_hours * :rate)`,
    { replacements: { tenantId, rate: Number(rate) }, transaction },
  );
  return meta?.rowCount ?? 0;
}

async function saveSettings(tenantId, body = {}) {
  const { Tenant } = require('../../models');
  const rate = body.labor_hour_rate === '' || body.labor_hour_rate == null ? null : parseLocaleNumber(body.labor_hour_rate);
  if (rate != null && !(Number.isFinite(rate) && rate >= 0)) throw httpError(400, 'El valor hora debe ser un número mayor o igual a 0');
  const mode = body.default_pricing_mode;
  if (mode != null && !PRICING_MODES.includes(mode)) throw httpError(400, 'Modo de precio inválido');
  const schedule = body.default_schedule != null ? normalizeSchedule(body.default_schedule) : undefined;
  if (body.default_schedule != null && !schedule) throw httpError(400, 'Jornada inválida: horas entre 0 y 24 por día');

  return sequelize.transaction(async (t) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: t, lock: t.LOCK.UPDATE });
    const cfg = { ...(tenant.business_config || {}) };
    if (rate !== undefined) cfg.labor_hour_rate = rate;
    if (mode) cfg.labor_default_pricing_mode = mode;
    if (schedule) cfg.labor_default_schedule = schedule;
    tenant.business_config = cfg;
    tenant.changed('business_config', true);
    await tenant.save({ transaction: t });
    const updated = rate > 0 ? await recomputeHourlyPrices(tenantId, rate, t) : 0;
    return { ...(await laborSettings(tenantId, t)), prices_updated: updated };
  });
}

/* ═════════════════════ Tempario (servicios de mano de obra) ═════════════════════ */

const laborWhere = (tenantId) => ({ tenant_id: tenantId, product_type: 'service', is_labor: true });

async function listServices(tenantId, { search, category_id, status = 'active', missing_hours, page = 1, limit = 50 } = {}) {
  const { Product, Category } = require('../../models');
  const where = laborWhere(tenantId);
  if (status === 'active') where.is_active = true;
  else if (status === 'inactive') where.is_active = false;
  if (category_id) where.category_id = category_id;
  if (missing_hours === 'true' || missing_hours === true) where[Op.or] = [{ standard_hours: null }, { standard_hours: { [Op.lte]: 0 } }];
  if (search) {
    const like = `%${String(search).trim()}%`;
    where[Op.and] = [{ [Op.or]: [{ name: { [Op.iLike]: like } }, { sku: { [Op.iLike]: like } }] }];
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const { rows, count } = await Product.findAndCountAll({
    where,
    include: [{ model: Category, as: 'category', attributes: ['id', 'name'], required: false }],
    attributes: ['id', 'sku', 'name', 'category_id', 'base_price', 'tax_percentage', 'price_includes_tax', 'standard_hours', 'labor_pricing_mode', 'is_active'],
    order: [['name', 'ASC']],
    limit: lim,
    offset: (pg - 1) * lim,
  });
  const [[stats]] = await sequelize.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE standard_hours > 0)::int AS with_hours,
            COUNT(*) FILTER (WHERE labor_pricing_mode = 'hourly')::int AS hourly
       FROM "${schema()}"."products"
      WHERE tenant_id = :tenantId AND product_type = 'service' AND is_labor = true AND is_active = true`,
    { replacements: { tenantId } },
  );
  return {
    items: rows,
    stats,
    pagination: { page: pg, limit: lim, total: count, pages: Math.ceil(count / lim) },
  };
}

async function updateService(tenantId, id, body = {}) {
  const { Product } = require('../../models');
  const product = await Product.findOne({ where: { ...laborWhere(tenantId), id } });
  if (!product) throw httpError(404, 'Servicio de mano de obra no encontrado');
  if (body.standard_hours !== undefined) {
    const hours = body.standard_hours === '' || body.standard_hours == null ? null : parseLocaleNumber(body.standard_hours);
    if (hours != null && !(Number.isFinite(hours) && hours >= 0 && hours <= 999)) throw httpError(400, 'Las horas deben estar entre 0 y 999');
    product.standard_hours = hours > 0 ? round2(hours) : null;
  }
  if (body.labor_pricing_mode !== undefined) {
    if (body.labor_pricing_mode && !PRICING_MODES.includes(body.labor_pricing_mode)) throw httpError(400, 'Modo de precio inválido');
    product.labor_pricing_mode = body.labor_pricing_mode || null;
  }
  // Precio manual solo en modo fijo (en modo por hora lo calcula el valor hora).
  if (body.base_price !== undefined && product.labor_pricing_mode !== 'hourly') {
    const price = parseLocaleNumber(body.base_price);
    if (!(Number.isFinite(price) && price >= 0)) throw httpError(400, 'Precio inválido');
    product.base_price = price;
  }
  if (product.labor_pricing_mode === 'hourly' && !(Number(product.standard_hours) > 0)) {
    throw httpError(400, 'Un servicio con precio por hora necesita las horas del tempario');
  }
  await product.save();
  return product;
}

/* ═════════════════════ Excel: plantilla, exportación, importación ═════════════════════ */

const COLUMNS = [
  { key: 'sku', header: 'Código', required: true, width: 14, help: 'Código del servicio. Si ya existe un servicio de mano de obra con ese código, se actualiza.', example: 'MO-001' },
  { key: 'name', header: 'Nombre', required: true, width: 40, help: 'Nombre de la operación.', example: 'Cambio de aceite y filtro' },
  { key: 'category', header: 'Sistema / categoría', width: 22, help: 'Categoría del servicio (motor, frenos, eléctrico…). Si no existe se crea.', example: 'Motor' },
  { key: 'hours', header: 'Horas tempario', required: true, width: 14, help: 'Tiempo estándar de la operación en horas (1,5 = hora y media).', example: '0,5' },
  { key: 'mode', header: 'Modo de precio', width: 16, options: ['Por hora', 'Fijo'], help: 'Por hora = horas × valor hora de la empresa. Fijo = el precio de la columna siguiente. Vacío = el modo por defecto de la empresa.', example: 'Por hora' },
  { key: 'price', header: 'Precio fijo', width: 14, help: 'Solo para modo Fijo. Obligatorio al crear un servicio con precio fijo; vacío al actualizar = conserva el precio actual.', example: '45000' },
  { key: 'iva', header: 'IVA', width: 12, options: ['19', '5', 'Exento', 'Excluido'], help: 'Tratamiento de IVA. Vacío = 19 % al crear; al actualizar conserva el actual.', example: '19' },
  { key: 'active', header: 'Activo', width: 10, options: ['Sí', 'No'], help: 'No = el servicio queda inactivo. Vacío = Sí.', example: 'Sí' },
];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const HEADER_TO_KEY = new Map(COLUMNS.flatMap((c) => [[norm(c.header), c.key]]).concat([
  ['codigo (sku)', 'sku'], ['sku', 'sku'], ['categoria', 'category'], ['sistema', 'category'], ['horas', 'hours'],
  ['tiempo', 'hours'], ['tiempo (horas)', 'hours'], ['modo', 'mode'], ['precio', 'price'], ['precio venta', 'price'],
]));

function styleHeader(ws) {
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 30;
  COLUMNS.forEach((c, i) => {
    head.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFC2410C' : 'FF475569' } };
    if (c.help) head.getCell(i + 1).note = c.help;
    if (c.options) {
      const letter = ws.getColumn(i + 1).letter;
      for (let r = 2; r <= 2000; r += 1) {
        ws.getCell(`${letter}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${c.options.join(',')}"`], showErrorMessage: false };
      }
    }
  });
  ws.getColumn(1).numFmt = '@';
}

async function buildWorkbook(rows = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pitbox';
  const ws = wb.addWorksheet('Tempario', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.required ? `${c.header}*` : c.header, key: c.key, width: c.width }));
  rows.forEach((r) => ws.addRow(r));
  styleHeader(ws);

  const help = wb.addWorksheet('Instrucciones');
  help.columns = [{ header: 'Columna', width: 22 }, { header: 'Obligatoria', width: 12 }, { header: 'Qué escribir', width: 80 }, { header: 'Ejemplo', width: 26 }];
  help.getRow(1).font = { bold: true };
  help.addRow(['Una operación por fila desde la fila 2. No cambies los encabezados. Las columnas con * son obligatorias. Los servicios se crean como "Mano de obra".']);
  help.mergeCells('A2:D2');
  help.getRow(2).font = { italic: true };
  for (const c of COLUMNS) help.addRow([c.header, c.required ? 'Sí' : '', [c.help, c.options ? `Valores: ${c.options.join(', ')}.` : ''].filter(Boolean).join(' '), c.example || '']);
  help.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
  return wb.xlsx.writeBuffer();
}

const buildTemplate = () => buildWorkbook();

async function exportServices(tenantId) {
  const { Product, Category } = require('../../models');
  const products = await Product.findAll({
    where: laborWhere(tenantId),
    include: [{ model: Category, as: 'category', attributes: ['name'], required: false }],
    order: [['name', 'ASC']],
  });
  return buildWorkbook(products.map((p) => ({
    sku: p.sku,
    name: p.name,
    category: p.category?.name || '',
    hours: p.standard_hours != null ? Number(p.standard_hours) : null,
    mode: p.labor_pricing_mode === 'hourly' ? 'Por hora' : 'Fijo',
    price: p.labor_pricing_mode === 'hourly' ? null : Number(p.base_price || 0),
    iva: p.tax_config?.iva_status === 'excluido' ? 'Excluido' : p.tax_config?.iva_status === 'exento' ? 'Exento' : String(Number(p.tax_percentage || 0)),
    active: p.is_active ? 'Sí' : 'No',
  })));
}

async function readRows(buffer) {
  const wb = await loadXlsx(buffer);
  const ws = wb.getWorksheet('Tempario') || wb.worksheets[0];
  if (!ws) return { fields: new Set(), ignored: [], rows: [] };
  const colKey = [];
  const fields = new Set();
  const ignored = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const header = cellToText(cell.value).trim();
    if (!header) return;
    const key = HEADER_TO_KEY.get(norm(header.replace(/\*/g, '')));
    if (key && !fields.has(key)) { colKey[col] = key; fields.add(key); } else ignored.push(header);
  });
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {};
    let any = false;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = colKey[col];
      if (!key) return;
      const text = cellToText(cell.value).trim();
      data[key] = text;
      if (text) any = true;
    });
    if (any) rows.push({ rowNumber, data });
  });
  return { fields, ignored, rows };
}

function parseIva(raw, errors) {
  const v = norm(raw).replace('%', '').trim();
  if (!v) return null;
  if (v === 'excluido') return { iva_status: 'excluido', rate: 0 };
  if (v === 'exento' || v === '0') return { iva_status: 'exento', rate: 0 };
  const rate = parseLocaleNumber(v);
  if ([19, 5].includes(rate)) return { iva_status: 'gravado', rate };
  errors.push(`IVA "${raw}" no válido (use 19, 5, Exento o Excluido)`);
  return null;
}

function parseRow(data, defaults) {
  const errors = [];
  const sku = String(data.sku || '').trim();
  const name = String(data.name || '').trim();
  if (!sku) errors.push('Falta el código');
  if (sku.length > 50) errors.push('El código supera 50 caracteres');
  if (!name) errors.push('Falta el nombre');
  if (name.length > 200) errors.push('El nombre supera 200 caracteres');

  let hours = null;
  if (!data.hours) errors.push('Faltan las horas del tempario');
  else {
    hours = parseLocaleNumber(data.hours);
    if (!(Number.isFinite(hours) && hours > 0 && hours <= 999)) { errors.push(`Horas "${data.hours}" no válidas (número mayor a 0)`); hours = null; }
  }

  const m = norm(data.mode);
  let mode = defaults.default_pricing_mode;
  if (m) {
    if (['por hora', 'hora', 'hourly'].includes(m)) mode = 'hourly';
    else if (['fijo', 'precio fijo', 'fixed'].includes(m)) mode = 'fixed';
    else errors.push(`Modo de precio "${data.mode}" no válido (use Por hora o Fijo)`);
  }
  if (mode === 'hourly' && !(defaults.labor_hour_rate > 0)) errors.push('Modo Por hora sin valor hora configurado: configúralo en el tempario primero');

  let price = null;
  if (data.price) {
    price = parseLocaleNumber(data.price);
    if (!(Number.isFinite(price) && price >= 0)) { errors.push(`Precio "${data.price}" no válido`); price = null; }
  }

  let active = true;
  const a = norm(data.active);
  if (a) {
    if (['si', 's', 'x', '1', 'true'].includes(a)) active = true;
    else if (['no', 'n', '0', 'false'].includes(a)) active = false;
    else errors.push(`Activo "${data.active}" no válido (use Sí o No)`);
  }

  return {
    errors,
    row: { sku, name, category: String(data.category || '').trim().slice(0, 100), hours: hours != null ? round2(hours) : null, mode, price, iva: parseIva(data.iva, errors), active },
  };
}

/**
 * Importa el tempario. Crea servicios de mano de obra nuevos y, con
 * updateExisting, actualiza nombre/categoría/horas/modo/precio/IVA/activo de
 * los que ya existen por código. Un código que existe y NO es mano de obra
 * se rechaza (no se convierte un repuesto en servicio).
 */
async function importServices(tenantId, buffer, { dryRun = true, updateExisting = false } = {}) {
  const { Product, Category } = require('../../models');
  const { fields, ignored, rows } = await readRows(buffer);
  if (!fields.has('sku') || !fields.has('name') || !fields.has('hours')) {
    throw httpError(400, 'El archivo no tiene las columnas Código, Nombre y Horas tempario. Descarga la plantilla.');
  }
  if (!rows.length) throw httpError(400, 'El archivo no tiene filas para importar');
  if (rows.length > 5000) throw httpError(400, 'Máximo 5.000 filas por archivo');

  const settings = await laborSettings(tenantId);
  const parsed = rows.map(({ rowNumber, data }) => ({ rowNumber, ...parseRow(data, settings) }));

  // Códigos repetidos dentro del archivo
  const seen = new Map();
  parsed.forEach((p) => {
    if (!p.row.sku) return;
    const k = p.row.sku.toUpperCase();
    if (seen.has(k)) p.errors.push(`Código repetido en el archivo (fila ${seen.get(k)})`);
    else seen.set(k, p.rowNumber);
  });

  const skus = parsed.map((p) => p.row.sku).filter(Boolean);
  const existing = await Product.findAll({
    where: { tenant_id: tenantId, sku: { [Op.in]: skus } },
    attributes: ['id', 'sku', 'product_type', 'is_labor', 'base_price', 'labor_pricing_mode'],
  });
  const bySku = new Map(existing.map((p) => [p.sku.toUpperCase(), p]));
  const categories = await Category.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'name'] });
  const categoryByName = new Map(categories.map((c) => [norm(c.name), c.id]));

  const toCreate = [];
  const toUpdate = [];
  const skipped = [];
  const errors = [];
  for (const p of parsed) {
    const current = p.row.sku ? bySku.get(p.row.sku.toUpperCase()) : null;
    if (current && !(current.product_type === 'service' && current.is_labor)) {
      p.errors.push(`El código ${p.row.sku} ya existe y no es un servicio de mano de obra`);
    }
    if (!current && p.row.mode === 'fixed' && p.row.price == null) p.errors.push('Precio fijo obligatorio para crear un servicio con precio fijo');
    if (p.errors.length) { errors.push({ row: p.rowNumber, sku: p.row.sku, errors: p.errors }); continue; }
    if (current) {
      if (updateExisting) toUpdate.push({ ...p, current });
      else skipped.push({ row: p.rowNumber, sku: p.row.sku });
    } else {
      toCreate.push(p);
    }
  }
  const newCategories = [...new Set([...toCreate, ...toUpdate].map((p) => p.row.category).filter((c) => c && !categoryByName.has(norm(c))))];

  const summary = {
    total_rows: rows.length,
    to_create: toCreate.length,
    to_update: toUpdate.length,
    skipped_existing: skipped.length,
    new_categories: newCategories,
    errors: errors.slice(0, 300),
    error_count: errors.length,
    ignored_columns: ignored,
    labor_hour_rate: settings.labor_hour_rate,
  };
  if (dryRun) return { dry_run: true, ...summary, preview: [...toCreate, ...toUpdate].slice(0, 20).map((p) => ({ ...p.row, action: p.current ? 'actualizar' : 'crear' })) };

  const priceFor = (row, currentPrice) => (row.mode === 'hourly'
    ? hourlyPrice(row.hours, settings.labor_hour_rate)
    : row.price != null ? row.price : Number(currentPrice || 0));
  const taxFields = (iva) => (iva ? {
    has_tax: iva.rate > 0,
    tax_percentage: iva.rate,
    tax_config: { iva_status: iva.iva_status, iva: { enabled: iva.rate > 0, rate: iva.rate }, inc: { enabled: false, rate: 0 }, ica: { enabled: false, rate: 0 } },
  } : {});

  await sequelize.transaction(async (t) => {
    for (const name of newCategories) {
      const created = await Category.create({ tenant_id: tenantId, name, is_active: true }, { transaction: t });
      categoryByName.set(norm(name), created.id);
    }
    const categoryId = (name) => (name ? categoryByName.get(norm(name)) || null : undefined);
    for (const p of toCreate) {
      await Product.create({
        tenant_id: tenantId,
        sku: p.row.sku,
        name: p.row.name,
        category_id: categoryId(p.row.category) || null,
        product_type: 'service',
        is_labor: true,
        unit_of_measure: 'unit',
        track_inventory: false,
        allow_negative_stock: false,
        current_stock: 0,
        reserved_stock: 0,
        available_stock: 0,
        average_cost: 0,
        min_stock: 0,
        is_active: p.row.active,
        price_includes_tax: false,
        ...taxFields(p.row.iva || { iva_status: 'gravado', rate: 19 }),
        standard_hours: p.row.hours,
        labor_pricing_mode: p.row.mode,
        base_price: priceFor(p.row, 0),
      }, { transaction: t });
    }
    for (const p of toUpdate) {
      const cat = categoryId(p.row.category);
      await Product.update({
        name: p.row.name,
        ...(cat !== undefined && { category_id: cat }),
        is_active: p.row.active,
        ...taxFields(p.row.iva),
        standard_hours: p.row.hours,
        labor_pricing_mode: p.row.mode,
        base_price: priceFor(p.row, p.current.base_price),
      }, { where: { id: p.current.id, tenant_id: tenantId }, transaction: t });
    }
  });

  return { dry_run: false, ...summary, created: toCreate.length, updated: toUpdate.length };
}

/* ═════════════════════ Jornada y ausencias ═════════════════════ */

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (let d = 0; d <= 6; d += 1) {
    const v = raw[d] ?? raw[String(d)] ?? 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 24) return null;
    out[d] = round2(n);
  }
  return out;
}

async function technicians(tenantId) {
  const { User } = require('../../models');
  const [users, schedules] = await Promise.all([
    User.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'first_name', 'last_name', 'role', 'is_active'], order: [['first_name', 'ASC']] }),
    sequelize.query(`SELECT user_id, hours_by_weekday, skip_holidays, is_active FROM "${schema()}"."technician_schedules" WHERE tenant_id = :tenantId`,
      { replacements: { tenantId }, type: sequelize.QueryTypes.SELECT }),
  ]);
  const scheduleByUser = new Map(schedules.map((s) => [s.user_id, s]));
  return { users, scheduleByUser };
}

async function listSchedules(tenantId) {
  const settings = await laborSettings(tenantId);
  const { users, scheduleByUser } = await technicians(tenantId);
  // Técnicos (rol) + cualquiera que ya tenga jornada configurada.
  return {
    default_schedule: settings.default_schedule,
    technicians: users
      .filter((u) => u.role === 'technician' || scheduleByUser.has(u.id))
      .map((u) => {
        const s = scheduleByUser.get(u.id);
        return {
          user_id: u.id,
          name: [u.first_name, u.last_name].filter(Boolean).join(' '),
          role: u.role,
          user_active: u.is_active !== false,
          configured: !!s,
          hours_by_weekday: normalizeSchedule(s?.hours_by_weekday) || settings.default_schedule,
          skip_holidays: s ? s.skip_holidays : true,
          is_active: s ? s.is_active : true,
        };
      }),
  };
}

async function saveSchedule(tenantId, userId, body = {}) {
  const { User } = require('../../models');
  const user = await User.findOne({ where: { id: userId, tenant_id: tenantId }, attributes: ['id'] });
  if (!user) throw httpError(404, 'Usuario no encontrado');
  const hours = normalizeSchedule(body.hours_by_weekday);
  if (!hours) throw httpError(400, 'Jornada inválida: horas entre 0 y 24 por día');
  await sequelize.query(
    `INSERT INTO "${schema()}"."technician_schedules" (tenant_id, user_id, hours_by_weekday, skip_holidays, is_active)
     VALUES (:tenantId, :userId, :hours::jsonb, :skip, :active)
     ON CONFLICT (tenant_id, user_id) DO UPDATE
       SET hours_by_weekday = EXCLUDED.hours_by_weekday, skip_holidays = EXCLUDED.skip_holidays,
           is_active = EXCLUDED.is_active, updated_at = NOW()`,
    { replacements: { tenantId, userId, hours: JSON.stringify(hours), skip: body.skip_holidays !== false, active: body.is_active !== false } },
  );
  return { user_id: userId, hours_by_weekday: hours, skip_holidays: body.skip_holidays !== false, is_active: body.is_active !== false };
}

async function listAbsences(tenantId, { user_id, from, to } = {}) {
  const where = ['tenant_id = :tenantId'];
  if (user_id) where.push('user_id = :user_id');
  if (from && DATE_RE.test(from)) where.push('end_date >= :from');
  if (to && DATE_RE.test(to)) where.push('start_date <= :to');
  return sequelize.query(
    `SELECT id, user_id, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date, reason, notes, created_at
       FROM "${schema()}"."technician_absences" WHERE ${where.join(' AND ')} ORDER BY start_date DESC`,
    { replacements: { tenantId, user_id, from, to }, type: sequelize.QueryTypes.SELECT },
  );
}

async function createAbsence(tenantId, body = {}, createdBy = null) {
  const { User } = require('../../models');
  const { user_id, start_date, end_date, reason = 'otro', notes } = body;
  if (!DATE_RE.test(String(start_date || '')) || !DATE_RE.test(String(end_date || ''))) throw httpError(400, 'Fechas inválidas (desde y hasta)');
  if (end_date < start_date) throw httpError(400, 'La fecha final no puede ser anterior a la inicial');
  if (!ABSENCE_REASONS.includes(reason)) throw httpError(400, 'Motivo inválido');
  const user = await User.findOne({ where: { id: user_id, tenant_id: tenantId }, attributes: ['id'] });
  if (!user) throw httpError(404, 'Técnico no encontrado');
  const [[row]] = await sequelize.query(
    `INSERT INTO "${schema()}"."technician_absences" (tenant_id, user_id, start_date, end_date, reason, notes, created_by)
     VALUES (:tenantId, :user_id, :start_date, :end_date, :reason, :notes, :createdBy) RETURNING id`,
    { replacements: { tenantId, user_id, start_date, end_date, reason, notes: notes ? String(notes).slice(0, 500) : null, createdBy } },
  );
  return { id: row.id };
}

async function deleteAbsence(tenantId, id) {
  const [, meta] = await sequelize.query(`DELETE FROM "${schema()}"."technician_absences" WHERE tenant_id = :tenantId AND id = :id`, { replacements: { tenantId, id } });
  if (!(meta?.rowCount > 0)) throw httpError(404, 'Ausencia no encontrada');
}

/* ═════════════════════ Productividad ═════════════════════ */

function eachDay(from, to, fn) {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    fn(d.toISOString().slice(0, 10), d.getUTCDay(), new Date(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/**
 * Horas disponibles de un técnico entre from y to (inclusive): jornada por
 * día de la semana, sin festivos (si skip_holidays) y sin días de ausencia.
 * Pura sobre los datos, para probarla aparte.
 */
function availableHours({ from, to, schedule, skipHolidays = true, absences = [] }) {
  const absent = new Set();
  absences.forEach((a) => eachDay(a.start_date > from ? a.start_date : from, a.end_date < to ? a.end_date : to, (day) => absent.add(day)));
  let total = 0;
  let absentHours = 0;
  let workdays = 0;
  eachDay(from, to, (day, dow, date) => {
    const h = Number(schedule[dow] || 0);
    if (!h) return;
    if (skipHolidays && isHoliday(date)) return;
    if (absent.has(day)) { absentHours += h; return; }
    total += h;
    workdays += 1;
  });
  return { hours: round2(total), absent_hours: round2(absentHours), workdays };
}

const bogotaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Líneas de mano de obra de OT terminadas (listo/entregado) en el periodo.
async function laborLines(tenantId, from, to, technicianId = null) {
  return sequelize.query(
    `SELECT i.id, i.work_order_id, w.order_number, w.status,
            to_char(COALESCE(w.completed_at, w.delivered_at) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS finished_on,
            COALESCE(i.technician_id, w.technician_id) AS technician_id,
            i.product_name, i.item_type, i.quantity, i.standard_hours, i.subtotal
       FROM "${schema()}"."work_order_items" i
       JOIN "${schema()}"."work_orders" w ON w.id = i.work_order_id
      WHERE w.tenant_id = :tenantId
        AND w.status IN ('listo', 'entregado')
        AND (COALESCE(w.completed_at, w.delivered_at) AT TIME ZONE 'America/Bogota')::date BETWEEN :from AND :to
        AND i.approval_status <> 'rechazado'
        AND (i.item_type = 'mano_obra' OR i.standard_hours > 0)
        ${technicianId ? 'AND COALESCE(i.technician_id, w.technician_id) = :technicianId' : ''}
      ORDER BY finished_on, w.order_number`,
    { replacements: { tenantId, from, to, technicianId }, type: sequelize.QueryTypes.SELECT },
  );
}

function checkPeriod(from, to) {
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) throw httpError(400, 'Periodo inválido (desde y hasta)');
  if (from > to) throw httpError(400, 'La fecha inicial no puede ser posterior a la final');
  const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
  if (days > 370) throw httpError(400, 'El periodo máximo es un año');
}

async function productivity(tenantId, { from, to } = {}) {
  checkPeriod(from, to);
  const settings = await laborSettings(tenantId);
  const [lines, { users, scheduleByUser }, absences] = await Promise.all([
    laborLines(tenantId, from, to),
    technicians(tenantId),
    listAbsences(tenantId, { from, to }),
  ]);
  // Disponibles solo hasta hoy: un mes en curso no cuenta días que no han pasado.
  const today = bogotaToday();
  const availTo = to < today ? to : today;

  const byTech = new Map();
  const ensure = (id) => {
    if (!byTech.has(id)) byTech.set(id, { technician_id: id, orders: new Set(), lines: 0, lines_without_hours: 0, tempario_hours: 0, labor_value: 0 });
    return byTech.get(id);
  };
  let unassigned = { lines: 0, tempario_hours: 0, labor_value: 0 };
  for (const l of lines) {
    const hours = Number(l.standard_hours || 0) * Number(l.quantity || 0);
    if (!l.technician_id) {
      unassigned = { lines: unassigned.lines + 1, tempario_hours: unassigned.tempario_hours + hours, labor_value: unassigned.labor_value + Number(l.subtotal || 0) };
      continue;
    }
    const r = ensure(l.technician_id);
    r.orders.add(l.work_order_id);
    r.lines += 1;
    if (!(Number(l.standard_hours) > 0)) r.lines_without_hours += 1;
    r.tempario_hours += hours;
    r.labor_value += Number(l.subtotal || 0);
  }
  // También aparecen los técnicos sin trabajos en el periodo (productividad 0).
  users.forEach((u) => {
    const s = scheduleByUser.get(u.id);
    if ((u.role === 'technician' && u.is_active !== false && (!s || s.is_active)) || (s && s.is_active)) ensure(u.id);
  });

  const userById = new Map(users.map((u) => [u.id, u]));
  const rows = [...byTech.values()].map((r) => {
    const u = userById.get(r.technician_id);
    const s = scheduleByUser.get(r.technician_id);
    const schedule = normalizeSchedule(s?.hours_by_weekday) || settings.default_schedule;
    const avail = from <= availTo
      ? availableHours({ from, to: availTo, schedule, skipHolidays: s ? s.skip_holidays : true, absences: absences.filter((a) => a.user_id === r.technician_id) })
      : { hours: 0, absent_hours: 0, workdays: 0 };
    const tempario = round2(r.tempario_hours);
    return {
      technician_id: r.technician_id,
      name: u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : 'Usuario eliminado',
      schedule_configured: !!s,
      orders: r.orders.size,
      lines: r.lines,
      lines_without_hours: r.lines_without_hours,
      tempario_hours: tempario,
      available_hours: avail.hours,
      absent_hours: avail.absent_hours,
      workdays: avail.workdays,
      productivity_pct: avail.hours > 0 ? round2((tempario / avail.hours) * 100) : null,
      labor_value: round2(r.labor_value),
    };
  }).sort((a, b) => (b.productivity_pct ?? -1) - (a.productivity_pct ?? -1) || a.name.localeCompare(b.name));

  const totals = rows.reduce((acc, r) => ({
    tempario_hours: acc.tempario_hours + r.tempario_hours,
    available_hours: acc.available_hours + r.available_hours,
    labor_value: acc.labor_value + r.labor_value,
    lines_without_hours: acc.lines_without_hours + r.lines_without_hours,
  }), { tempario_hours: 0, available_hours: 0, labor_value: 0, lines_without_hours: 0 });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });
  totals.productivity_pct = totals.available_hours > 0 ? round2((totals.tempario_hours / totals.available_hours) * 100) : null;

  return {
    from, to, available_until: availTo, rows, totals,
    unassigned: { lines: unassigned.lines, tempario_hours: round2(unassigned.tempario_hours), labor_value: round2(unassigned.labor_value) },
  };
}

async function productivityDetail(tenantId, technicianId, { from, to } = {}) {
  checkPeriod(from, to);
  const lines = await laborLines(tenantId, from, to, technicianId);
  return lines.map((l) => ({
    ...l,
    quantity: Number(l.quantity),
    standard_hours: l.standard_hours != null ? Number(l.standard_hours) : null,
    hours: round2(Number(l.standard_hours || 0) * Number(l.quantity || 0)),
    subtotal: Number(l.subtotal || 0),
  }));
}

module.exports = {
  PRICING_MODES, ABSENCE_REASONS, DEFAULT_SCHEDULE,
  laborSettings, saveSettings, hourlyPrice, applyHourlyPrice, recomputeHourlyPrices,
  listServices, updateService, buildTemplate, exportServices, importServices,
  listSchedules, saveSchedule, listAbsences, createAbsence, deleteAbsence,
  availableHours, productivity, productivityDetail, normalizeSchedule,
};
