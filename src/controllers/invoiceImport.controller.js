// backend/src/controllers/invoiceImport.controller.js
const AdmZip = require('adm-zip');
const { parseInvoiceXML, validateParsedData } = require('../services/invoiceXmlParser');
const { Purchase, PurchaseItem, Product, Supplier } = require('../models/inventory');
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
    const filteredItems = invoiceData.items.filter((_, idx) => !removed_items.includes(idx));
    const processedItems = await processInvoiceItems(filteredItems, tenant_id, transaction, profit_margin, margin_multiplier);
    const purchase = await createPurchaseFromInvoice(
      invoiceData,
      supplier.id,
      processedItems,
      tenant_id,
      user_id,
      transaction,
      shipping_cost,
      discount_amount
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

    res.json({
      success: true,
      data: {
        isValid: validation.isValid && !isDuplicate, // No válida si es duplicada
        errors: validation.errors,
        invoice: invoiceData.invoice,
        supplier: invoiceData.supplier,
        items: invoiceData.items,
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

async function processInvoiceItems(items, tenant_id, transaction, profit_margin = 30, margin_multiplier = 1.3) {
  const processedItems = [];

  for (const item of items) {
    let product = null;
    let isNew = false;

    if (item.sku && !item.sku.startsWith('TEMP-')) {
      product = await Product.findOne({
        where: { tenant_id, sku: item.sku },
        transaction
      });
    }

    if (!product) {
      product = await Product.findOne({
        where: {
          tenant_id,
          name: { [Op.iLike]: `%${item.name}%` }
        },
        transaction
      });
    }

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
    }

    processedItems.push({
      product_id: product.id,
      product_name: product.name,
      product_sku: product.sku,
      quantity: item.quantity,
      unit_cost: item.unit_price,
      tax_percentage: item.tax_percentage,
      tax_amount: item.tax_amount,
      subtotal: item.subtotal,
      total: item.total,
      isNew: isNew
    });
  }

  return processedItems;
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

async function createPurchaseFromInvoice(invoiceData, supplier_id, items, tenant_id, user_id, transaction, shipping_cost = 0, discount_amount = 0) {
  const purchaseNumber = await generatePurchaseNumber(tenant_id, transaction);

  const subtotal     = items.reduce((sum, item) => sum + parseFloat(item.subtotal), 0);
  const tax_amount   = items.reduce((sum, item) => sum + parseFloat(item.tax_amount), 0);
  const total_amount = subtotal + tax_amount + shipping_cost - discount_amount;

  const purchase = await Purchase.create({
    tenant_id,
    purchase_number: purchaseNumber,
    supplier_id,
    purchase_date: invoiceData.invoice.date || new Date(),
    expected_date: invoiceData.invoice.due_date || new Date(),
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

  for (const item of items) {
    await PurchaseItem.create({
      tenant_id,
      purchase_id: purchase.id,
      product_id: item.product_id,
      product_name: item.product_name,
      product_sku: item.product_sku,
      quantity: item.quantity,
      unit_cost: item.unit_cost,
      tax_percentage: item.tax_percentage,
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