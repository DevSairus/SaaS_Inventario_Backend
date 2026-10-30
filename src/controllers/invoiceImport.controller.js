// backend/src/controllers/invoiceImport.controller.js
const AdmZip = require('adm-zip');
const { nextPurchaseNumber } = require('../services/inventory/purchaseNumber.service');
const { parseInvoiceXML, validateParsedData } = require('../services/invoiceXmlParser');
const { Purchase, PurchaseItem, Product, Supplier, ProductSupplier } = require('../models/inventory');
const { sequelize } = require('../config/database');
const { Op } = require('sequelize');
const { runWithTenantSchema } = require('../config/tenantContext');
const taxService = require('../services/taxService');
const { suggestedSalePrice, isValidMargin, marginRangeMessage } = require('../utils/salePricing');
const { inheritedMarginFor, getMarginMethod } = require('../services/inventory/productMargin.service');
const { bulkUpdateById } = require('../utils/bulkUpdate');

/**
 * Importar factura electrónica desde archivo ZIP
 *
 * El upload de archivo (multer/busboy, ver invoiceImport.routes.js) corre
 * entre tenantMiddleware y este controller, y rompe la propagación del
 * AsyncLocalStorage que tenantMiddleware usa para fijar el schema del
 * tenant (ver tenantContext.js) -- para cuando este handler arranca,
 * getCurrentSchema() ya da undefined, y todas las queries de acá abajo caen
 * silenciosamente a `public` en vez del schema real del tenant (se vio con
 * un tenant ya cortado: el insert de purchases fallaba con FK violation en
 * branch_id porque buscaba en public.branches en vez de en su propio
 * schema). Fix: re-fijar el contexto acá mismo con el schema_name que
 * tenantMiddleware ya dejó en req.tenant, sin depender de que el ALS
 * ambiental haya sobrevivido al upload.
 */
const importInvoice = async (req, res) => {
  if (req.tenant?.schema_name) {
    return runWithTenantSchema(req.tenant.schema_name, () => importInvoiceInner(req, res));
  }
  return importInvoiceInner(req, res);
};

class InvoiceImportError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Origen del XML: un ZIP subido (flujo de siempre) o un documento del
 * registro de documentos recibidos DIAN (dian_document_id) cuyo XML ya se
 * descargó con GetXmlByDocumentKey.
 * @returns {Promise<{ xml: string|null, pdf: Buffer|null, dianDocument: object|null }>}
 */
async function resolveXmlSource(req) {
  const dianDocumentId = req.body?.dian_document_id;
  if (dianDocumentId) {
    const { DianReceivedDocument } = require('../models');
    const doc = await DianReceivedDocument.findOne({ where: { id: dianDocumentId, tenant_id: req.user.tenant_id } });
    if (!doc) throw new InvoiceImportError('Documento DIAN no encontrado', 404);
    if (!doc.xml_content) {
      throw new InvoiceImportError('Este documento aún no tiene el XML: usa "Obtener detalle desde DIAN" o carga su ZIP', 400);
    }
    return { xml: doc.xml_content, pdf: null, dianDocument: doc };
  }
  if (!req.file) throw new InvoiceImportError('No se ha cargado ningún archivo', 400);
  const zipData = await extractZipContent(req.file.buffer);
  if (!zipData.xml) throw new InvoiceImportError('No se encontró archivo XML en el ZIP', 400);
  return { ...zipData, dianDocument: null };
}

/**
 * Tras crear la compra, marca como cargado el documento del registro DIAN
 * correspondiente (por id si vino de ahí, o por CUFE si se subió el ZIP de
 * una factura que ya estaba registrada desde el Excel). Así una futura carga
 * del Excel no la vuelve a mostrar como pendiente.
 */
async function linkReceivedDocument(tenant_id, purchase, dianDocumentId = null) {
  try {
    const { DianReceivedDocument } = require('../models');
    const where = dianDocumentId
      ? { id: dianDocumentId, tenant_id }
      : (purchase.cufe ? { tenant_id, cufe: purchase.cufe } : null);
    if (!where) return;
    await DianReceivedDocument.update(
      { status: 'loaded', purchase_id: purchase.id, supplier_id: purchase.supplier_id },
      { where }
    );
  } catch (e) {
    // El registro DIAN es informativo: un fallo aquí no debe tumbar la importación.
    console.warn('⚠️  No se pudo vincular el documento DIAN recibido:', e.message);
  }
}

// "Contado" / "Crédito" (texto del Excel DIAN) → 'cash' | 'credit' | null
function paymentFormFromText(text) {
  const t = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (t.includes('contado')) return 'cash';
  if (t.includes('credito')) return 'credit';
  return null;
}

/**
 * Núcleo de la importación: XML → proveedor, productos y compra en borrador.
 * Lo usan el flujo del ZIP (con las decisiones del modal en `opts`) y la carga
 * masiva desde el registro DIAN (sin decisiones: mapeo automático).
 */
