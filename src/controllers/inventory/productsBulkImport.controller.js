const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const { Product, Category, ProductEquivalenceGroup, ProductEquivalenceGroupMember, InventoryMovement, Warehouse } = require('../../models/inventory');
const { sequelize } = require('../../config/database');
const { runWithTenantSchema } = require('../../config/tenantContext');
const { cellToText, parseLocaleNumber } = require('../../utils/excelCell');
const { suggestedSalePrice, isValidMargin, marginRangeMessage } = require('../../utils/salePricing');
const { loadMarginResolver } = require('../../services/inventory/productMargin.service');
const { nextMovementNumbers } = require('../../services/inventory/movementNumber.service');

const MAX_REPORTED_ERRORS = 300;

// Texto comparable: sin tildes, minúsculas, espacios colapsados. Se usa para
// encabezados, nombres de categoría y valores tipo "Sí"/"Excluido".
const normalizeText = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// Encabezado del Excel (normalizado, sin "*") → campo. Acepta los nombres de
// la plantilla actual, los de la anterior y los de la exportación de productos.
const COLUMN_ALIASES = {
  sku: ['codigo', 'sku', 'codigo (sku)'],
  name: ['nombre', 'nombre del producto'],
  barcode: ['codigo de barras', 'barcode'],
  description: ['descripcion'],
  category: ['categoria'],
  brand: ['marca'],
  type: ['tipo', 'tipo de item'],
  unit: ['unidad', 'unidad de medida'],
  cost: ['costo', 'costo promedio', 'costo unitario'],
  margin: ['margen utilidad (%)', 'margen (%)', 'margen', 'margen de ganancia (%)'],
  price: ['precio venta', 'precio de venta', 'precio'],
  price_includes_tax: ['precio incluye iva', 'precio incluye impuestos'],
  iva: ['iva', 'iva (%)', 'tratamiento de iva'],
  inc: ['inc (%)', 'inc', 'impoconsumo (%)'],
  quantity: ['cantidad', 'stock inicial'],
  min_stock: ['stock minimo'],
  max_stock: ['stock maximo'],
  allow_negative_stock: ['permitir stock negativo', 'stock negativo'],
  equivalents: ['equivalente(s)', 'equivalentes', 'equivalente'],
};
const HEADER_TO_FIELD = new Map(
  Object.entries(COLUMN_ALIASES).flatMap(([field, aliases]) => aliases.map((a) => [a, field]))
);
const REQUIRED_FIELDS = { sku: 'Código*', name: 'Nombre*' };

// Longitudes de las columnas en BD -- validarlas acá da un error por fila en
// vez de tumbar el lote completo del bulkCreate.
const MAX_LENGTHS = { sku: 50, name: 200, barcode: 100, brand: 100, category: 100 };

const CATEGORY_SEPARATOR = '>';
const IVA_RATES = [19, 5];
const TRUE_VALUES = new Set(['si', 's', 'x', '1', 'true', 'verdadero', 'yes']);
const FALSE_VALUES = new Set(['no', 'n', '0', 'false', 'falso']);
// Tamaño de lote para bulkCreate / IN (...) -- con archivos de miles de filas,
// un await por fila agota el timeout del cliente/proxy antes de terminar.
const BULK_CHUNK_SIZE = 500;

// Debe reflejar exactamente el CHECK del controlador de productos
// (products.controller.js VALID_UNITS_OF_MEASURE) y el mapeo usado por el
// importador anterior del lado del cliente (utils/excelExport.js).
const UNIT_OF_MEASURE_MAP = {
  pieza: 'unit', unidad: 'unit', unit: 'unit',
  kg: 'kg', kilogramo: 'kg',
  g: 'g', gramo: 'g',
  lb: 'lb', libra: 'lb',
  oz: 'oz', onza: 'oz',
  l: 'l', litro: 'l',
  ml: 'ml', mililitro: 'ml',
  gal: 'gal', galon: 'gal', 'galón': 'gal',
  m: 'm', metro: 'm',
  cm: 'cm', centimetro: 'cm', 'centímetro': 'cm',
  ft: 'ft', pie: 'ft',
  box: 'box', caja: 'box',
  pack: 'pack', paquete: 'pack',
  dozen: 'dozen', docena: 'dozen',
};

// null = valor no reconocido (la fila se marca con error en vez de caer a 'unit').
const mapUnitOfMeasure = (unit) => {
  if (!unit) return 'unit';
  return UNIT_OF_MEASURE_MAP[unit.toString().toLowerCase().trim()] || null;
};

// Une nodos por SKU normalizado -- Union-Find (path compression, sin unión por rango
// porque los grupos aquí son pequeños y el archivo se procesa una sola vez).
class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// Lee la primera hoja y deja cada fila con las claves de COLUMN_ALIASES.
// ignoredColumns: encabezados que no corresponden a ningún campo (se reportan
// para que el usuario sepa que esa columna no se cargó).
async function readExcelRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { fields: new Set(), ignoredColumns: [], rows: [] };

  const columnFields = [];
  const fields = new Set();
  const ignoredColumns = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const header = cellToText(cell.value).trim();
    if (!header) return;
    const field = HEADER_TO_FIELD.get(normalizeText(header.replace(/\*/g, '')));
    if (field && !fields.has(field)) {
      columnFields[colNumber] = field;
      fields.add(field);
    } else {
      ignoredColumns.push(header);
    }
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const field = columnFields[colNumber];
      if (!field) return;
      const text = cellToText(cell.value).trim();
      data[field] = text;
      if (text !== '') hasValue = true;
    });
    if (hasValue) rows.push({ rowNumber, data });
  });

  return { fields, ignoredColumns, rows };
}

