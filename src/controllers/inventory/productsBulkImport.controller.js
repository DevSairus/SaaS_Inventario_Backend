const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const { Product, ProductEquivalenceGroup, ProductEquivalenceGroupMember } = require('../../models/inventory');

const REQUIRED_COLUMNS = ['Código*', 'Nombre*'];
const MAX_REPORTED_ERRORS = 300;

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

const mapUnitOfMeasure = (unit) => {
  if (!unit) return 'unit';
  const normalized = unit.toString().toLowerCase().trim();
  return UNIT_OF_MEASURE_MAP[normalized] || 'unit';
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

// ExcelJS puede devolver fórmulas/rich text en vez de un string plano.
function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
  }
  return String(value);
}

async function readExcelRows(buffer) {
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
      if (text !== '') hasValue = true;
    });
    if (hasValue) rows.push({ rowNumber, data });
  });

  return { headers, rows };
}

function parseRow(rowNumber, data) {
  const errors = [];
  const sku = (data['Código*'] || '').trim();
  const name = (data['Nombre*'] || '').trim();
  if (!sku) errors.push('Código es requerido');
  if (!name) errors.push('Nombre es requerido');

  const averageCostRaw = parseFloat(data['Costo Promedio']);
  const average_cost = !isNaN(averageCostRaw) && averageCostRaw >= 0 ? averageCostRaw : 0;

  const marginRaw = parseFloat(data['Margen Utilidad (%)']);
  const profit_margin_percentage = !isNaN(marginRaw) && marginRaw >= 0 ? marginRaw : 30;

  const priceRaw = parseFloat(data['Precio Venta']);
  let base_price;
  if (!isNaN(priceRaw) && priceRaw >= 0) {
    base_price = priceRaw;
  } else if (average_cost > 0) {
    base_price = average_cost * (1 + profit_margin_percentage / 100);
  } else {
    base_price = 0;
  }

  const quantityRaw = parseFloat(data['Cantidad']);
  const current_stock = !isNaN(quantityRaw) && quantityRaw >= 0 ? quantityRaw : 0;

  const unit_of_measure = mapUnitOfMeasure(data['Unidad']);

  const equivalentCodesRaw = data['Equivalente(s)'] || '';
  const equivalent_codes = equivalentCodesRaw
    .split(/[|,;]/)
    .map((c) => c.trim())
    .filter(Boolean);

  return { rowNumber, sku, name, average_cost, profit_margin_percentage, base_price, current_stock, unit_of_measure, equivalent_codes, errors };
}

const normalizeSku = (s) => s.trim().toUpperCase();