async function importInvoiceFromXml(xmlContent, { tenant_id, user_id, branch_id }, opts = {}) {
  // Sin margen = los productos nuevos heredan el de su categoría (o el
  // global); si tampoco hay, 30 % propio como antes.
  const parsedMargin = parseFloat(opts.profit_margin);
  const profit_margin = Number.isFinite(parsedMargin) ? parsedMargin : null;
  const marginMethod = await getMarginMethod(tenant_id);
  if (profit_margin !== null && !isValidMargin(profit_margin, marginMethod)) {
    throw new InvoiceImportError(marginRangeMessage(marginMethod), 400);
  }
  const supplier_name_override = opts.supplier_name?.trim() || null;
  const removed_items = opts.removed_items || [];
  const shipping_cost = parseFloat(opts.shipping_cost) || 0;
  const discount_amount = parseFloat(opts.discount_amount) || 0;
  // Override de IVA por ítem: { "0": 19, "1": 0, "2": 5 } (índice original → porcentaje)
  const items_tax_overrides = opts.items_tax_overrides || {};
  // Decisiones del usuario en el modal para ítems sin mapeo exacto por código:
  // { "0": "<product_id>", "2": "CREATE_NEW" } (índice original → decisión).
  // Es la única vía por la que se guarda un mapeo código-proveedor nuevo (ver
  // processInvoiceItems) — un match automático por SKU interno o por nombre
  // aproximado nunca guarda el mapeo por sí solo.
  const manual_links = opts.manual_links || {};
  // Datos que el usuario definió en el modal para el producto a crear en
  // ítems marcados CREATE_NEW: { "2": { sku, barcode, name, category_id,
  // brand, unit_of_measure, price_includes_tax } } (índice original → datos).
  const new_product_data = opts.new_product_data || {};

  const invoiceData = await parseInvoiceXML(xmlContent);
  // Respaldo de la forma de pago cuando el XML no trae PaymentMeans/ID:
  // la columna "Forma de Pago" del Excel DIAN ("Contado" / "Crédito").
  const hint = paymentFormFromText(opts.payment_form_hint);
  if (hint) invoiceData.invoice.payment_form_hint = hint;
  const validation = validateParsedData(invoiceData);
  if (!validation.isValid) {
    throw new InvoiceImportError('Datos de factura inválidos', 400, { errors: validation.errors });
  }

  const transaction = await sequelize.transaction();
  try {
    // Verificar si la factura ya fue importada
    const invoiceNumber = invoiceData.invoice.number;
    const existingPurchase = await Purchase.findOne({
      where: { tenant_id, invoice_number: invoiceNumber },
      include: [{ model: Supplier, as: 'supplier' }],
      transaction
    });

    if (existingPurchase) {
      throw new InvoiceImportError('Esta factura ya fue importada anteriormente', 409, {
        error: 'DUPLICATE_INVOICE',
        data: {
          invoice_number: invoiceNumber,
          existing_purchase: {
            id: existingPurchase.id,
            purchase_number: existingPurchase.purchase_number,
            supplier_name: existingPurchase.supplier?.name,
            total_amount: existingPurchase.total_amount,
            created_at: existingPurchase.created_at
          }
        },
        existingPurchase,
      });
    }

    // Si el usuario editó el nombre del proveedor en el modal, usarlo
    const supplierData = supplier_name_override
      ? { ...invoiceData.supplier, name: supplier_name_override }
      : invoiceData.supplier;
    const supplier = await findOrCreateSupplier(supplierData, tenant_id, transaction);
    // Filtrar ítems que el usuario decidió excluir en el modal
    const filteredItems = invoiceData.items
      .map((item, originalIdx) => ({
        ...item,
        original_index: originalIdx, // para resolver manual_links[idx] tras el filtro
        tax_percentage: items_tax_overrides[originalIdx] !== undefined
          ? parseFloat(items_tax_overrides[originalIdx])
          : item.tax_percentage,
      }))
      .filter((_, idx) => !removed_items.includes(idx));

    // El IVA del XML se respeta tal cual; solo se recalcula si el usuario
    // cambió el porcentaje en el modal. Antes se recalculaba SIEMPRE con el %
    // leído, y una línea excluida (sin IVA en el XML) entraba con 19 %. El INC
    // del XML (no descontable) se conserva y suma al total.
    filteredItems.forEach(item => {
      const overridden = items_tax_overrides[item.original_index] !== undefined;
      if (overridden) {
        item.tax_amount = Math.round(item.subtotal * (item.tax_percentage / 100));
        item.iva_status = item.tax_percentage > 0 ? 'gravado' : (item.iva_status === 'excluido' ? 'excluido' : 'exento');
      }
      item.total = item.subtotal + (Number(item.tax_amount) || 0) + (Number(item.inc_amount) || 0);
    });

    const processedItems = await processInvoiceItems(filteredItems, tenant_id, supplier.id, transaction, profit_margin, manual_links, new_product_data);
    const purchase = await createPurchaseFromInvoice(
      { ...invoiceData, xmlContent: invoiceData.xmlContent || xmlContent },
      supplier,
      processedItems,
      tenant_id,
      user_id,
      transaction,
      shipping_cost,
      discount_amount,
      branch_id || null
    );

    await transaction.commit();
    return { purchase, supplier, processedItems, invoiceData };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    // Carrera entre dos importaciones concurrentes de la misma factura (doble
    // clic, reintento): ambas pasan el chequeo previo de duplicado (findOne)
    // antes de que la primera confirme, y la segunda choca acá contra el
    // índice único tenant_invoice_number_unique.
    if (error.name === 'SequelizeUniqueConstraintError' &&
        ['tenant_invoice_number_unique', 'purchases_tenant_cufe_unique'].includes(error.original?.constraint)) {
      throw new InvoiceImportError('Esta factura ya fue importada anteriormente', 409, { error: 'DUPLICATE_INVOICE' });
    }
    throw error;
  }
}