// Número opcional: null si la celda está vacía; error si trae texto que no es
// número o si es negativo (antes un "$15.000" mal digitado quedaba en 0 sin aviso).
function parseOptionalNumber(raw, label, errors) {
  if (raw === undefined || raw === '') return null;
  const n = parseLocaleNumber(raw);
  if (!Number.isFinite(n)) { errors.push(`${label}: "${raw}" no es un número`); return null; }
  if (n < 0) { errors.push(`${label} no puede ser negativo`); return null; }
  return n;
}

function parseOptionalBoolean(raw, label, errors, defaultValue = false) {
  if (raw === undefined || raw === '') return defaultValue;
  const v = normalizeText(raw);
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  errors.push(`${label}: "${raw}" no es válido (use Sí o No)`);
  return defaultValue;
}

// Tipo de ítem igual que el formulario: producto físico, servicio o servicio
// de mano de obra. Los vehículos crean además un registro en `vehicles`, así
// que se siguen creando uno a uno desde el formulario.
function parseItemType(raw, errors) {
  const v = normalizeText(raw);
  if (!v || ['producto', 'producto fisico', 'bien', 'simple'].includes(v)) return { product_type: 'simple', is_labor: false };
  if (v === 'servicio') return { product_type: 'service', is_labor: false };
  if (v === 'mano de obra') return { product_type: 'service', is_labor: true };
  if (['vehiculo', 'vehicle'].includes(v)) {
    errors.push('Los vehículos no se importan: créalos desde el formulario de producto');
  } else {
    errors.push(`Tipo "${raw}" no válido (use Producto, Servicio o Mano de obra)`);
  }
  return { product_type: 'simple', is_labor: false };
}

// Tratamiento de IVA igual que el formulario (tax_config.iva_status viaja a
// cada línea de venta y al XML DIAN): gravado 19/5, exento (IVA 0 %) o excluido.
function parseIva(raw, errors) {
  const v = normalizeText(raw).replace('%', '').trim();
  if (!v) return { iva_status: 'gravado', rate: 19 };
  if (v === 'excluido') return { iva_status: 'excluido', rate: 0 };
  if (v === 'exento' || v === '0') return { iva_status: 'exento', rate: 0 };
  const rate = parseLocaleNumber(v);
  if (IVA_RATES.includes(rate)) return { iva_status: 'gravado', rate };
  errors.push(`IVA "${raw}" no válido (use 19, 5, Exento o Excluido)`);
  return { iva_status: 'gravado', rate: 19 };
}

// Ruta de categoría "Padre > Hija" → segmentos. Vacío = sin categoría.
const splitCategoryPath = (raw) => String(raw || '')
  .split(CATEGORY_SEPARATOR)
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

/**
 * Resuelve las categorías del archivo contra las del tenant. Los nombres son
 * únicos por tenant (tenant_category_unique), así que se buscan por nombre
 * sin importar mayúsculas/tildes ni el padre. Si el último nivel no existe
 * se planea crearlo (y los niveles intermedios que falten) bajo el padre
 * indicado en la ruta.
 *
 * Devuelve:
 *   byPath:  Map<pathKey, { leafKey, marginCategoryId, error }>
 *   pending: Map<nameKey, { name, parentKey }> en orden padre → hijo
 *   idByKey: Map<nameKey, id> (se completa al crear las pendientes)
 *   nameByKey: Map<nameKey, nombre> (existentes y pendientes)
 */
function planCategories(rawPaths, existingCategories) {
  const idByKey = new Map();
  const nameByKey = new Map();
  for (const c of existingCategories) {
    const key = normalizeText(c.name);
    if (!idByKey.has(key)) { idByKey.set(key, c.id); nameByKey.set(key, c.name); }
  }

  const pending = new Map();
  const byPath = new Map();

  for (const raw of rawPaths) {
    const segments = splitCategoryPath(raw);
    const pathKey = segments.map(normalizeText).join(CATEGORY_SEPARATOR);
    if (!segments.length || byPath.has(pathKey)) continue;

    const tooLong = segments.find((s) => s.length > MAX_LENGTHS.category);
    if (tooLong) {
      byPath.set(pathKey, { error: `La categoría "${tooLong}" supera ${MAX_LENGTHS.category} caracteres` });
      continue;
    }

    const leafKey = normalizeText(segments[segments.length - 1]);
    if (!idByKey.has(leafKey)) {
      let parentKey = null;
      for (const segment of segments) {
        const key = normalizeText(segment);
        if (!idByKey.has(key) && !pending.has(key)) pending.set(key, { name: segment, parentKey });
        parentKey = key;
      }
    }

    // Las categorías nuevas nacen sin margen propio: heredan del primer
    // ancestro que ya existe (o del global), igual que productMargin.service.
    let key = leafKey;
    while (key && !idByKey.has(key)) key = pending.get(key)?.parentKey ?? null;
    byPath.set(pathKey, { leafKey, marginCategoryId: key ? idByKey.get(key) : null });
  }

  for (const [key, p] of pending) nameByKey.set(key, p.name);
  return { byPath, pending, idByKey, nameByKey };
}