// Marca duplicados de código dentro del mismo archivo (mutan `errors` in-place)
function markDuplicatesInFile(parsedRows) {
  const seen = new Map();
  for (const row of parsedRows) {
    if (!row.sku) continue;
    const key = normalizeSku(row.sku);
    if (seen.has(key)) {
      row.errors.push(`Código duplicado en el archivo (fila ${seen.get(key)})`);
    } else {
      seen.set(key, row.rowNumber);
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

// GET/POST /products/bulk-import?dry_run=true|false
const bulkImportProducts = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (req.user.role !== 'super_admin' && !req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'Debe adjuntar un archivo Excel' });

    const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === 'true';
    const tenantId = req.user.role === 'super_admin' ? (req.body.tenant_id || null) : req.user.tenant_id;
    if (!tenantId) return res.status(400).json({ success: false, message: 'Debe indicar tenant_id' });

    let headers, rows;
    try {
      ({ headers, rows } = await readExcelRows(req.file.buffer));
    } catch (err) {
      return res.status(400).json({ success: false, message: 'No se pudo leer el archivo Excel: ' + err.message });
    }

    const missingColumns = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
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
        },
      });
    }

    const parsedRows = rows.map((r) => parseRow(r.rowNumber, r.data));
    markDuplicatesInFile(parsedRows);

    const validRows = parsedRows.filter((r) => r.errors.length === 0);
    const invalidRows = parsedRows.filter((r) => r.errors.length > 0);

    // Todos los productos del tenant, para detectar duplicados y resolver
    // códigos de equivalencia que apunten a productos que ya existían antes
    // de esta carga (no forman parte del archivo).
    const allTenantProducts = await Product.findAll({ where: { tenant_id: tenantId }, attributes: ['id', 'sku'] });
    const existingBySkuExact = new Map(allTenantProducts.map((p) => [p.sku, p.id]));
    const existingByNormalized = new Map(allTenantProducts.map((p) => [normalizeSku(p.sku), p.id]));

    const toCreate = [];
    const skippedExisting = [];
    for (const row of validRows) {
      if (existingBySkuExact.has(row.sku)) skippedExisting.push(row);
      else toCreate.push(row);
    }

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
        },
      });
    }

    // ------- Importación real -------
    const skuToId = new Map(existingBySkuExact);
    const creationErrors = [];
    let creados = 0;

    for (const row of toCreate) {
      try {
        const product = await Product.create({
          tenant_id: tenantId,
          sku: row.sku,
          name: row.name,
          unit_of_measure: row.unit_of_measure,
          average_cost: row.average_cost,
          base_price: row.base_price,
          profit_margin_percentage: row.profit_margin_percentage,
          product_type: 'simple',
          current_stock: row.current_stock,
          reserved_stock: 0,
          available_stock: row.current_stock,
          min_stock: 0,
          track_inventory: true,
          is_active: true,
          has_tax: true,
          tax_percentage: 19,
          price_includes_tax: false,
          tax_config: { iva: { enabled: true, rate: 19 }, inc: { enabled: false, rate: 0 }, ica: { enabled: false, rate: 0 } },
        });
        skuToId.set(row.sku, product.id);
        creados++;
      } catch (err) {
        creationErrors.push({ row: row.rowNumber, sku: row.sku, name: row.name, errors: [err.message || 'Error al crear el producto'] });
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

    let gruposCreados = 0;
    let gruposReusados = 0;
    let enlacesCreados = 0;
    const codigosNoEncontrados = new Set();
    const equivalenceErrors = [];

    for (const members of roots.values()) {
      if (members.size < 2) continue;

      const memberIds = [];
      for (const norm of members) {
        const id = resolveProductId(norm);
        if (id) memberIds.push({ norm, id });
        else codigosNoEncontrados.add(normToOriginalSku.get(norm) || norm);
      }
      if (memberIds.length < 2) continue;

      try {
        const existingMemberships = await ProductEquivalenceGroupMember.findAll({
          where: { tenant_id: tenantId, product_id: { [Op.in]: memberIds.map((m) => m.id) } },
        });

        let groupId;
        if (existingMemberships.length > 0) {
          groupId = existingMemberships[0].group_id;
          gruposReusados++;
        } else {
          const group = await ProductEquivalenceGroup.create({
            tenant_id: tenantId,
            name: `Equivalencia ${normToOriginalSku.get(memberIds[0].norm) || memberIds[0].norm}`,
            created_by: req.user.id,
          });
          groupId = group.id;
          gruposCreados++;
        }

        // Solo se omite un miembro si YA pertenece exactamente a este grupo
        // (un producto puede pertenecer a varios grupos distintos a la vez).
        const alreadyInThisGroup = new Set(existingMemberships.filter((m) => m.group_id === groupId).map((m) => m.product_id));

        for (let i = 0; i < memberIds.length; i++) {
          const { id } = memberIds[i];
          if (alreadyInThisGroup.has(id)) continue;
          try {
            await ProductEquivalenceGroupMember.create({
              tenant_id: tenantId,
              group_id: groupId,
              product_id: id,
              role: existingMemberships.length === 0 && i === 0 ? 'referencia' : 'equivalente',
            });
            enlacesCreados++;
          } catch (memberErr) {
            equivalenceErrors.push({ skus: [...members].map((n) => normToOriginalSku.get(n) || n), error: memberErr.message });
          }
        }
      } catch (err) {
        equivalenceErrors.push({ skus: [...members].map((n) => normToOriginalSku.get(n) || n), error: err.message });
      }
    }

    const allErrors = [...invalidRows.map((r) => ({ row: r.rowNumber, sku: r.sku || 'Sin código', name: r.name || 'Sin nombre', errors: r.errors })), ...creationErrors];

    return res.status(201).json({
      success: true,
      message: 'Importación completada',
      data: {
        total_registros: rows.length,
        creados,
        omitidos_duplicados: skippedExisting.length,
        con_errores: invalidRows.length + creationErrors.length,
        grupos_equivalencia_creados: gruposCreados,
        grupos_equivalencia_reusados: gruposReusados,
        enlaces_equivalencia_creados: enlacesCreados,
        codigos_equivalencia_no_encontrados: [...codigosNoEncontrados].slice(0, MAX_REPORTED_ERRORS),
        errores: allErrors.slice(0, MAX_REPORTED_ERRORS),
        errores_truncados: allErrors.length > MAX_REPORTED_ERRORS,
      },
    });
  } catch (error) {
    console.error('Error en bulkImportProducts:', error);
    res.status(500).json({ success: false, message: 'Error al importar productos' });
  }
};

module.exports = { bulkImportProducts };