const importInvoiceInner = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const source = await resolveXmlSource(req);
    console.log('📄 XML encontrado, parseando...');

    const { purchase, supplier, processedItems, invoiceData } = await importInvoiceFromXml(
      source.xml,
      { tenant_id, user_id: req.user.id, branch_id: req.branch_id },
      {
        profit_margin: req.body.profit_margin,
        supplier_name: req.body.supplier_name,
        removed_items: JSON.parse(req.body.removed_items || '[]'),
        shipping_cost: req.body.shipping_cost,
        discount_amount: req.body.discount_amount,
        items_tax_overrides: JSON.parse(req.body.items_tax_overrides || '{}'),
        manual_links: JSON.parse(req.body.manual_links || '{}'),
        new_product_data: JSON.parse(req.body.new_product_data || '{}'),
        payment_form_hint: source.dianDocument?.payment_form || null,
      }
    );

    await linkReceivedDocument(tenant_id, purchase, source.dianDocument?.id || null);

    const completePurchase = await Purchase.findByPk(purchase.id, {
      include: [
        { model: Supplier, as: 'supplier' },
        {
          model: PurchaseItem,
          as: 'items',
          include: [{ model: Product, as: 'product' }]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Factura importada exitosamente',
      data: {
        purchase: completePurchase,
        summary: {
          supplier: supplier.name,
          invoice_number: invoiceData.invoice.number,
          items_count: processedItems.length,
          new_products_created: processedItems.filter(i => i.isNew).length,
          total_amount: purchase.total_amount
        }
      }
    });

  } catch (error) {
    if (error instanceof InvoiceImportError) {
      const { existingPurchase, ...payload } = error.payload || {};
      return res.status(error.status).json({ success: false, message: error.message, ...payload });
    }
    console.error('❌ Error importando factura:', error);
    res.status(500).json({
      success: false,
      message: 'Error al importar factura',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

/**
 * Vista previa de factura
 *
 * Mismo problema de ALS roto por el upload que importInvoice (ver comentario
 * arriba) -- se re-fija el schema acá también.
 */
const previewInvoice = async (req, res) => {
  if (req.tenant?.schema_name) {
    return runWithTenantSchema(req.tenant.schema_name, () => previewInvoiceInner(req, res));
  }
  return previewInvoiceInner(req, res);
};

const previewInvoiceInner = async (req, res) => {
  try {
    let zipData;
    try {
      zipData = await resolveXmlSource(req);
    } catch (e) {
      if (e instanceof InvoiceImportError) return res.status(e.status).json({ success: false, message: e.message });
      throw e;
    }

    const invoiceData = await parseInvoiceXML(zipData.xml);
    // Mismo respaldo que en la importación: "Forma de Pago" del Excel DIAN
    // si el XML no trae PaymentMeans/ID.
    if (!invoiceData.invoice.payment_form && zipData.dianDocument) {
      invoiceData.invoice.payment_form = paymentFormFromText(zipData.dianDocument.payment_form);
    }
    const validation = validateParsedData(invoiceData);

    // Verificar si la factura ya existe
    const tenant_id = req.user.tenant_id;
    const invoiceNumber = invoiceData.invoice.number;
    
    const existingPurchase = await Purchase.findOne({
      where: {
        tenant_id,
        invoice_number: invoiceNumber
      },
      include: [{ model: Supplier, as: 'supplier' }]
    });

    const isDuplicate = !!existingPurchase;
    let duplicateInfo = null;

    if (isDuplicate) {
      duplicateInfo = {
        purchase_number: existingPurchase.purchase_number,
        supplier_name: existingPurchase.supplier?.name,
        total_amount: existingPurchase.total_amount,
        status: existingPurchase.status,
        created_at: existingPurchase.created_at
      };
    }

    // Proveedor candidato de solo lectura (por tax_id, o por nombre aproximado si
    // no trae NIT) — en el preview puede que ese proveedor todavía no exista como
    // registro (puede ser su primera factura), así que NUNCA se crea aquí.
    const supplierCandidate = await findSupplierCandidate(invoiceData.supplier, tenant_id);

    // Por cada ítem, correr la misma cadena de búsqueda que processInvoiceItems()
    // (código exacto → SKU interno → nombre aproximado) pero sin crear ni guardar
    // nada — solo para sugerirle al frontend con qué producto vincularlo.
    const suggestions = await buildItemSuggestions(invoiceData.items, tenant_id, supplierCandidate?.id);
    const itemsWithSuggestions = invoiceData.items.map((item, idx) => ({ ...item, suggestion: suggestions[idx] }));

    res.json({
      success: true,
      data: {
        isValid: validation.isValid && !isDuplicate, // No válida si es duplicada
        errors: validation.errors,
        invoice: invoiceData.invoice,
        supplier: invoiceData.supplier,
        items: itemsWithSuggestions,
        totals: invoiceData.totals,
        hasPdf: !!zipData.pdf,
        isDuplicate: isDuplicate,
        duplicateInfo: duplicateInfo
      }
    });

  } catch (error) {
    console.error('Error en preview:', error);
    res.status(500).json({
      success: false,
      message: 'Error al procesar factura',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

// ============== FUNCIONES AUXILIARES ==============

async function extractZipContent(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    let xmlContent = null;
    let pdfContent = null;

    for (const entry of zipEntries) {
      const fileName = entry.entryName.toLowerCase();
      
      if (fileName.endsWith('.xml')) {
        xmlContent = entry.getData().toString('utf8');
      }
      
      if (fileName.endsWith('.pdf')) {
        pdfContent = entry.getData();
      }
    }

    return { xml: xmlContent, pdf: pdfContent };
  } catch (error) {
    throw new Error(`Error extrayendo ZIP: ${error.message}`);
  }
}

// Versión de solo lectura de findOrCreateSupplier, para el preview — en ese
// punto puede que el proveedor todavía no exista (primera factura de ese
// proveedor) y el preview NUNCA debe crear registros.
async function findSupplierCandidate(supplierData, tenant_id) {
  if (supplierData.tax_id) {
    const s = await Supplier.findOne({ where: { tenant_id, tax_id: supplierData.tax_id } });
    if (s) return s;
  }
  if (supplierData.name) {
    const s = await Supplier.findOne({
      where: { tenant_id, name: { [Op.iLike]: `%${supplierData.name}%` } },
    });
    if (s) return s;
  }
  return null;
}

// ── Emparejamiento de ítems con productos ───────────────────────────────────
// Cadena de búsqueda de cada ítem: código del proveedor ya mapeado → decisión
// del usuario en el modal → SKU interno igual al código → nombre aproximado →
// crear producto. Antes eran 2-6 consultas por ítem, una tras otra (una
// factura de 150 ítems podía pasar del límite de 30 s del frontend); ahora las
// lecturas van en bloque al principio (loadMatchData), los ítems se recorren
// en memoria en el mismo orden de siempre -- lo que crea o vincula un ítem lo
// ven los siguientes, igual que antes -- y las escrituras van en bloque al final.

const codeOf = (item) => (item.sku && !item.sku.startsWith('TEMP-') ? item.sku : null);
const namePattern = (item) => `%${item.name}%`;

// ILIKE de Postgres en JS (% = cualquier texto, _ = un carácter, \ escapa),
// para buscar por nombre entre los productos creados en esta misma importación.
function ilikeMatches(pattern, text) {
  const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, 'is').test(String(text ?? ''));
}

/**
 * Lecturas en bloque para emparejar ítems:
 *  - mappingByCode: código del proveedor → product_id (mapeos confirmados)
 *  - links: filas de product_suppliers de este proveedor para esos códigos y productos
 *  - byId / bySku: productos
 *  - fuzzyByItem: ítem → primer producto cuyo nombre contiene el del ítem, en
 *    orden físico de la tabla (el mismo que devolvía el findOne de antes)
 */
async function loadMatchData(items, tenant_id, supplier_id, { transaction, productIds = [], skus = [], fuzzyItems = items } = {}) {
  const codes = [...new Set(items.map(codeOf).filter(Boolean))];
  const codeRows = supplier_id && codes.length
    ? await ProductSupplier.findAll({ where: { tenant_id, supplier_id, supplier_code: codes }, transaction })
    : [];
  const mappingByCode = new Map(codeRows.map((m) => [m.supplier_code, m.product_id]));

  const ids = [...new Set([...codeRows.map((m) => m.product_id), ...productIds].filter(Boolean))];
  const byId = new Map(ids.length
    ? (await Product.findAll({ where: { id: ids }, transaction })).map((p) => [p.id, p])
    : []);

  const allSkus = [...new Set([...codes, ...skus].filter(Boolean))];
  const bySku = new Map(allSkus.length
    ? (await Product.findAll({ where: { tenant_id, sku: allSkus }, transaction })).map((p) => [p.sku, p])
    : []);

  const fuzzyByItem = new Map();
  if (fuzzyItems.length) {
    const table = sequelize.getQueryInterface().queryGenerator.quoteTable(Product.getTableName());
    const values = fuzzyItems.map((item, i) => `(${i}, ${sequelize.escape(namePattern(item))})`).join(', ');
    // LATERAL + LIMIT 1: cada nombre usa el índice trigram de products.name
    // por separado (un JOIN normal cruzaba todos los nombres contra toda la
    // tabla). ORDER BY ctid = el primero en orden físico, como el findOne de antes.
    const rows = await sequelize.query(`
      SELECT v.idx AS "matchIndex", p.*
        FROM (VALUES ${values}) AS v(idx, pattern)
        CROSS JOIN LATERAL (
          SELECT * FROM ${table} pp
           WHERE pp.tenant_id = ${sequelize.escape(tenant_id)} AND pp.name ILIKE v.pattern
           ORDER BY pp.ctid
           LIMIT 1
        ) p
    `, { model: Product, mapToModel: true, transaction });
    for (const p of rows) fuzzyByItem.set(fuzzyItems[p.get('matchIndex')], p);
  }

  return { codes, codeRows, mappingByCode, byId, bySku, fuzzyByItem };
}

// Misma cadena de búsqueda que processInvoiceItems() (código exacto → SKU
// interno → nombre aproximado), pero de solo lectura — arma la "suggestion"
// que el modal de importación usa para pre-cargar el selector de cada ítem.
// Antes era una búsqueda por ítem, todas a la vez (Promise.all): con facturas
// grandes agotaba el pool de conexiones.
async function buildItemSuggestions(items, tenant_id, supplierId) {
  const { mappingByCode, byId, bySku, fuzzyByItem } = await loadMatchData(items, tenant_id, supplierId);
  return items.map((item) => {
    const code = codeOf(item);
    if (code && supplierId && mappingByCode.has(code)) {
      const product = byId.get(mappingByCode.get(code));
      if (product) return { product_id: product.id, product_name: product.name, match_type: 'code_exact' };
    }
    if (code) {
      const product = bySku.get(code);
      if (product) return { product_id: product.id, product_name: product.name, match_type: 'sku_internal' };
    }
    const product = fuzzyByItem.get(item);
    if (product) return { product_id: product.id, product_name: product.name, match_type: 'name_fuzzy' };
    return null;
  });
}

async function findOrCreateSupplier(supplierData, tenant_id, transaction) {
  let supplier = null;
  
  if (supplierData.tax_id) {
    supplier = await Supplier.findOne({
      where: { tenant_id, tax_id: supplierData.tax_id },
      transaction
    });
  }

  if (!supplier && supplierData.name) {
    supplier = await Supplier.findOne({
      where: {
        tenant_id,
        name: { [Op.iLike]: `%${supplierData.name}%` }
      },
      transaction
    });
  }

  if (supplier) {
    const updateData = {};
    if (supplierData.email) updateData.email = supplierData.email;
    if (supplierData.phone) updateData.phone = supplierData.phone;
    if (supplierData.address) updateData.address = supplierData.address;
    
    if (Object.keys(updateData).length > 0) {
      await supplier.update(updateData, { transaction });
    }
    
    return supplier;
  }

  supplier = await Supplier.create({
    tenant_id,
    name: supplierData.name || 'Proveedor Importado',
    business_name: supplierData.name || 'Proveedor Importado', // Razón social
    tax_id: supplierData.tax_id,
    email: supplierData.email,
    phone: supplierData.phone,
    address: supplierData.address,
    country: 'Colombia', // Por defecto Colombia para facturas DIAN
    is_active: true
  }, { transaction });

  return supplier;
}

async function processInvoiceItems(items, tenant_id, supplier_id, transaction, profit_margin = null, manualLinks = {}, newProductData = {}) {
  // manual_links llega con claves string ("0", "1"...) porque viene de JSON.parse
  // sobre un objeto armado en el frontend con índices originales del array.
  const linkOf = (item) => manualLinks[String(item.original_index)];
  // Datos que el usuario definió en el panel "Crear producto nuevo" del
  // modal (código, referencia, nombre, categoría, marca, unidad, IVA
  // incluido) — permiten dejar el producto bien organizado desde acá en
  // vez de tener que editarlo después.
  const overridesOf = (item) => newProductData[String(item.original_index)] || {};

  const { codes, codeRows, mappingByCode, byId, bySku, fuzzyByItem } = await loadMatchData(items, tenant_id, supplier_id, {
    transaction,
    productIds: items.map(linkOf).filter((l) => l && l !== 'CREATE_NEW'),
    skus: items.map((item) => overridesOf(item).sku?.trim()),
    // Solo los ítems sin decisión del usuario pueden caer al nombre aproximado.
    fuzzyItems: items.filter((item) => !linkOf(item)),
  });

  // Filas de product_suppliers de este proveedor que pueden tocarse al
  // guardar mapeos: las de los códigos de la factura y las de los productos
  // ya existentes que se pueden vincular (índice único producto+proveedor).
  const knownIds = [...new Set([...byId.keys(), ...[...bySku.values()].map((p) => p.id), ...[...fuzzyByItem.values()].map((p) => p.id)])];
  const productRows = knownIds.length
    ? await ProductSupplier.findAll({ where: { tenant_id, supplier_id, product_id: knownIds }, transaction })
    : [];
  const linkByProduct = new Map();
  const codeOwner = new Map(); // código del proveedor → fila que lo tiene (índice único parcial)
  for (const row of [...codeRows, ...productRows]) {
    linkByProduct.set(row.product_id, row);
    if (row.supplier_code) codeOwner.set(row.supplier_code, row);
  }
  const dirtyLinks = new Set();
  const newLinks = [];

  // Guardar/actualizar el mapeo código-proveedor → producto. Reutiliza la
  // fila si ya existe (por ejemplo, creada antes al confirmar una compra — ver
  // purchases.controller.js) para no pisar last_price/last_purchase_date.
  // Índice único parcial (tenant_id, supplier_id, supplier_code): si ese
  // código de proveedor ya está vinculado a OTRO producto no se guarda y la
  // importación sigue — el ítem ya quedó vinculado al producto correcto, solo
  // no se "recuerda" el código para la próxima vez. Se verifica en memoria
  // antes de escribir: un INSERT que choca dejaría la transacción abortada.
  const saveSupplierMapping = (product, supplier_code, supplier_description) => {
    let row = linkByProduct.get(product.id);
    const owner = codeOwner.get(supplier_code);
    if (owner && owner !== row) {
      console.warn(`⚠️  No se pudo guardar el mapeo de código "${supplier_code}": ya está vinculado a otro producto.`);
      return;
    }
    if (row) {
      if (row.supplier_code && row.supplier_code !== supplier_code) {
        codeOwner.delete(row.supplier_code);
        mappingByCode.delete(row.supplier_code);
      }
      row.supplier_code = supplier_code;
      row.supplier_description = supplier_description;
      if (!row.isNewLink) dirtyLinks.add(row);
    } else {
      row = { id: require('crypto').randomUUID(), product_id: product.id, supplier_code, supplier_description, isNewLink: true };
      linkByProduct.set(product.id, row);
      newLinks.push(row);
    }
    codeOwner.set(supplier_code, row);
    mappingByCode.set(supplier_code, product.id);
  };

  const created = [];      // productos nuevos de esta importación, en orden
  const pendingSku = [];   // nuevos sin código propio: SKU autogenerado al final
  const marginCache = new Map(); // margen heredado por categoría (no cambia durante la importación)
  const marginMethod = await getMarginMethod(tenant_id, transaction);
  const entries = [];

  for (const item of items) {
    let product = null;
    let isNew = false;
    let matchType = null;

    const code = codeOf(item);
    const manualLink = linkOf(item);

    // 1) ¿Ya existe un mapeo tenant+proveedor+código_proveedor? Es la ÚNICA vía
    //    que se aplica sola, sin pasar por el usuario — el mapeo ya fue
    //    confirmado en una importación anterior.
    if (code && mappingByCode.has(code)) {
      product = byId.get(mappingByCode.get(code)) || null;
      if (product) matchType = 'code_exact';
    }

    // 2) Decisión del usuario en el modal de importación (aceptó una sugerencia,
    //    la cambió, o pidió crear un producto nuevo) — es la otra vía válida
    //    para terminar vinculando el ítem, y la única que se guarda como mapeo.
    if (!product && manualLink && manualLink !== 'CREATE_NEW') {
      product = byId.get(manualLink) || null;
      if (product) matchType = 'manual';
    }

    // 3) Fallback automático heredado (llamadas directas al endpoint sin pasar
    //    por el modal, o sin decisión para este ítem): SKU interno igual al código.
    if (!product && !manualLink && code) {
      product = bySku.get(code) || null;
      if (product) matchType = 'sku_internal';
    }

    // 4) Fallback automático heredado: nombre aproximado (primero entre los
    //    productos que ya existían, después entre los creados en esta importación).
    if (!product && !manualLink) {
      product = fuzzyByItem.get(item) || created.find((p) => ilikeMatches(namePattern(item), p.name)) || null;
      if (product) matchType = 'name_fuzzy';
    }

    // 5) Crear producto nuevo — disparado tanto por "no se encontró nada" como
    //    por la decisión explícita CREATE_NEW. Se arma en memoria y se inserta
    //    con los demás al final.
    if (!product) {
      const overrides = overridesOf(item);

      let newSku = overrides.sku?.trim() || code;
      if (newSku && bySku.has(newSku)) newSku = null; // el código elegido ya existe: caer a autogenerado

      const categoryId = overrides.category_id || null;
      let inheritedMargin = null;
      if (profit_margin === null) {
        if (!marginCache.has(categoryId)) marginCache.set(categoryId, await inheritedMarginFor(tenant_id, categoryId, transaction));
        inheritedMargin = marginCache.get(categoryId);
      }
      const itemMargin = profit_margin !== null ? profit_margin : (inheritedMargin ?? 30);

      product = Product.build({
        tenant_id,
        product_type: 'simple', // valor válido según CHECK constraint de la DB
        sku: newSku,
        barcode: overrides.barcode?.trim() || newSku,  // por defecto, código de barras = mismo SKU
        name: overrides.name?.trim() || item.name,
        category_id: categoryId,
        brand: overrides.brand?.trim() || null,
        unit_of_measure: overrides.unit_of_measure || 'unit',
        average_cost: item.unit_price,
        base_price: suggestedSalePrice(item.unit_price, itemMargin, {
          price_includes_tax: !!overrides.price_includes_tax,
          has_tax: item.tax_percentage > 0,
          tax_percentage: item.tax_percentage || 0,
          tax_config: { iva_status: item.iva_status },
        }, marginMethod) ?? 0,
        profit_margin_percentage: itemMargin,
        margin_inherited: profit_margin === null && inheritedMargin !== null,
        current_stock: 0,
        min_stock: 1,
        track_inventory: true,
        is_active: true,
        has_tax: item.tax_percentage > 0,
        tax_percentage: item.tax_percentage || 0,
        // Excluido (sin IVA en la factura) o exento (IVA 0 %): así queda el
        // producto para sus ventas, en vez de un 19 % por defecto.
        tax_config: {
          iva_status: item.iva_status || (item.tax_percentage > 0 ? 'gravado' : 'exento'),
          iva: { enabled: item.tax_percentage > 0, rate: item.tax_percentage || 0 },
          inc: { enabled: false, rate: 0 },
          ica: { enabled: false, rate: 0 },
        },
        price_includes_tax: !!overrides.price_includes_tax
      });
      if (newSku) bySku.set(newSku, product);
      else pendingSku.push({ product, baseName: overrides.name?.trim() || item.name, barcodeFromSku: !overrides.barcode?.trim() });
      byId.set(product.id, product);
      created.push(product);

      isNew = true;
      matchType = manualLink === 'CREATE_NEW' ? 'new_confirmed' : 'new';
    }

    // 6) Guardar/actualizar el mapeo código-proveedor → producto SOLO cuando la
    //    decisión vino confirmada explícitamente por el usuario (manual_links).
    //    Un match automático por SKU interno o por nombre (pasos 3 y 4) NUNCA
    //    guarda el mapeo por sí solo — así, si el match automático estaba
    //    equivocado, no queda "grabado" para las próximas importaciones.
    if (code && manualLink !== undefined) {
      saveSupplierMapping(product, code, item.name);
    }

    entries.push({ item, product, isNew, matchType });
  }

  await assignGeneratedSkus(pendingSku, tenant_id, transaction, new Set(bySku.keys()));
  const replaced = await insertNewProducts(created, tenant_id, transaction);
  for (const entry of entries) {
    const recovered = replaced.get(entry.product);
    if (recovered) Object.assign(entry, { product: recovered, isNew: false, matchType: 'sku_race_recovered' });
  }

  // Mapeos código-proveedor: un UPDATE y un INSERT para todos.
  await bulkUpdateById(ProductSupplier, [...dirtyLinks].map((row) => ({
    id: row.id, supplier_code: row.supplier_code, supplier_description: row.supplier_description,
  })), ['supplier_code', 'supplier_description'], { transaction });
  if (newLinks.length) {
    await ProductSupplier.bulkCreate(newLinks.map((row) => ({
      id: row.id,
      tenant_id,
      supplier_id,
      product_id: (replaced.get(byId.get(row.product_id)) || { id: row.product_id }).id,
      supplier_code: row.supplier_code,
      supplier_description: row.supplier_description,
    })), { transaction });
  }

  return entries.map(({ item, product, isNew, matchType }) => ({
    product_id: product.id,
    product_name: product.name,
    product_sku: product.sku,
    unit_of_measure: product.unit_of_measure || 'unit',
    quantity: item.quantity,
    unit_cost: item.unit_price,
    tax_percentage: item.tax_percentage,
    tax_amount: item.tax_amount,
    inc_rate: Number(item.inc_rate) || 0,
    inc_amount: Number(item.inc_amount) || 0,
    subtotal: item.subtotal,
    total: item.total,
    isNew: isNew,
    match_type: matchType
  }));
}

// SKU autogenerado (3 primeras letras del nombre + 6 dígitos de la hora, con
// -1, -2... si ya existe) para los productos nuevos sin código, verificando
// los choques contra la BD en bloque en vez de una consulta por candidato.
async function assignGeneratedSkus(pending, tenant_id, transaction, usedSkus) {
  const timestamp = Date.now().toString().slice(-6);
  let unresolved = pending.map((p) => ({ ...p, base: `${p.baseName.substring(0, 3).toUpperCase()}-${timestamp}`, counter: 0 }));
  const candidate = (s) => (s.counter ? `${s.base}-${s.counter}` : s.base);
  while (unresolved.length) {
    const inDb = new Set((await Product.findAll({
      where: { tenant_id, sku: [...new Set(unresolved.map(candidate))] },
      attributes: ['sku'],
      transaction,
    })).map((p) => p.sku));
    const next = [];
    for (const s of unresolved) {
      const sku = candidate(s);
      if (inDb.has(sku) || usedSkus.has(sku)) {
        s.counter++;
        next.push(s);
        continue;
      }
      s.product.sku = sku;
      if (s.barcodeFromSku) s.product.barcode = sku;
      usedSkus.add(sku);
    }
    unresolved = next;
  }
}

// Inserta los productos nuevos en un solo INSERT. Usamos un savepoint (nested
// transaction sobre la misma transacción) porque en Postgres un error dentro
// de una transacción la deja abortada para cualquier query posterior -- si
// dos importaciones concurrentes (doble click, reintento) generan el mismo SKU
// para el mismo tenant, sin el savepoint no podríamos recuperar la
// transacción. En ese caso se reintenta producto por producto, como antes:
// el que choca reutiliza el producto que ya creó la otra importación.
// Devuelve Map producto armado → producto existente que lo reemplazó.
async function insertNewProducts(products, tenant_id, transaction) {
  const replaced = new Map();
  if (!products.length) return replaced;
  try {
    await sequelize.transaction({ transaction }, (t) => Product.bulkCreate(
      products.map((p) => p.get({ plain: true })), { transaction: t, validate: true }
    ));
    return replaced;
  } catch (err) {
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
  }
  for (const product of products) {
    try {
      await sequelize.transaction({ transaction }, (t) => Product.create(product.get({ plain: true }), { transaction: t }));
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      // Otra importación concurrente ganó la carrera y ya creó el producto
      // con este mismo SKU: lo reutilizamos en vez de tumbar la importación.
      const existing = await Product.findOne({ where: { tenant_id, sku: product.sku }, transaction });
      if (!existing) throw err;
      replaced.set(product, existing);
    }
  }
  return replaced;
}

async function createPurchaseFromInvoice(invoiceData, supplier, items, tenant_id, user_id, transaction, shipping_cost = 0, discount_amount = 0, branch_id = null) {
  const subtotal     = items.reduce((sum, item) => sum + parseFloat(item.subtotal), 0);
  const tax_amount   = items.reduce((sum, item) => sum + parseFloat(item.tax_amount), 0);
  // INC y otros tributos no descontables: suman al total y al costo, no a tax_amount (IVA).
  const inc_total    = items.reduce((sum, item) => sum + (parseFloat(item.inc_amount) || 0), 0);
  const total_amount = subtotal + tax_amount + inc_total + shipping_cost - discount_amount;

  // Plazo/fecha de pago, en orden de prioridad:
  //  0. Forma de pago CONTADO (PaymentMeans/ID=1 en el XML o, si el XML no la
  //     trae, "Forma de Pago" del Excel DIAN): vence el mismo día de emisión.
  //     Queda PENDIENTE, no pagada — "contado" en la DIAN no prueba que ya se
  //     pagó; el pago se registra al confirmar la compra.
  //  1. Fecha de vencimiento que ya trae la propia factura XML
  //     (PaymentMeans/PaymentDueDate, o cbc:DueDate)
  //  2. Calculada a partir del plazo por defecto configurado en el proveedor
  //  3. Sin plazo conocido → queda pendiente sin fecha (se puede editar a mano)
  const purchase_date = invoiceData.invoice.date || new Date();
  const paymentForm = invoiceData.invoice.payment_form || invoiceData.invoice.payment_form_hint || null;
  let due_date = null;
  let payment_terms = null;
  let forceCashPending = false;

  if (paymentForm === 'cash') {
    due_date = String(purchase_date).slice(0, 10);
    payment_terms = 0;
    forceCashPending = true;
  } else if (invoiceData.invoice.due_date) {
    due_date = invoiceData.invoice.due_date;
    payment_terms = Math.round((new Date(due_date) - new Date(purchase_date)) / (1000 * 60 * 60 * 24));
  } else if (supplier.payment_terms !== null && supplier.payment_terms !== undefined) {
    payment_terms = supplier.payment_terms;
    if (payment_terms > 0) {
      const base = new Date(purchase_date);
      base.setDate(base.getDate() + payment_terms);
      due_date = base.toISOString().split('T')[0];
    }
  }

  // Plazo 0 (o factura ya vencida el mismo día de emisión) = compra de contado:
  // se marca pagada de inmediato y no debe aparecer en cuentas por pagar.
  const isCash = payment_terms === 0 && !forceCashPending;

  // Retenciones por defecto del proveedor (conceptos marcados "aplicar por
  // defecto" en su ficha). La compra queda en borrador, así que el usuario
  // puede ajustar conceptos/bases desde el formulario antes de confirmarla.
  const { Tenant } = require('../models');
  const tenantForRetentions = await Tenant.findByPk(tenant_id, { attributes: ['tax_config'], transaction });
  const { computePurchaseRetentions } = require('../services/retentionEngine.service');
  const retentions = await computePurchaseRetentions({
    tenantId: tenant_id,
    taxConfig: tenantForRetentions?.tax_config || {},
    supplier,
    items: items.map(i => ({ product_id: i.product_id, subtotal: i.subtotal, tax_amount: i.tax_amount })),
    discount: Number(discount_amount) || 0, // el descuento general baja la base
    transaction,
  });
  const tax_breakdown = taxService.buildTaxBreakdown(
    items.map(i => ({ subtotal: i.subtotal, tax_amount: i.tax_amount, tax_percentage: i.tax_percentage, inc_rate: i.inc_rate, inc_amount: i.inc_amount })),
    retentions
  );

  // generatePurchaseNumber lee el último número y le suma 1 -- no es atómico,
  // así que dos importaciones concurrentes (mismo problema que ya vimos con el
  // SKU de producto) pueden calcular el mismo purchase_number y la segunda
  // choca contra el índice único (tenant_id, purchase_number). Reintentamos
  // con un savepoint: si choca, generamos el siguiente número disponible y
  // probamos de nuevo, en vez de tumbar toda la importación.
  let purchase;
  let attempts = 0;
  while (true) {
    const purchaseNumber = await generatePurchaseNumber(tenant_id, transaction);
    try {
      purchase = await sequelize.transaction({ transaction }, (t) => Purchase.create({
        tenant_id,
        branch_id,
        purchase_number: purchaseNumber,
        supplier_id: supplier.id,
        purchase_date,
        expected_delivery_date: invoiceData.invoice.due_date || new Date(),
        due_date: isCash ? null : due_date,
        payment_terms,
        payment_status: isCash ? 'paid' : 'pending',
        // Contado: se paga el neto (total - retenciones), con su registro de
        // pago — el asiento del pago se genera al confirmar la compra.
        paid_amount: isCash ? Math.round((total_amount - retentions.total) * 100) / 100 : 0,
        payment_history: isCash
          ? [{
            ...require('../services/inventory/purchasePayments.service').newPaymentRecord({
              date: purchase_date, amount: Math.round((total_amount - retentions.total) * 100) / 100,
              method: 'Efectivo', user_id, notes: 'Compra de contado',
            }),
            source: 'creation_cash',
          }]
          : [],
        subtotal,
        tax_amount,
        discount_amount,
        shipping_cost,
        total_amount,
        status: 'draft',
        notes: `Importada desde factura electrónica: ${invoiceData.invoice.number}`,
        invoice_number: invoiceData.invoice.number,
        created_by: user_id,
        // RADIAN (ver RADIAN-Analisis-y-Plan.md §3.1 y §5.1): sin estos tres
        // campos no se puede emitir ningún evento sobre esta compra. cufe
        // puede venir null si el XML no traía cbc:UUID (formato no-DIAN) —
        // el evento 030 queda bloqueado hasta que se complete manualmente.
        cufe: invoiceData.invoice.cufe || null,
        dian_issue_date: invoiceData.invoice.date || null,
        dian_issue_time: invoiceData.invoice.issue_time || null,
        supplier_xml: invoiceData.xmlContent || null,
        ...taxService.purchaseRetentionFields(retentions),
        tax_breakdown,
      }, { transaction: t }));
      break;
    } catch (err) {
      // Solo reintentamos la colisión de purchase_number (el número calculado
      // por generatePurchaseNumber ya no era el siguiente disponible). Una
      // colisión de invoice_number (índice tenant_invoice_number_unique) es
      // una factura duplicada de verdad -- no tiene sentido reintentar, se
      // relanza para que el catch de importInvoiceInner la convierta en 409.
      attempts++;
      const isPurchaseNumberClash = err.name === 'SequelizeUniqueConstraintError'
        && err.original?.constraint === 'tenant_purchase_number_unique';
      if (!isPurchaseNumberClash || attempts >= 5) throw err;
    }
  }

  // Un solo INSERT para todas las líneas (antes uno por línea). bulkCreate no
  // corre el hook beforeValidate de PurchaseItem: line_total se fija acá.
  await PurchaseItem.bulkCreate(items.map((item, index) => ({
    tenant_id,
    purchase_id: purchase.id,
    line_number: index + 1,
    product_id: item.product_id,
    product_name: item.product_name,
    product_sku: item.product_sku,
    unit_of_measure: item.unit_of_measure || 'unit',
    quantity: item.quantity,
    unit_cost: item.unit_cost,
    tax_rate: item.tax_percentage,
    tax_amount: item.tax_amount,
    inc_rate: item.inc_rate || 0,
    inc_amount: item.inc_amount || 0,
    subtotal: item.subtotal,
    total: item.total,
    line_total: item.total,
  })), { transaction, validate: true });

  return purchase;
}

// Mismo generador que la compra manual (ver purchaseNumber.service.js): antes
// este rellenaba a 4 dígitos y el manual a 5, y mezclados rompían la
// numeración.
async function generatePurchaseNumber(tenant_id, transaction) {
  return nextPurchaseNumber(tenant_id, transaction);
}

// ============== EXPORTS ==============
module.exports = {
  importInvoice,
  previewInvoice,
  importInvoiceFromXml,
  linkReceivedDocument,
  InvoiceImportError,
};