// ctx: { marginMethod, marginFor(categoryId), categoryPlan }
function parseRow(rowNumber, data, ctx) {
  const { marginMethod, marginFor, categoryPlan } = ctx;
  const errors = [];
  const text = (field) => (data[field] || '').trim();

  const sku = text('sku');
  const name = text('name');
  if (!sku) errors.push('Código es requerido');
  if (!name) errors.push('Nombre es requerido');
  const barcode = text('barcode') || null;
  const description = text('description') || null;
  const brand = text('brand') || null;
  for (const [field, label, value] of [['sku', 'Código', sku], ['name', 'Nombre', name], ['barcode', 'Código de barras', barcode], ['brand', 'Marca', brand]]) {
    if (value && value.length > MAX_LENGTHS[field]) errors.push(`${label} supera ${MAX_LENGTHS[field]} caracteres`);
  }

  const { product_type, is_labor } = parseItemType(data.type, errors);
  const isService = product_type === 'service';

  const unit_of_measure = mapUnitOfMeasure(data.unit);
  if (!unit_of_measure) errors.push(`Unidad "${data.unit}" no reconocida`);

  // Categoría
  const segments = splitCategoryPath(data.category);
  const pathKey = segments.map(normalizeText).join(CATEGORY_SEPARATOR);
  const category = segments.length ? categoryPlan.byPath.get(pathKey) : null;
  if (category?.error) errors.push(category.error);
  const category_key = category && !category.error ? category.leafKey : null;
  const category_label = segments.join(` ${CATEGORY_SEPARATOR} `) || null;

  // Impuestos
  const { iva_status, rate: tax_percentage } = parseIva(data.iva, errors);
  const incRate = parseOptionalNumber(data.inc, 'INC (%)', errors) || 0;
  if (incRate > 100) errors.push('INC (%) no puede ser mayor a 100');
  const price_includes_tax = parseOptionalBoolean(data.price_includes_tax, 'Precio incluye IVA', errors);
  const has_tax = tax_percentage > 0;
  const tax_config = {
    iva_status,
    iva: { enabled: has_tax, rate: tax_percentage },
    inc: { enabled: incRate > 0, rate: incRate },
    ica: { enabled: false, rate: 0 },
  };

  // Costo, margen y precio. Sin margen en la fila, hereda de su categoría
  // (o del global); si tampoco hay, 30 % propio como antes.
  const average_cost = parseOptionalNumber(data.cost, 'Costo', errors) ?? 0;
  const marginRaw = parseOptionalNumber(data.margin, 'Margen', errors);
  const inheritedMargin = category?.error ? null : marginFor(category?.marginCategoryId ?? null);
  const margin_inherited = marginRaw === null && inheritedMargin !== null;
  const profit_margin_percentage = marginRaw ?? (margin_inherited ? inheritedMargin : 30);
  if (!isValidMargin(profit_margin_percentage, marginMethod)) errors.push(`${marginRangeMessage(marginMethod)} (llegó ${profit_margin_percentage})`);

  const priceRaw = parseOptionalNumber(data.price, 'Precio Venta', errors);
  const base_price = priceRaw ?? (average_cost > 0
    ? suggestedSalePrice(average_cost, profit_margin_percentage, { price_includes_tax, has_tax, tax_percentage, tax_config }, marginMethod) ?? 0
    : 0);

  // Inventario: un servicio no maneja stock (igual que createProduct).
  const quantity = parseOptionalNumber(data.quantity, 'Cantidad', errors) ?? 0;
  if (isService && quantity > 0) errors.push('Un servicio no maneja inventario: deja Cantidad vacía');
  const current_stock = isService ? 0 : quantity;
  const min_stock = isService ? 0 : (parseOptionalNumber(data.min_stock, 'Stock mínimo', errors) ?? 0);
  const max_stock = isService ? null : parseOptionalNumber(data.max_stock, 'Stock máximo', errors);
  if (max_stock !== null && max_stock < min_stock) errors.push('Stock máximo no puede ser menor que el stock mínimo');
  const allow_negative_stock = isService ? false : parseOptionalBoolean(data.allow_negative_stock, 'Permitir stock negativo', errors);

  const equivalent_codes = (data.equivalents || '')
    .split(/[|,;]/)
    .map((c) => c.trim())
    .filter(Boolean);

  return {
    rowNumber, sku, name, barcode, description, brand, product_type, is_labor, unit_of_measure,
    category_key, category_label, average_cost, profit_margin_percentage, margin_inherited, base_price,
    has_tax, tax_percentage, price_includes_tax, tax_config,
    current_stock, min_stock, max_stock, allow_negative_stock, track_inventory: !isService,
    equivalent_codes, errors,
  };
}

