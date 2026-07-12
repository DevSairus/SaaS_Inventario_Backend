// backend/src/controllers/invoiceImport.controller.js
const AdmZip = require('adm-zip');
const { parseInvoiceXML, validateParsedData } = require('../services/invoiceXmlParser');
const { Purchase, PurchaseItem, Product, Supplier, ProductSupplier } = require('../models/inventory');
const { sequelize } = require('../config/database');
const { Op } = require('sequelize');

/**
 * Importar factura electrónica desde archivo ZIP
 */
const importInvoice = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;
    const profit_margin = parseFloat(req.body.profit_margin) || 30;
    const margin_multiplier = 1 + (profit_margin / 100);
    const supplier_name_override = req.body.supplier_name?.trim() || null;
    const removed_items  = JSON.parse(req.body.removed_items || '[]');
    const shipping_cost   = parseFloat(req.body.shipping_cost) || 0;
    const discount_amount = parseFloat(req.body.discount_amount) || 0;
    // Override de IVA por ítem: { "0": 19, "1": 0, "2": 5 } (índice original → porcentaje)
    const items_tax_overrides = JSON.parse(req.body.items_tax_overrides || '{}');
    // Decisiones del usuario en el modal para ítems sin mapeo exacto por código:
    // { "0": "<product_id>", "2": "CREATE_NEW" } (índice original → decisión).
    // Es la única vía por la que se guarda un mapeo código-proveedor nuevo (ver
    // processInvoiceItems) — un match automático por SKU interno o por nombre
    // aproximado nunca guarda el mapeo por sí solo.
    const manual_links = JSON.parse(req.body.manual_links || '{}');

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No se ha cargado ningún archivo'
      });
    }

    console.log('📦 Procesando archivo:', req.file.originalname);

    const zipData = await extractZipContent(req.file.buffer);
    
    if (!zipData.xml) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'No se encontró archivo XML en el ZIP'
      });
    }

    console.log('📄 XML encontrado, parseando...');

    const invoiceData = await parseInvoiceXML(zipData.xml);
    const validation = validateParsedData(invoiceData);
    
    if (!validation.isValid) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Datos de factura inválidos',
        errors: validation.errors
      });
    }

    console.log('✅ Datos parseados correctamente');

    // Verificar si la factura ya fue importada
    const invoiceNumber = invoiceData.invoice.number;
    const existingPurchase = await Purchase.findOne({
      where: {
        tenant_id,
        invoice_number: invoiceNumber
      },
      include: [{ model: Supplier, as: 'supplier' }],
      transaction
    });

    if (existingPurchase) {
      await transaction.rollback();
      return res.status(409).json({
        success: false,
        message: `Esta factura ya fue importada anteriormente`,
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
        }
      });
    }

    console.log('✅ Factura no duplicada, continuando...');

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
        // Si hay override de IVA para este índice original, aplicarlo
        tax_percentage: items_tax_overrides[originalIdx] !== undefined
          ? parseFloat(items_tax_overrides[originalIdx])
          : item.tax_percentage,
      }))
      .filter((_, idx) => !removed_items.includes(idx));

    // Recalcular tax_amount con el porcentaje posiblemente editado
    filteredItems.forEach(item => {
      item.tax_amount = Math.round(item.subtotal * (item.tax_percentage / 100));
      item.total = item.subtotal + item.tax_amount;
    });

    const processedItems = await processInvoiceItems(filteredItems, tenant_id, supplier.id, transaction, profit_margin, margin_multiplier, manual_links);
    const purchase = await createPurchaseFromInvoice(
      invoiceData,
      supplier,
      processedItems,
      tenant_id,
      user_id,
      transaction,
      shipping_cost,
      discount_amount,
      req.branch_id || null
    );

    await transaction.commit();

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
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    console.error('❌ Error importando factura:', error);
    res.status(500).json({
      success: false,
      message: 'Error al importar factura',
      error: error.message
    });
  }
};

/**
 * Vista previa de factura
 */
const previewInvoice = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No se ha cargado ningún archivo'
      });
    }

    const zipData = await extractZipContent(req.file.buffer);
    
    if (!zipData.xml) {
      return res.status(400).json({
        success: false,
        message: 'No se encontró archivo XML en el ZIP'
      });
    }

    const invoiceData = await parseInvoiceXML(zipData.xml);
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
    const itemsWithSuggestions = await Promise.all(
      invoiceData.items.map(async (item, idx) => ({
        ...item,
        suggestion: await buildItemSuggestion(item, tenant_id, supplierCandidate?.id),
      }))
    );

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
      error: error.message
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

