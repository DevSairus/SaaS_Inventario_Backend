const { Purchase, PurchaseItem, Product, Supplier } = require('../../models/inventory');
const ProductSupplier = require('../../models/inventory/ProductSupplier');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { createMovement } = require('./movements.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

/**
 * Generar número de compra único
 */
const generatePurchaseNumber = async (tenant_id) => {
  const year = new Date().getFullYear();
  const prefix = `PC-${year}-`;
  
  const lastPurchase = await Purchase.findOne({
    where: {
      tenant_id,
      purchase_number: {
        [Op.like]: `${prefix}%`
      }
    },
    order: [['created_at', 'DESC']]
  });

  let nextNumber = 1;
  if (lastPurchase) {
    const lastNumber = parseInt(lastPurchase.purchase_number.split('-').pop());
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${String(nextNumber).padStart(5, '0')}`;
};

/**
 * Obtener todas las compras con filtros y paginación
 */
const getPurchases = async (req, res) => {
  try {
    const {
      search = '',
      supplier_id,
      status,
      start_date,
      end_date,
      sort_by = 'purchase_date',
      sort_order = 'DESC',
      page = 1,
      limit = 10
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;

    // Construir condiciones de búsqueda
    const where = { tenant_id };

    if (search) {
      where[Op.or] = [
        { purchase_number: { [Op.iLike]: `%${search}%` } },
        { invoice_number: { [Op.iLike]: `%${search}%` } },
        { reference: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (supplier_id) {
      where.supplier_id = supplier_id;
    }

    if (status) {
      where.status = status;
    }

    if (start_date) {
      where.purchase_date = {
        [Op.gte]: start_date
      };
    }

    if (end_date) {
      where.purchase_date = {
        ...where.purchase_date,
        [Op.lte]: end_date
      };
    }

    // Obtener compras con información del proveedor
    const { count, rows } = await Purchase.findAndCountAll({
      where,
      include: [
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'business_name', 'tax_id']
        }
      ],
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
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
    console.error('Error en getPurchases:', error);
    res.status(500).json({ success: false, message: 'Error al obtener compras', error: error.message });
  }
};

/**
 * Obtener una compra por ID con todos sus items
 */
const getPurchaseById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const purchase = await Purchase.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'business_name', 'tax_id', 'email', 'phone']
        },
        {
          model: PurchaseItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'sku', 'name', 'unit_of_measure']
            }
          ]
        }
      ]
    });

    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    res.json({
      success: true,
      data: purchase
    });
  } catch (error) {
    console.error('Error en getPurchaseById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener compra', error: error.message });
  }
};

/**
 * Crear una nueva compra
 */
const createPurchase = async (req, res) => {
  const t = await sequelize.transaction();
  
  try {
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    const {
      supplier_id,
      purchase_date,
      expected_delivery_date,
      items,
      discount_amount = 0,
      shipping_cost = 0,
      payment_method,
      invoice_number,
      reference,
      notes,
      internal_notes,
      warehouse_id
    } = req.body;

    // Validaciones
    if (!supplier_id || !items || items.length === 0) {
      throw new Error('Proveedor y al menos un producto son requeridos');
    }

    // Verificar que el proveedor existe y pertenece al tenant
    const supplier = await Supplier.findOne({
      where: { id: supplier_id, tenant_id },
      transaction: t
    });

    if (!supplier) {
      throw new Error('Proveedor no encontrado');
    }

    // Generar número de compra
    const purchase_number = await generatePurchaseNumber(tenant_id);

    // Calcular totales
    let subtotal = 0;
    let tax_amount = 0;

    const itemsToCreate = [];

    for (const item of items) {
      // Verificar que el producto existe
      const product = await Product.findOne({
        where: { id: item.product_id, tenant_id },
        transaction: t
      });

      if (!product) {
        throw new Error(`Producto ${item.product_id} no encontrado`);
      }

      const quantity = parseFloat(item.quantity);
      const unit_cost = parseFloat(item.unit_cost);
      const tax_rate = parseFloat(item.tax_rate || 0);
      const discount_percentage = parseFloat(item.discount_percentage || 0);

      // Calcular montos del item
      const item_subtotal = quantity * unit_cost;
      const item_discount = (item_subtotal * discount_percentage) / 100;
      const item_subtotal_after_discount = item_subtotal - item_discount;
      const item_tax = (item_subtotal_after_discount * tax_rate) / 100;
      const item_total = item_subtotal_after_discount + item_tax;

      subtotal += item_subtotal_after_discount;
      tax_amount += item_tax;

      itemsToCreate.push({
        product_id: item.product_id,
        quantity,
        received_quantity: 0,
        unit_cost,
        tax_rate,
        tax_amount: item_tax,
        discount_percentage,
        discount_amount: item_discount,
        subtotal: item_subtotal_after_discount,
        total: item_total,
        notes: item.notes || null
      });
    }

    const total_amount = subtotal + tax_amount - parseFloat(discount_amount) + parseFloat(shipping_cost);

    // Crear la compra
    const purchase = await Purchase.create({
      tenant_id,
      purchase_number,
      supplier_id,
      user_id,
      purchase_date: purchase_date || new Date(),
      expected_delivery_date,
      status: 'draft',
      subtotal,
      tax_amount,
      discount_amount: parseFloat(discount_amount),
      shipping_cost: parseFloat(shipping_cost),
      total_amount,
      payment_method,
      payment_status: 'pending',
      invoice_number,
      reference,
      notes,
      internal_notes,
      warehouse_id
    }, { transaction: t });

    // Crear los items
    for (const itemData of itemsToCreate) {
      await PurchaseItem.create({
        purchase_id: purchase.id,
        ...itemData
      }, { transaction: t });
    }

    // Commit ANTES de buscar la compra completa
    await t.commit();

    // Buscar la compra con relaciones (FUERA de la transacción)
    const createdPurchase = await Purchase.findByPk(purchase.id, {
      include: [
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'business_name']
        },
        {
          model: PurchaseItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'sku', 'name', 'unit_of_measure']
            }
          ]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Compra creada exitosamente',
      data: createdPurchase
    });

  } catch (error) {
    // Solo hacer rollback si la transacción NO ha sido finalizada
    if (t && !t.finished) {
      await t.rollback();
    }
    
    console.error('Error en createPurchase:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Error al crear compra'
    });
  }
};

/**
 * Actualizar una compra (solo si está en estado draft)
 */
const updatePurchase = async (req, res) => {
  const t = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const purchase = await Purchase.findOne({
      where: { id, tenant_id },
      include: [{ model: PurchaseItem, as: 'items' }]
    });

    if (!purchase) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    if (purchase.status !== 'draft') {
      await t.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Solo se pueden editar compras en estado borrador' 
      });
    }

    const {
      supplier_id,
      purchase_date,
      expected_delivery_date,
      items,
      discount_amount,
      shipping_cost,
      payment_method,
      invoice_number,
      reference,
      notes,
      internal_notes,
      warehouse_id
    } = req.body;

    // Si se proporcionan items, recalcular totales
    if (items && items.length > 0) {
      // Eliminar items anteriores
      await PurchaseItem.destroy({
        where: { purchase_id: id },
        transaction: t
      });

      let subtotal = 0;
      let tax_amount = 0;

      // Crear nuevos items
      for (const item of items) {
        const quantity = parseFloat(item.quantity);
        const unit_cost = parseFloat(item.unit_cost);
        const tax_rate = parseFloat(item.tax_rate || 0);
        const discount_percentage = parseFloat(item.discount_percentage || 0);

        const item_subtotal = quantity * unit_cost;
        const item_discount = (item_subtotal * discount_percentage) / 100;
        const item_subtotal_after_discount = item_subtotal - item_discount;
        const item_tax = (item_subtotal_after_discount * tax_rate) / 100;
        const item_total = item_subtotal_after_discount + item_tax;

        subtotal += item_subtotal_after_discount;
        tax_amount += item_tax;

        await PurchaseItem.create({
          purchase_id: id,
          product_id: item.product_id,
          quantity,
          received_quantity: 0,
          unit_cost,
          tax_rate,
          tax_amount: item_tax,
          discount_percentage,
          discount_amount: item_discount,
          subtotal: item_subtotal_after_discount,
          total: item_total,
          notes: item.notes || null
        }, { transaction: t });
      }

      const total_amount = subtotal + tax_amount - 
        parseFloat(discount_amount || 0) + 
        parseFloat(shipping_cost || 0);

      await purchase.update({
        supplier_id,
        purchase_date,
        expected_delivery_date,
        subtotal,
        tax_amount,
        discount_amount: parseFloat(discount_amount || 0),
        shipping_cost: parseFloat(shipping_cost || 0),
        total_amount,
        payment_method,
        invoice_number,
        reference,
        notes,
        internal_notes,
        warehouse_id
      }, { transaction: t });
    } else {
      // Solo actualizar campos de la compra
      await purchase.update({
        supplier_id,
        purchase_date,
        expected_delivery_date,
        discount_amount: discount_amount !== undefined ? parseFloat(discount_amount) : purchase.discount_amount,
        shipping_cost: shipping_cost !== undefined ? parseFloat(shipping_cost) : purchase.shipping_cost,
        payment_method,
        invoice_number,
        reference,
        notes,
        internal_notes,
        warehouse_id
      }, { transaction: t });
    }

    await t.commit();

    // Obtener compra actualizada
    const updatedPurchase = await Purchase.findByPk(id, {
      include: [
        {
          model: Supplier,
          as: 'supplier'
        },
        {
          model: PurchaseItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product'
            }
          ]
        }
      ]
    });

    res.json({
      success: true,
      message: 'Compra actualizada exitosamente',
      data: updatedPurchase
    });
  } catch (error) {
    await t.rollback();
    console.error('Error en updatePurchase:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar compra', error: error.message });
  }
};

/**
 * Confirmar una compra (cambiar de draft a confirmed)
 */
const confirmPurchase = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const purchase = await Purchase.findOne({
      where: { id, tenant_id }
    });

    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    if (purchase.status !== 'draft') {
      return res.status(400).json({ 
        success: false, 
        message: 'Solo se pueden confirmar compras en estado borrador' 
      });
    }

    await purchase.update({ status: 'confirmed' });

    res.json({
      success: true,
      message: 'Compra confirmada exitosamente',
      data: purchase
    });
  } catch (error) {
    console.error('Error en confirmPurchase:', error);
    res.status(500).json({ success: false, message: 'Error al confirmar compra', error: error.message });
  }
};

/**
 * Recibir una compra (actualiza stock, costo promedio y precio de venta si aplica)
 */
const receivePurchase = async (req, res) => {
  const t = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const { received_items } = req.body; // Array de { item_id, received_quantity }

    const purchase = await Purchase.findOne({
      where: { id, tenant_id },
      include: [{ model: PurchaseItem, as: 'items' }],
      transaction: t
    });

    if (!purchase) {
      throw new Error('Compra no encontrada');
    }

    if (purchase.status === 'received') {
      throw new Error('Esta compra ya fue recibida');
    }

    if (purchase.status === 'cancelled') {
      throw new Error('No se puede recibir una compra cancelada');
    }

    // Actualizar cantidades recibidas y crear movimientos de inventario
    for (const receivedItem of received_items || []) {
      const purchaseItem = purchase.items.find(item => item.id === receivedItem.item_id);
      
      if (!purchaseItem) {
        continue;
      }

      const received_quantity = parseFloat(receivedItem.received_quantity || purchaseItem.quantity);

      // Actualizar cantidad recibida en el item
      await purchaseItem.update({
        received_quantity
      }, { transaction: t });

      // Obtener producto
      const product = await Product.findByPk(purchaseItem.product_id, { transaction: t });

      if (!product) {
        continue;
      }

      // Crear movimiento de entrada (actualiza current_stock y average_cost automáticamente)
      await createMovement({
        tenant_id: tenant_id,
        movement_type: 'entrada',
        movement_reason: 'purchase_receipt',
        reference_type: 'purchase',
        reference_id: purchase.id,
        product_id: purchaseItem.product_id,
        warehouse_id: purchase.warehouse_id || null,
        quantity: received_quantity,
        unit_cost: purchaseItem.unit_cost,
        user_id: req.user.id,
        movement_date: purchase.purchase_date ? new Date(purchase.purchase_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        notes: `Recepcion compra ${purchase.purchase_number} - ${purchaseItem.product_name}`
      }, t);

      // Re-leer producto para obtener stock y costo actualizados por createMovement
      const updatedProduct = await Product.findByPk(purchaseItem.product_id, { transaction: t });

      // Campos adicionales que createMovement no cubre
      const extraUpdates = {
        available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock || 0),
        last_purchase_cost: parseFloat(purchaseItem.unit_cost) || 0,
        last_purchase_date: purchase.purchase_date
      };

      // Si tiene margen de ganancia, recalcular precio de venta
      if (updatedProduct.profit_margin_percentage && parseFloat(updatedProduct.profit_margin_percentage) > 0) {
        const margin = parseFloat(updatedProduct.profit_margin_percentage);
        extraUpdates.base_price = parseFloat(updatedProduct.average_cost) * (1 + margin / 100);
      }

      await updatedProduct.update(extraUpdates, { transaction: t });

      // ✅ Actualizar/crear relación product_suppliers para que el botón de proveedores tenga datos
      const existingLink = await ProductSupplier.findOne({
        where: {
          product_id: purchaseItem.product_id,
          supplier_id: purchase.supplier_id,
          tenant_id: tenant_id
        },
        transaction: t
      });

      if (existingLink) {
        await existingLink.update({
          last_price: parseFloat(purchaseItem.unit_cost),
          last_purchase_date: purchase.purchase_date || new Date()
        }, { transaction: t });
      } else {
        await ProductSupplier.create({
          tenant_id: tenant_id,
          product_id: purchaseItem.product_id,
          supplier_id: purchase.supplier_id,
          last_price: parseFloat(purchaseItem.unit_cost),
          last_purchase_date: purchase.purchase_date || new Date()
        }, { transaction: t });
      }
    }

    // Actualizar estado de la compra
    await purchase.update({
      status: 'received',
      received_date: new Date()
    }, { transaction: t });

    await t.commit();

    // Obtener compra actualizada
    const updatedPurchase = await Purchase.findByPk(id, {
      include: [
        {
          model: Supplier,
          as: 'supplier'
        },
        {
          model: PurchaseItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product'
            }
          ]
        }
      ]
    });

    // 🔔 Verificación automática de alertas
    const product_ids = purchase.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenant_id);

    res.json({
      success: true,
      message: 'Compra recibida exitosamente. Stock, costos y precios actualizados.',
      data: updatedPurchase
    });
  } catch (error) {
    if (t && !t.finished) {
      await t.rollback();
    }
    console.error('Error en receivePurchase:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Error al recibir compra'
    });
  }
};

/**
 * Cancelar una compra
 */
const cancelPurchase = async (req, res) => {
  try {
    const { id } = req.params;
    const { cancellation_reason } = req.body;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    const purchase = await Purchase.findOne({
      where: { id, tenant_id }
    });

    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    if (purchase.status === 'received') {
      return res.status(400).json({ 
        success: false, 
        message: 'No se puede cancelar una compra que ya fue recibida' 
      });
    }

    if (purchase.status === 'cancelled') {
      return res.status(400).json({ 
        success: false, 
        message: 'Esta compra ya está cancelada' 
      });
    }

    await purchase.update({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancelled_by: user_id,
      cancellation_reason
    });

    res.json({
      success: true,
      message: 'Compra cancelada exitosamente',
      data: purchase
    });
  } catch (error) {
    console.error('Error en cancelPurchase:', error);
    res.status(500).json({ success: false, message: 'Error al cancelar compra', error: error.message });
  }
};

/**
 * Eliminar una compra (solo si está en draft)
 */
const deletePurchase = async (req, res) => {
  const t = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const purchase = await Purchase.findOne({
      where: { id, tenant_id }
    });

    if (!purchase) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    if (purchase.status !== 'draft') {
      await t.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Solo se pueden eliminar compras en estado borrador' 
      });
    }

    // Eliminar items (se eliminan automáticamente por CASCADE)
    await purchase.destroy({ transaction: t });

    await t.commit();

    res.json({
      success: true,
      message: 'Compra eliminada exitosamente'
    });
  } catch (error) {
    await t.rollback();
    console.error('Error en deletePurchase:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar compra', error: error.message });
  }
};

/**
 * Obtener estadísticas de compras
 */
const getPurchaseStats = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;

    const totalPurchases = await Purchase.count({
      where: { tenant_id }
    });

    const draftPurchases = await Purchase.count({
      where: { tenant_id, status: 'draft' }
    });

    const confirmedPurchases = await Purchase.count({
      where: { tenant_id, status: 'confirmed' }
    });

    const receivedPurchases = await Purchase.count({
      where: { tenant_id, status: 'received' }
    });

    const cancelledPurchases = await Purchase.count({
      where: { tenant_id, status: 'cancelled' }
    });

    // Total gastado este mes
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const totalThisMonth = await Purchase.sum('total_amount', {
      where: {
        tenant_id,
        status: { [Op.in]: ['confirmed', 'received'] },
        purchase_date: { [Op.gte]: startOfMonth }
      }
    }) || 0;

    res.json({
      success: true,
      data: {
        total: totalPurchases,
        draft: draftPurchases,
        confirmed: confirmedPurchases,
        received: receivedPurchases,
        cancelled: cancelledPurchases,
        total_this_month: parseFloat(totalThisMonth)
      }
    });
  } catch (error) {
    console.error('Error en getPurchaseStats:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas', error: error.message });
  }
};

module.exports = {
  getPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchase,
  confirmPurchase,
  receivePurchase,
  cancelPurchase,
  deletePurchase,
  getPurchaseStats
};