const normalizeSku = (s) => s.trim().toUpperCase();

// Marca duplicados de código y de código de barras dentro del mismo archivo
// (mutan `errors` in-place).
function markDuplicatesInFile(parsedRows) {
  const seenSku = new Map();
  const seenBarcode = new Map();
  for (const row of parsedRows) {
    if (row.sku) {
      const key = normalizeSku(row.sku);
      if (seenSku.has(key)) row.errors.push(`Código duplicado en el archivo (fila ${seenSku.get(key)})`);
      else seenSku.set(key, row.rowNumber);
    }
    if (row.barcode) {
      if (seenBarcode.has(row.barcode)) row.errors.push(`Código de barras duplicado en el archivo (fila ${seenBarcode.get(row.barcode)})`);
      else seenBarcode.set(row.barcode, row.rowNumber);
    }
  }
}

// Construye los componentes conectados (clusters) de equivalencia a partir de
// las filas válidas + duplicadas (las que sí tienen SKU real, no las que
// fallaron validación). Retorna { roots: Map<root, Set<normalizedSku>>, unresolved: Set }
function buildClusters(linkableRows) {
  const uf = new UnionFind();
  const normToOriginalSku = new Map();

  for (const row of linkableRows) {
    const norm = normalizeSku(row.sku);
    uf.find(norm);
    normToOriginalSku.set(norm, row.sku);
    for (const code of row.equivalent_codes) {
      const codeNorm = normalizeSku(code);
      if (codeNorm === norm) continue; // auto-referencia, se ignora
      uf.union(norm, codeNorm);
    }
  }

  const allNodes = new Set();
  for (const row of linkableRows) {
    allNodes.add(normalizeSku(row.sku));
    for (const code of row.equivalent_codes) allNodes.add(normalizeSku(code));
  }

  const roots = new Map();
  for (const node of allNodes) {
    const root = uf.find(node);
    if (!roots.has(root)) roots.set(root, new Set());
    roots.get(root).add(node);
  }

  return { roots, normToOriginalSku };
}

// POST /products/bulk-import?dry_run=true|false
//
// El upload de archivo (multer/busboy, ver uploadProductsExcel.js) corre
// entre tenantMiddleware y este controller, y rompe la propagación del
// AsyncLocalStorage que tenantMiddleware usa para fijar el schema del
// tenant (ver tenantContext.js y el mismo problema ya resuelto en
// invoiceImport.controller.js) -- para cuando este handler arranca,
// getCurrentSchema() ya da undefined y todas las queries de Product/
// ProductEquivalenceGroup/-Member caen silenciosamente a `public` en vez
// del schema real del tenant. Fix: re-fijar el contexto acá mismo con el
// schema_name que tenantMiddleware ya dejó en req.tenant.
const bulkImportProducts = (req, res) => {
  if (req.tenant?.schema_name) {
    return runWithTenantSchema(req.tenant.schema_name, () => bulkImportProductsInner(req, res));
  }
  return bulkImportProductsInner(req, res);
};