// Misma cadena de búsqueda que processInvoiceItems() (código exacto → SKU
// interno → nombre aproximado), pero de solo lectura — arma la "suggestion"
// que el modal de importación usa para pre-cargar el selector de cada ítem.
async function buildItemSuggestion(item, tenant_id, supplierId) {
  const hasSupplierCode = item.sku && !item.sku.startsWith('TEMP-');

  if (hasSupplierCode && supplierId) {
    const mapping = await ProductSupplier.findOne({
      where: { tenant_id, supplier_id: supplierId, supplier_code: item.sku },
    });
    if (mapping) {
      const product = await Product.findByPk(mapping.product_id);
      if (product) {
        return { product_id: product.id, product_name: product.name, match_type: 'code_exact' };
      }
    }
  }

  if (hasSupplierCode) {
    const bySku = await Product.findOne({ where: { tenant_id, sku: item.sku } });
    if (bySku) {
      return { product_id: bySku.id, product_name: bySku.name, match_type: 'sku_internal' };
    }
  }

  const byName = await Product.findOne({
    where: { tenant_id, name: { [Op.iLike]: `%${item.name}%` } },
  });
  if (byName) {
    return { product_id: byName.id, product_name: byName.name, match_type: 'name_fuzzy' };
  }

  return null;
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

async function processInvoiceItems(items, tenant_id, supplier_id, transaction, profit_margin = 30, margin_multiplier = 1.3, manualLinks = {}) {
  const processedItems = [];

  for (const item of items) {
    let product = null;
    let isNew = false;
    let matchType = null;

    const hasSupplierCode = item.sku && !item.sku.startsWith('TEMP-');
    // manual_links llega con claves string ("0", "1"...) porque viene de JSON.parse
    // sobre un objeto armado en el frontend con índices originales del array.
    const manualLink = manualLinks[String(item.original_index)];

    // 1) ¿Ya existe un mapeo tenant+proveedor+código_proveedor? Es la ÚNICA vía
    //    que se aplica sola, sin pasar por el usuario — el mapeo ya fue
    //    confirmado en una importación anterior.
    if (hasSupplierCode) {
      const mapping = await ProductSupplier.findOne({
        where: { tenant_id, supplier_id, supplier_code: item.sku },
        transaction,
      });
      if (mapping) {
        product = await Product.findByPk(mapping.product_id, { transaction });
        if (product) matchType = 'code_exact';
      }
    }

    // 2) Decisión del usuario en el modal de importación (aceptó una sugerencia,
    //    la cambió, o pidió crear un producto nuevo) — es la otra vía válida
    //    para terminar vinculando el ítem, y la única que se guarda como mapeo.
    if (!product && manualLink && manualLink !== 'CREATE_NEW') {
      product = await Product.findByPk(manualLink, { transaction });
      if (product) matchType = 'manual';
    }

    // 3) Fallback automático heredado (llamadas directas al endpoint sin pasar
    //    por el modal, o sin decisión para este ítem): SKU interno igual al código.
    if (!product && !manualLink && hasSupplierCode) {
      product = await Product.findOne({ where: { tenant_id, sku: item.sku }, transaction });
      if (product) matchType = 'sku_internal';
    }

    // 4) Fallback automático heredado: nombre aproximado.
    if (!product && !manualLink) {
      product = await Product.findOne({
        where: { tenant_id, name: { [Op.iLike]: `%${item.name}%` } },
        transaction
      });
      if (product) matchType = 'name_fuzzy';
    }

    // 5) Crear producto nuevo — comportamiento actual, disparado tanto por
    //    "no se encontró nada" como por la decisión explícita CREATE_NEW.
    if (!product) {
      const newSku = item.sku && !item.sku.startsWith('TEMP-')
        ? item.sku 
        : await generateUniqueSku(item.name, tenant_id, transaction);

      product = await Product.create({
        tenant_id,
        product_type: 'simple', // valor válido según CHECK constraint de la DB
        sku: newSku,
        barcode: newSku,  // código de barras = mismo SKU para productos nuevos
        name: item.name,
        unit_of_measure: 'unit',
        average_cost: item.unit_price,
        base_price: Math.round(item.unit_price * margin_multiplier),
        profit_margin_percentage: profit_margin,
        current_stock: 0,
        min_stock: 1,
        track_inventory: true,
        is_active: true,
        has_tax: item.tax_percentage > 0,
        tax_percentage: item.tax_percentage || 19,
        price_includes_tax: false
      }, { transaction });

      isNew = true;
      matchType = manualLink === 'CREATE_NEW' ? 'new_confirmed' : 'new';
    }

    // 6) Guardar/actualizar el mapeo código-proveedor → producto SOLO cuando la
    //    decisión vino confirmada explícitamente por el usuario (manual_links).
    //    Un match automático por SKU interno o por nombre (pasos 3 y 4) NUNCA
    //    guarda el mapeo por sí solo — así, si el match automático estaba
    //    equivocado, no queda "grabado" para las próximas importaciones.
    if (hasSupplierCode && manualLink !== undefined) {
      await saveSupplierMapping(tenant_id, supplier_id, product.id, item.sku, item.name, transaction);
    }

    processedItems.push({
      product_id: product.id,
      product_name: product.name,
      product_sku: product.sku,
      unit_of_measure: product.unit_of_measure || 'unit',
      quantity: item.quantity,
      unit_cost: item.unit_price,
      tax_percentage: item.tax_percentage,
      tax_amount: item.tax_amount,
      subtotal: item.subtotal,
      total: item.total,
      isNew: isNew,
      match_type: matchType
    });
  }

  return processedItems;
}

// Crea o actualiza la fila de product_suppliers con el código del proveedor.
// Reutiliza la fila si ya existe (por ejemplo, creada antes al confirmar una
// compra — ver purchases.controller.js) para no pisar last_price/last_purchase_date.
async function saveSupplierMapping(tenant_id, supplier_id, product_id, supplier_code, supplier_description, transaction) {
  try {
    const existing = await ProductSupplier.findOne({
      where: { tenant_id, supplier_id, product_id },
      transaction,
    });

    if (existing) {
      await existing.update({ supplier_code, supplier_description }, { transaction });
    } else {
      await ProductSupplier.create({
        tenant_id, supplier_id, product_id, supplier_code, supplier_description,
      }, { transaction });
    }
  } catch (error) {
    // Índice único parcial (tenant_id, supplier_id, supplier_code): salta si ese
    // código de proveedor ya está vinculado a OTRO producto. No interrumpe la
    // importación — el ítem ya quedó vinculado al producto correcto, solo no
    // se pudo "recordar" el código para la próxima vez.
    if (error.name === 'SequelizeUniqueConstraintError') {
      console.warn(`⚠️  No se pudo guardar el mapeo de código "${supplier_code}": ya está vinculado a otro producto.`);
      return;
    }
    throw error;
  }
}

async function generateUniqueSku(productName, tenant_id, transaction) {
  const prefix = productName.substring(0, 3).toUpperCase();
  const timestamp = Date.now().toString().slice(-6);
  let sku = `${prefix}-${timestamp}`;
  let counter = 1;

  while (await Product.findOne({ where: { tenant_id, sku }, transaction })) {
    sku = `${prefix}-${timestamp}-${counter}`;
    counter++;
  }

  return sku;
}

async function createPurchaseFromInvoice(invoiceData, supplier, items, tenant_id, user_id, transaction, shipping_cost = 0, discount_amount = 0, branch_id = null) {
  const purchaseNumber = await generatePurchaseNumber(tenant_id, transaction);

  const subtotal     = items.reduce((sum, item) => sum + parseFloat(item.subtotal), 0);
  const tax_amount   = items.reduce((sum, item) => sum + parseFloat(item.tax_amount), 0);
  const total_amount = subtotal + tax_amount + shipping_cost - discount_amount;

  // Plazo/fecha de pago, en orden de prioridad:
  //  1. Fecha de vencimiento que ya trae la propia factura XML (PaymentDueDate)
  //  2. Calculada a partir del plazo por defecto configurado en el proveedor
  //  3. Sin plazo conocido → queda pendiente sin fecha (se puede editar a mano)
  const purchase_date = invoiceData.invoice.date || new Date();
  let due_date = null;
  let payment_terms = null;

  if (invoiceData.invoice.due_date) {
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
  const isCash = payment_terms === 0;

  const purchase = await Purchase.create({
    tenant_id,
    branch_id,
    purchase_number: purchaseNumber,
    supplier_id: supplier.id,
    purchase_date,
    expected_delivery_date: invoiceData.invoice.due_date || new Date(),
    due_date: isCash ? null : due_date,
    payment_terms,
    payment_status: isCash ? 'paid' : 'pending',
    paid_amount: isCash ? total_amount : 0,
    subtotal,
    tax_amount,
    discount_amount,
    shipping_cost,
    total_amount,
    status: 'draft',
    notes: `Importada desde factura electrónica: ${invoiceData.invoice.number}`,
    invoice_number: invoiceData.invoice.number,
    created_by: user_id
  }, { transaction });

  for (const [index, item] of items.entries()) {
    await PurchaseItem.create({
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
      subtotal: item.subtotal,
      total: item.total
    }, { transaction });
  }

  return purchase;
}

async function generatePurchaseNumber(tenant_id, transaction) {
  const year = new Date().getFullYear();
  const prefix = `PC-${year}-`;

  const lastPurchase = await Purchase.findOne({
    where: {
      tenant_id,
      purchase_number: { [Op.like]: `${prefix}%` }
    },
    order: [['created_at', 'DESC']],
    transaction
  });

  let sequence = 1;
  if (lastPurchase) {
    const lastNumber = lastPurchase.purchase_number.split('-').pop();
    sequence = parseInt(lastNumber) + 1;
  }

  return `${prefix}${sequence.toString().padStart(4, '0')}`;
}

// ============== EXPORTS ==============
module.exports = {
  importInvoice,
  previewInvoice
};