const bulkImportProductsInner = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (req.user.role !== 'super_admin' && !req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'Debe adjuntar un archivo Excel' });

    const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === 'true';
    const tenantId = req.user.role === 'super_admin' ? (req.body.tenant_id || null) : req.user.tenant_id;
    if (!tenantId) return res.status(400).json({ success: false, message: 'Debe indicar tenant_id' });

    let fields, ignoredColumns, rows;
    try {
      ({ fields, ignoredColumns, rows } = await readExcelRows(req.file.buffer));
    } catch (err) {
      return res.status(400).json({ success: false, message: 'No se pudo leer el archivo Excel: ' + err.message });
    }

    const missingColumns = Object.entries(REQUIRED_FIELDS).filter(([f]) => !fields.has(f)).map(([, label]) => label);
    if (missingColumns.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Faltan columnas requeridas: ${missingColumns.join(', ')}`,
        columnas_faltantes: missingColumns,
      });
    }

    if (rows.length === 0) {
      return res.json({
        success: true,
        data: {
          total_registros: 0, creados: 0, omitidos_duplicados: 0, omitidos_duplicados_archivo: 0,
          con_errores: 0, grupos_equivalencia_creados: 0, grupos_equivalencia_reusados: 0,
          enlaces_equivalencia_creados: 0, codigos_equivalencia_no_encontrados: [], errores: [], errores_truncados: false,
          categorias_nuevas: [], columnas_ignoradas: ignoredColumns,
        },
      });
    }

    const { method: marginMethod, marginFor } = await loadMarginResolver(tenantId);
    const existingCategories = await Category.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'name', 'parent_id'] });
    const categoryPlan = planCategories(rows.map((r) => r.data.category), existingCategories);
    const categoryLabel = (c) => (c.parentKey ? `${categoryPlan.nameByKey.get(c.parentKey)} ${CATEGORY_SEPARATOR} ${c.name}` : c.name);

    const parsedRows = rows.map((r) => parseRow(r.rowNumber, r.data, { marginMethod, marginFor, categoryPlan }));
    markDuplicatesInFile(parsedRows);

    // Todos los productos del tenant, para detectar duplicados y resolver
    // códigos de equivalencia que apunten a productos que ya existían antes
    // de esta carga (no forman parte del archivo).
    const allTenantProducts = await Product.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'sku', 'barcode'] });
    const existingBySkuExact = new Map(allTenantProducts.map((p) => [p.sku, p.id]));
    const existingByNormalized = new Map(allTenantProducts.map((p) => [normalizeSku(p.sku), p.id]));
    const existingBarcodes = new Map(allTenantProducts.filter((p) => p.barcode).map((p) => [p.barcode, p.sku]));

    // El código de barras es único por tenant (tenant_barcode_unique), igual
    // que valida createProduct. Solo aplica a filas que sí se van a crear.
    for (const row of parsedRows) {
      if (row.errors.length || !row.barcode || existingBySkuExact.has(row.sku)) continue;
      const owner = existingBarcodes.get(row.barcode);
      if (owner) row.errors.push(`El código de barras ya lo tiene el producto ${owner}`);
    }

    const validRows = parsedRows.filter((r) => r.errors.length === 0);
    const invalidRows = parsedRows.filter((r) => r.errors.length > 0);

    const toCreate = [];
    const skippedExisting = [];
    for (const row of validRows) {
      if (existingBySkuExact.has(row.sku)) skippedExisting.push(row);
      else toCreate.push(row);
    }

    // Categorías nuevas que de verdad hacen falta: las de filas que se van a
    // crear, con sus niveles intermedios. En orden padre → hijo.
    const neededCategoryKeys = new Set();
    for (const row of toCreate) {
      let key = row.category_key;
      while (key && categoryPlan.pending.has(key)) {
        neededCategoryKeys.add(key);
        key = categoryPlan.pending.get(key).parentKey;
      }
    }
    const categoriesToCreate = [...categoryPlan.pending].filter(([key]) => neededCategoryKeys.has(key));

    // Filas "enlazables": válidas, sin importar si van a crearse o si ya
    // existían -- ambas pueden participar en un grupo de equivalencia.
    const linkableRows = [...toCreate, ...skippedExisting];

    if (dryRun) {
      const { roots } = buildClusters(linkableRows);
      const normsInFile = new Set(linkableRows.map((r) => normalizeSku(r.sku)));
      let clustersConPareja = 0;
      let enlacesEstimados = 0;
      const unresolved = new Set();

      for (const members of roots.values()) {
        if (members.size < 2) continue;
        let resolvedCount = 0;
        for (const norm of members) {
          const hasId = normsInFile.has(norm) || existingByNormalized.has(norm);
          if (hasId) resolvedCount++;
          else unresolved.add(norm);
        }
        if (resolvedCount >= 2) {
          clustersConPareja++;
          enlacesEstimados += resolvedCount;
        }
      }

      return res.json({
        success: true,
        data: {
          total_registros: rows.length,
          validos: validRows.length,
          invalidos: invalidRows.length,
          para_crear: toCreate.length,
          omitidos_duplicados: skippedExisting.length,
          grupos_equivalencia_estimados: clustersConPareja,
          enlaces_equivalencia_estimados: enlacesEstimados,
          codigos_equivalencia_no_encontrados: [...unresolved].slice(0, MAX_REPORTED_ERRORS),
          errores: invalidRows.slice(0, MAX_REPORTED_ERRORS).map((r) => ({ row: r.rowNumber, sku: r.sku || 'Sin código', name: r.name || 'Sin nombre', errors: r.errors })),
          errores_truncados: invalidRows.length > MAX_REPORTED_ERRORS,
          categorias_nuevas: categoriesToCreate.map(([, c]) => categoryLabel(c)),
          con_categoria: toCreate.filter((r) => r.category_key).length,
          columnas_ignoradas: ignoredColumns,
        },
      });
    }

    // ------- Categorías nuevas -------
    // Antes que los productos, para poder asignarles category_id. Son pocas
    // (una por nombre distinto), así que van una a una en orden padre → hijo.
    const categoriasCreadas = [];
    const failedCategoryKeys = new Map(); // key -> mensaje
    for (const [key, c] of categoriesToCreate) {
      const parentFailed = c.parentKey && failedCategoryKeys.has(c.parentKey);
      if (parentFailed) { failedCategoryKeys.set(key, `No se creó la categoría padre de "${c.name}"`); continue; }
      try {
        const created = await Category.create({
          tenant_id: tenantId,
          name: c.name,
          parent_id: c.parentKey ? categoryPlan.idByKey.get(c.parentKey) : null,
          is_active: true,
        });
        categoryPlan.idByKey.set(key, created.id);
        categoriasCreadas.push(categoryLabel(c));
      } catch (err) {
        failedCategoryKeys.set(key, `No se pudo crear la categoría "${c.name}": ${err.message}`);
      }
    }

    // Una fila cuya categoría no se pudo crear no se importa (quedaría sin
    // categoría y con un margen heredado distinto al que se le validó).
    const categoryErrors = [];
    for (let i = toCreate.length - 1; i >= 0; i--) {
      const row = toCreate[i];
      if (row.category_key && !categoryPlan.idByKey.has(row.category_key)) {
        categoryErrors.push({ row: row.rowNumber, sku: row.sku, name: row.name, errors: [failedCategoryKeys.get(row.category_key) || `Categoría "${row.category_label}" no disponible`] });
        toCreate.splice(i, 1);
      }
    }

    // ------- Importación real -------
    // Se usa bulkCreate en lotes en vez de un INSERT por fila -- con miles de
    // productos, un await por fila implica miles de viajes de ida y vuelta a
    // la BD y el request termina superando el timeout del cliente/proxy.
    const skuToId = new Map(existingBySkuExact);
    const creationErrors = [];
    let creados = 0;

    // Si el archivo trae stock inicial, ese stock necesita una bodega (igual
    // que createProduct) -- se resuelve UNA sola vez para todo el archivo, no
    // por fila, para no repetir la misma consulta miles de veces. Si el
    // tenant no tiene ninguna bodega todavía, se cae al comportamiento previo
    // (escribir current_stock/average_cost directo, sin kardex ni asiento)
    // en vez de bloquear la importación completa.
    const hasInitialStockRows = toCreate.some((row) => row.current_stock > 0);
    let bulkWarehouseId = null;
    if (hasInitialStockRows) {
      const fallbackWarehouse = await Warehouse.findOne({
        where: { tenant_id: tenantId },
        order: [['is_default', 'DESC'], ['is_main', 'DESC'], ['created_at', 'ASC']],
      });
      bulkWarehouseId = fallbackWarehouse ? fallbackWarehouse.id : null;
    }

    // Filas con stock inicial cuyo producto sí se creó -- alimentan el
    // InventoryMovement en bloque y el asiento contable consolidado de abajo.
    const stockedRows = []; // { sku, quantity, unit_cost }

    for (let i = 0; i < toCreate.length; i += BULK_CHUNK_SIZE) {
      const chunk = toCreate.slice(i, i + BULK_CHUNK_SIZE);
      // Si hay bodega resuelta, el producto arranca en cero -- su stock real
      // entra por el InventoryMovement en bloque de más abajo (mismo criterio
      // que createProduct: nada de stock/costo escrito directo en la fila).
      // Sin stock, el costo digitado se guarda tal cual (igual que createProduct):
      // sirve de base al precio sugerido y la primera compra lo reemplaza.
      const payload = chunk.map((row) => {
        const viaMovement = bulkWarehouseId && row.current_stock > 0;
        return {
          tenant_id: tenantId,
          sku: row.sku,
          barcode: row.barcode,
          name: row.name,
          description: row.description,
          brand: row.brand,
          category_id: row.category_key ? categoryPlan.idByKey.get(row.category_key) : null,
          unit_of_measure: row.unit_of_measure,
          average_cost: viaMovement ? 0 : row.average_cost,
          base_price: row.base_price,
          profit_margin_percentage: row.profit_margin_percentage,
          margin_inherited: row.margin_inherited,
          product_type: row.product_type,
          is_labor: row.is_labor,
          warehouse_id: bulkWarehouseId || null,
          current_stock: viaMovement ? 0 : row.current_stock,
          reserved_stock: 0,
          available_stock: viaMovement ? 0 : row.current_stock,
          min_stock: row.min_stock,
          max_stock: row.max_stock,
          track_inventory: row.track_inventory,
          allow_negative_stock: row.allow_negative_stock,
          is_active: true,
          has_tax: row.has_tax,
          tax_percentage: row.tax_percentage,
          price_includes_tax: row.price_includes_tax,
          tax_config: row.tax_config,
        };
      });

      const collectStocked = (row) => {
        if (bulkWarehouseId && row.current_stock > 0) {
          stockedRows.push({ sku: row.sku, quantity: row.current_stock, unit_cost: row.average_cost });
        }
      };

      try {
        const created = await Product.bulkCreate(payload, { returning: true, validate: true });
        created.forEach((product, idx) => {
          skuToId.set(chunk[idx].sku, product.id);
          collectStocked(chunk[idx]);
        });
        creados += created.length;
      } catch (err) {
        // Un INSERT multi-fila es atómico -- si una fila del lote falla, se
        // pierde todo el lote. Se reintenta fila por fila solo en ese caso,
        // para aislar cuál era la mala sin penalizar el caso normal.
        for (let idx = 0; idx < chunk.length; idx++) {
          const row = chunk[idx];
          try {
            const product = await Product.create(payload[idx]);
            skuToId.set(row.sku, product.id);
            collectStocked(row);
            creados++;
          } catch (rowErr) {
            creationErrors.push({ row: row.rowNumber, sku: row.sku, name: row.name, errors: [rowErr.message || 'Error al crear el producto'] });
          }
        }
      }
    }

    // ------- Kardex + asiento contable del stock inicial cargado -------
    // Todas las filas son productos RECIÉN creados con stock previo = 0, así
    // que el promedio ponderado resultante es simplemente el costo de la
    // fila -- no hace falta recalcular contra un stock previo como createMovement.
    let stockEntry = null;
    if (stockedRows.length > 0) {
      // Mismo generador que createMovement: un lote de números de la
      // secuencia, sin chocar con movimientos que se crean a la vez.
      const movementNumbers = await nextMovementNumbers(stockedRows.length);

      const today = new Date().toISOString().split('T')[0];
      const movementPayload = stockedRows.map((row, idx) => {
        const productId = skuToId.get(row.sku);
        const totalCost = row.quantity * row.unit_cost;
        return {
          tenant_id: tenantId,
          movement_number: movementNumbers[idx],
          movement_type: 'entrada',
          direction: 'in',
          movement_reason: 'initial_stock',
          reference_type: 'product',
          reference_id: productId,
          product_id: productId,
          warehouse_id: bulkWarehouseId,
          quantity: row.quantity,
          unit_cost: row.unit_cost,
          total_cost: totalCost,
          previous_stock: 0,
          new_stock: row.quantity,
          user_id: req.user.id,
          movement_date: today,
          notes: 'Stock inicial — importación masiva',
        };
      });

      for (let i = 0; i < movementPayload.length; i += BULK_CHUNK_SIZE) {
        await InventoryMovement.bulkCreate(movementPayload.slice(i, i + BULK_CHUNK_SIZE), { validate: true });
      }

      // Reflejar el stock/costo resultante en el producto -- para un producto
      // recién creado con stock previo 0, el promedio ponderado final es
      // directamente el costo de la fila (no hay stock previo que promediar).
      // UPDATE ... FROM (VALUES ...) en vez de un Product.update() por fila:
      // con miles de productos, un round-trip por fila reintroduce el mismo
      // problema de timeout que bulkCreate ya evita arriba.
      const { getCurrentSchema } = require('../../config/tenantContext');
      const schema = getCurrentSchema() || 'public';
      for (let i = 0; i < movementPayload.length; i += BULK_CHUNK_SIZE) {
        const chunk = movementPayload.slice(i, i + BULK_CHUNK_SIZE);
        const values = chunk.map((m) => `('${m.product_id}', ${Number(m.new_stock) || 0}, ${Number(m.unit_cost) || 0})`).join(',');
        await sequelize.query(`
          UPDATE "${schema}"."products" AS p
          SET current_stock = v.qty, available_stock = v.qty, average_cost = v.cost
          FROM (VALUES ${values}) AS v(id, qty, cost)
          WHERE p.id = v.id::uuid AND p.tenant_id = :tenantId
        `, { replacements: { tenantId } });
      }

      const totalValue = stockedRows.reduce((s, r) => s + r.quantity * r.unit_cost, 0);
      if (totalValue > 0) {
        try {
          const { generateBulkInventoryEntry } = require('../../services/accounting/autoEntries.service');
          stockEntry = await generateBulkInventoryEntry(
            { description: `Stock inicial — importación masiva (${stockedRows.length} producto(s))`, totalValue },
            tenantId,
            req.user.id
          );
        } catch (err) {
          console.error(`[accounting] Error generando asiento de stock inicial (import masivo) tenant ${tenantId}: ${err.message}`);
        }
      }
    }

    // ------- Equivalencias por código -------
    const { roots, normToOriginalSku } = buildClusters(linkableRows);
    const resolveProductId = (norm) => {
      const origSku = normToOriginalSku.get(norm);
      if (origSku && skuToId.has(origSku)) return skuToId.get(origSku);
      if (existingByNormalized.has(norm)) return existingByNormalized.get(norm);
      return null;
    };

    // Resolver todos los clusters con pareja válida ANTES de tocar la BD, para
    // poder consultar y crear todo en pocos lotes en vez de una consulta y un
    // insert por cluster (con miles de equivalencias eso también agota el timeout).
    const codigosNoEncontrados = new Set();
    const validClusters = []; // [{ memberIds: [{norm,id}], firstNorm }]
    for (const members of roots.values()) {
      if (members.size < 2) continue;
      const memberIds = [];
      for (const norm of members) {
        const id = resolveProductId(norm);
        if (id) memberIds.push({ norm, id });
        else codigosNoEncontrados.add(normToOriginalSku.get(norm) || norm);
      }
      if (memberIds.length >= 2) validClusters.push(memberIds);
    }

    let gruposCreados = 0;
    let gruposReusados = 0;
    let enlacesCreados = 0;
    const equivalenceErrors = [];

    if (validClusters.length > 0) {
      // Una sola consulta para saber a qué grupo(s) ya pertenece cada producto
      // involucrado, en vez de un findAll por cluster.
      const allMemberProductIds = [...new Set(validClusters.flatMap((m) => m.map((x) => x.id)))];
      const existingMemberships = [];
      for (let i = 0; i < allMemberProductIds.length; i += BULK_CHUNK_SIZE) {
        const idsChunk = allMemberProductIds.slice(i, i + BULK_CHUNK_SIZE);
        const found = await ProductEquivalenceGroupMember.findAll({
          where: { tenant_id: tenantId, product_id: { [Op.in]: idsChunk } },
        });
        existingMemberships.push(...found);
      }
      const groupsByProductId = new Map(); // product_id -> Set(group_id)
      for (const m of existingMemberships) {
        if (!groupsByProductId.has(m.product_id)) groupsByProductId.set(m.product_id, new Set());
        groupsByProductId.get(m.product_id).add(m.group_id);
      }

      // Para cada cluster, decidir si reutiliza un grupo existente o necesita uno nuevo.
      const clusterGroupId = new Array(validClusters.length).fill(null);
      const clustersNeedingNewGroup = [];
      for (let i = 0; i < validClusters.length; i++) {
        const memberIds = validClusters[i];
        let reuseGroupId = null;
        for (const { id } of memberIds) {
          const groups = groupsByProductId.get(id);
          if (groups && groups.size > 0) { reuseGroupId = [...groups][0]; break; }
        }
        if (reuseGroupId) {
          clusterGroupId[i] = reuseGroupId;
          gruposReusados++;
        } else {
          clustersNeedingNewGroup.push(i);
        }
      }

      // Crear en un solo bulkCreate todos los grupos nuevos que hacen falta.
      if (clustersNeedingNewGroup.length > 0) {
        const groupPayload = clustersNeedingNewGroup.map((i) => {
          const memberIds = validClusters[i];
          return {
            tenant_id: tenantId,
            name: `Equivalencia ${normToOriginalSku.get(memberIds[0].norm) || memberIds[0].norm}`,
            created_by: req.user.id,
          };
        });
        try {
          const createdGroups = await ProductEquivalenceGroup.bulkCreate(groupPayload, { returning: true, validate: true });
          createdGroups.forEach((group, idx) => {
            clusterGroupId[clustersNeedingNewGroup[idx]] = group.id;
            gruposCreados++;
          });
        } catch (err) {
          // Fallback fila por fila si el lote de grupos falla por algún motivo.
          for (let idx = 0; idx < groupPayload.length; idx++) {
            try {
              const group = await ProductEquivalenceGroup.create(groupPayload[idx]);
              clusterGroupId[clustersNeedingNewGroup[idx]] = group.id;
              gruposCreados++;
            } catch (rowErr) {
              const memberIds = validClusters[clustersNeedingNewGroup[idx]];
              equivalenceErrors.push({ skus: memberIds.map((m) => normToOriginalSku.get(m.norm) || m.norm), error: rowErr.message });
            }
          }
        }
      }

      // Armar todas las membresías a insertar (omitiendo las que ya existan
      // exactamente en el grupo destino) y crearlas en lotes.
      const membershipPayload = [];
      for (let i = 0; i < validClusters.length; i++) {
        const groupId = clusterGroupId[i];
        if (!groupId) continue; // el grupo nuevo falló arriba
        const memberIds = validClusters[i];
        const alreadyInThisGroup = new Set(existingMemberships.filter((m) => m.group_id === groupId).map((m) => m.product_id));
        let assignedReference = alreadyInThisGroup.size > 0; // si el grupo ya existía, no reasignar 'referencia'
        for (const { id } of memberIds) {
          if (alreadyInThisGroup.has(id)) continue;
          membershipPayload.push({
            tenant_id: tenantId,
            group_id: groupId,
            product_id: id,
            role: assignedReference ? 'equivalente' : 'referencia',
          });
          assignedReference = true;
        }
      }

      for (let i = 0; i < membershipPayload.length; i += BULK_CHUNK_SIZE) {
        const chunk = membershipPayload.slice(i, i + BULK_CHUNK_SIZE);
        try {
          await ProductEquivalenceGroupMember.bulkCreate(chunk, { validate: true });
          enlacesCreados += chunk.length;
        } catch (err) {
          for (const member of chunk) {
            try {
              await ProductEquivalenceGroupMember.create(member);
              enlacesCreados++;
            } catch (rowErr) {
              equivalenceErrors.push({ skus: [member.product_id], error: rowErr.message });
            }
          }
        }
      }
    }

    const allErrors = [...invalidRows.map((r) => ({ row: r.rowNumber, sku: r.sku || 'Sin código', name: r.name || 'Sin nombre', errors: r.errors })), ...categoryErrors, ...creationErrors];

    return res.status(201).json({
      success: true,
      message: 'Importación completada',
      data: {
        total_registros: rows.length,
        creados,
        omitidos_duplicados: skippedExisting.length,
        con_errores: invalidRows.length + categoryErrors.length + creationErrors.length,
        categorias_creadas: categoriasCreadas,
        columnas_ignoradas: ignoredColumns,
        grupos_equivalencia_creados: gruposCreados,
        grupos_equivalencia_reusados: gruposReusados,
        enlaces_equivalencia_creados: enlacesCreados,
        codigos_equivalencia_no_encontrados: [...codigosNoEncontrados].slice(0, MAX_REPORTED_ERRORS),
        errores_equivalencia: equivalenceErrors.slice(0, MAX_REPORTED_ERRORS),
        errores: allErrors.slice(0, MAX_REPORTED_ERRORS),
        errores_truncados: allErrors.length > MAX_REPORTED_ERRORS,
        stock_inicial_productos: stockedRows.length,
        asiento_stock_inicial_id: stockEntry?.id || null,
      },
    });
  } catch (error) {
    console.error('Error en bulkImportProducts:', error);
    res.status(500).json({ success: false, message: 'Error al importar productos' });
  }
};

module.exports = { bulkImportProducts };
