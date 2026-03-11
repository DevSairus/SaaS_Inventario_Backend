const logger = require('../../config/logger');
// backend/src/controllers/sales/sales.controller.js
const { Sale, SaleItem, Customer, Product, Tenant, InventoryMovement, DianResolution } = require('../../models');
const audit = require('../../utils/audit');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');
const { generateSalePDF, generateSalePDFBuffer, generatePaymentReceiptPDF } = require('../../services/pdfService');
const whatsappService = require('../../services/whatsappService');
const { createMovement } = require('../inventory/movements.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const dianService = require('../../services/dian/dianService');

// Obtener todas las ventas
const getAll = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { status, customer_id, from_date, to_date, document_type, search, customer_name, vehicle_plate, dian_status, limit = 50, offset = 0 } = req.query;

    const where = { tenant_id: tenantId };

    if (status) where.status = status;
    if (customer_id) where.customer_id = customer_id;
    if (document_type) where.document_type = document_type;
    if (dian_status) where.dian_status = dian_status;

    if (customer_name) {
      where.customer_name = { [Op.iLike]: `%${customer_name}%` };
    }

    if (vehicle_plate) {
      where.vehicle_plate = { [Op.iLike]: `%${vehicle_plate}%` };
    }

    if (search && !customer_name && !vehicle_plate) {
      where[Op.or] = [
        { sale_number: { [Op.iLike]: `%${search}%` } },
        { customer_name: { [Op.iLike]: `%${search}%` } },
        { customer_tax_id: { [Op.iLike]: `%${search}%` } },
        { customer_email: { [Op.iLike]: `%${search}%` } },
        { customer_phone: { [Op.iLike]: `%${search}%` } },
        { vehicle_plate: { [Op.iLike]: `%${search}%` } },
        { dian_invoice_number: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (from_date && to_date) {
      where.sale_date = { [Op.between]: [from_date, to_date] };
    } else if (from_date) {
      where.sale_date = { [Op.gte]: from_date };
    } else if (to_date) {
      where.sale_date = { [Op.lte]: to_date };
    }

    const sales = await Sale.findAll({
      where,
      include: [
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'tax_id', 'email', 'phone']
        },
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }]
        }
      ],
      order: [['sale_date', 'DESC'], ['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    const total = await Sale.count({ where });

    res.json({
      success: true,
      data: sales,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: total > (parseInt(offset) + parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error al obtener ventas:', error);
    res.status(500).json({ success: false, message: 'Error al obtener ventas' });
  }
};

// Obtener una venta por ID
const getById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [
        { model: Customer, as: 'customer' },
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product' }]
        }
      ]
    });

    if (!sale) {
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }

    res.json({ success: true, data: sale });
  } catch (error) {
    logger.error('Error al obtener venta:', error);
    res.status(500).json({ success: false, message: 'Error al obtener venta' });
  }
};

// Crear nueva venta
const create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenantId = req.tenant_id;
    const userId = req.user.id;
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const {
      customer_id,
      customer_data,
      warehouse_id,
      items,
      payment_method,
      notes,
      vehicle_plate,
      mileage,
      document_type = 'remision',
      sale_date,
    } = req.body;

    let finalCustomerId = customer_id;
    let customerInfo = {};

    if (customer_id) {
      const customer = await Customer.findOne({ where: { id: customer_id, tenant_id: tenantId } });
      if (!customer) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
      }
      customerInfo = {
        customer_name: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
        customer_tax_id: customer.tax_id,
        customer_email: customer.email,
        customer_phone: customer.phone || customer.mobile,
        customer_address: customer.address,
      };
    } else if (customer_data) {
      const { full_name: cdFullName, ...cdRest } = customer_data;
      let cdNames = {};
      if (cdFullName) {
        const parts = cdFullName.trim().split(/\s+/);
        cdNames = { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '' };
      }
      const newCustomer = await Customer.create(
        { tenant_id: tenantId, ...cdRest, ...cdNames, is_active: true },
        { transaction }
      );
      finalCustomerId = newCustomer.id;
      customerInfo = {
        customer_name: [newCustomer.first_name, newCustomer.last_name].filter(Boolean).join(' '),
        customer_tax_id: newCustomer.tax_id,
        customer_email: newCustomer.email,
        customer_phone: newCustomer.phone || newCustomer.mobile,
        customer_address: newCustomer.address,
      };
    } else {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Debe proporcionar customer_id o customer_data' });
    }

    // ── Generar número de venta ──────────────────────────────────────
    // FACTURAS: usa consecutivo de la resolución DIAN activa (con su prefijo)
    // REMISIONES / COTIZACIONES: consecutivo interno (sin cambios)
    const saleNumber = await generateSaleNumber(tenantId, document_type, transaction);

    // Calcular totales
    let subtotal = 0;
    let tax_amount = 0;
    let discount_amount = 0;
    const saleItems = [];

    for (const item of items) {
      const itemType = item.item_type || 'product';

      // Línea libre ad-hoc
      if (itemType === 'free_line') {
        const fs  = item.quantity * item.unit_price;
        const fd  = fs * (item.discount_percentage || 0) / 100;
        const ftb = fs - fd;
        let ftax = 0, ftaxpct = 0, ftotal = ftb;
        if (item.tax_percentage > 0) {
          ftaxpct = item.tax_percentage;
          ftax    = ftb * ftaxpct / 100;
          ftotal  = ftb + ftax;
        }
        subtotal += fs; discount_amount += fd; tax_amount += ftax;
        saleItems.push({
          tenant_id: tenantId, item_type: 'free_line', product_id: null,
          product_name: item.product_name, product_sku: null,
          quantity: item.quantity, unit_price: item.unit_price,
          discount_percentage: item.discount_percentage || 0, discount_amount: fd,
          tax_percentage: ftaxpct, tax_amount: ftax,
          subtotal: fs, total: ftotal, unit_cost: 0,
        });
        continue;
      }

      const product = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId } });
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: `Producto ${item.product_id} no encontrado` });
      }

      const itemSubtotal = item.quantity * item.unit_price;
      const itemDiscount = itemSubtotal * (item.discount_percentage || 0) / 100;
      const itemTaxBase  = itemSubtotal - itemDiscount;
      let itemTax = 0, itemTotal = 0, itemBaseWithoutTax = 0, taxPercentage = 0;

      if (product.has_tax === false) {
        itemTax = 0; itemBaseWithoutTax = itemTaxBase; itemTotal = itemTaxBase;
      } else {
        taxPercentage = item.tax_percentage || product.tax_percentage || 19;
        const priceIncludesTax = product.price_includes_tax || false;
        if (priceIncludesTax) {
          itemTax = (itemTaxBase * taxPercentage) / (100 + taxPercentage);
          itemBaseWithoutTax = itemTaxBase - itemTax;
          itemTotal = itemTaxBase;
        } else {
          itemTax = itemTaxBase * taxPercentage / 100;
          itemBaseWithoutTax = itemTaxBase;
          itemTotal = itemTaxBase + itemTax;
        }
      }

      subtotal += itemSubtotal; discount_amount += itemDiscount; tax_amount += itemTax;
      saleItems.push({
        tenant_id: tenantId,
        item_type: product.product_type === 'service' ? 'service' : 'product',
        product_id: product.id,
        product_name: product.name,
        product_sku: product.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percentage: item.discount_percentage || 0,
        discount_amount: itemDiscount,
        tax_percentage: taxPercentage,
        tax_amount: itemTax,
        subtotal: itemSubtotal,
        total: itemTotal,
        unit_cost: product.product_type === 'service' ? 0 : (product.average_cost || 0),
      });
    }

    const total_amount = saleItems.reduce((sum, i) => sum + i.total, 0);

    const saleData = {
      tenant_id: tenantId,
      sale_number: saleNumber,
      document_type,
      sale_date: sale_date || new Date(),
      customer_id: finalCustomerId,
      ...customerInfo,
      warehouse_id: (warehouse_id && uuidRegex.test(warehouse_id)) ? warehouse_id : null,
      subtotal,
      tax_amount,
      discount_amount,
      total_amount,
      payment_method,
      payment_status: 'pending',
      notes,
      status: 'draft',
      created_by: userId,
      // DIAN: las facturas se enviarán después del commit; el resto no aplica
      dian_status: document_type === 'factura' ? 'pending' : 'not_applicable',
    };

    if (vehicle_plate && vehicle_plate.trim()) {
      saleData.vehicle_plate = vehicle_plate.trim().toUpperCase();
    }
    if (mileage !== undefined && mileage !== null && mileage !== '') {
      const parsedMileage = parseInt(mileage);
      if (!isNaN(parsedMileage)) saleData.mileage = parsedMileage;
    }

    const sale = await Sale.create(saleData, { transaction });

    for (const item of saleItems) {
      await SaleItem.create({
        sale_id: sale.id,
        tenant_id: item.tenant_id,
        item_type: item.item_type || 'product',
        product_id: item.product_id,
        product_name: item.product_name,
        product_sku: item.product_sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percentage: item.discount_percentage,
        discount_amount: item.discount_amount,
        tax_percentage: item.tax_percentage,
        tax_amount: item.tax_amount,
        subtotal: item.subtotal,
        total: item.total,
        unit_cost: item.unit_cost,
        notes: null
      }, { transaction });
    }

    await transaction.commit();

    // ── DIAN: disparar envío asíncrono para facturas (no bloquea response) ──
    if (document_type === 'factura') {
      const saleCopy = { ...sale.toJSON(), items: saleItems };
      setImmediate(async () => {
        try {
          const tenant = await Tenant.findByPk(tenantId);
          await dianService.sendInvoiceToDian(saleCopy, tenant);
        } catch (err) {
          logger.error(`[DIAN] Error async al enviar factura ${sale.sale_number}:`, err.message);
        }
      });
    }

    const completeSale = await Sale.findByPk(sale.id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: Customer, as: 'customer' },
      ],
    });

    res.status(201).json({
      success: true,
      message: 'Venta creada exitosamente',
      data: completeSale
    });

  } catch (error) {
    await transaction.rollback();
    logger.error('Error creando venta:', error);
    res.status(500).json({ success: false, message: 'Error creando venta' });
  }
};

// Actualizar venta (solo si está en draft)
const update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const sale = await Sale.findOne({ where: { id, tenant_id: tenantId } });
    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }
    if (sale.status !== 'draft') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Solo se pueden editar ventas en borrador' });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const { items, customer_data, ...rest } = req.body;
    const updateData = { ...rest };

    if ('warehouse_id' in updateData) {
      updateData.warehouse_id = (updateData.warehouse_id && uuidRegex.test(updateData.warehouse_id))
        ? updateData.warehouse_id : null;
    }
    if ('customer_id' in updateData) {
      updateData.customer_id = (updateData.customer_id && uuidRegex.test(updateData.customer_id))
        ? updateData.customer_id : null;
    }
    if ('vehicle_plate' in updateData) {
      updateData.vehicle_plate = updateData.vehicle_plate?.trim()
        ? updateData.vehicle_plate.trim().toUpperCase() : null;
    }
    if ('mileage' in updateData) {
      const parsed = parseInt(updateData.mileage);
      updateData.mileage = isNaN(parsed) ? null : parsed;
    }

    if (updateData.customer_id) {
      const customer = await Customer.findOne({ where: { id: updateData.customer_id, tenant_id: tenantId } });
      if (customer) {
        updateData.customer_name    = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
        updateData.customer_tax_id  = customer.tax_id;
        updateData.customer_email   = customer.email;
        updateData.customer_phone   = customer.phone || customer.mobile;
        updateData.customer_address = customer.address;
      }
    }

    if (items && Array.isArray(items) && items.length > 0) {
      await SaleItem.destroy({ where: { sale_id: id }, transaction });

      let subtotal = 0, tax_amount = 0, discount_amount = 0;
      const newItems = [];

      for (const item of items) {
        const itemType = item.item_type || 'product';

        if (itemType === 'free_line') {
          const fs  = item.quantity * item.unit_price;
          const fd  = fs * (item.discount_percentage || 0) / 100;
          const ftb = fs - fd;
          let ftax = 0, ftaxpct = 0, ftotal = ftb;
          if (item.tax_percentage > 0) { ftaxpct = item.tax_percentage; ftax = ftb * ftaxpct / 100; ftotal = ftb + ftax; }
          subtotal += fs; discount_amount += fd; tax_amount += ftax;
          newItems.push({
            sale_id: id, tenant_id: tenantId, item_type: 'free_line',
            product_id: null, product_name: item.product_name, product_sku: null,
            quantity: item.quantity, unit_price: item.unit_price,
            discount_percentage: item.discount_percentage || 0, discount_amount: fd,
            tax_percentage: ftaxpct, tax_amount: ftax, subtotal: fs, total: ftotal, unit_cost: 0,
          });
          continue;
        }

        const product = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId } });
        if (!product) {
          await transaction.rollback();
          return res.status(404).json({ success: false, message: `Producto ${item.product_id} no encontrado` });
        }

        const itemSubtotal = item.quantity * item.unit_price;
        const itemDiscount = itemSubtotal * (item.discount_percentage || 0) / 100;
        const itemTaxBase  = itemSubtotal - itemDiscount;
        let itemTax = 0, itemTotal = 0, taxPercentage = 0;

        if (product.has_tax === false) {
          itemTotal = itemTaxBase;
        } else {
          taxPercentage = item.tax_percentage || product.tax_percentage || 19;
          if (product.price_includes_tax) {
            itemTax   = (itemTaxBase * taxPercentage) / (100 + taxPercentage);
            itemTotal = itemTaxBase;
          } else {
            itemTax   = itemTaxBase * taxPercentage / 100;
            itemTotal = itemTaxBase + itemTax;
          }
        }

        subtotal += itemSubtotal; discount_amount += itemDiscount; tax_amount += itemTax;
        newItems.push({
          sale_id: id, tenant_id: tenantId,
          item_type: product.product_type === 'service' ? 'service' : 'product',
          product_id: product.id, product_name: product.name, product_sku: product.sku,
          quantity: item.quantity, unit_price: item.unit_price,
          discount_percentage: item.discount_percentage || 0, discount_amount: itemDiscount,
          tax_percentage: taxPercentage, tax_amount: itemTax,
          subtotal: itemSubtotal, total: itemTotal,
          unit_cost: product.product_type === 'service' ? 0 : (product.average_cost || 0),
        });
      }

      for (const item of newItems) await SaleItem.create(item, { transaction });

      const total_amount = newItems.reduce((sum, i) => sum + i.total, 0);
      updateData.subtotal        = subtotal;
      updateData.tax_amount      = tax_amount;
      updateData.discount_amount = discount_amount;
      updateData.total_amount    = total_amount;
    }

    await sale.update(updateData, { transaction });
    await transaction.commit();

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    res.json({ success: true, message: 'Venta actualizada exitosamente', data: updatedSale });

  } catch (error) {
    await transaction.rollback();
    logger.error('Error actualizando venta:', error);
    res.status(500).json({ success: false, message: 'Error actualizando venta' });
  }
};

// Confirmar venta
const confirm = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const userId = req.user_id || req.user?.id;
    const { payment_method, paid_amount } = req.body;

    if (!payment_method) {
      return res.status(400).json({ success: false, message: 'Debe especificar el método de pago' });
    }

    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [{ model: SaleItem, as: 'items' }]
    });

    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (sale.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Solo se pueden confirmar ventas en borrador' });
    }

    // Validar límite de crédito
    if (payment_method === 'credito' && sale.customer_id) {
      const creditCustomer = await Customer.findOne({ where: { id: sale.customer_id, tenant_id: tenantId } });
      if (creditCustomer && parseFloat(creditCustomer.credit_limit || 0) > 0) {
        const pendingResult = await Sale.findOne({
          where: {
            customer_id: sale.customer_id, tenant_id: tenantId,
            payment_status: { [Op.in]: ['pending', 'partial'] },
            status: { [Op.in]: ['completed', 'pending'] },
            id: { [Op.ne]: sale.id }
          },
          attributes: [
            [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total_amount')), 0), 'total_pending'],
            [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('paid_amount')), 0), 'total_paid']
          ],
          raw: true
        });
        const currentDebt = parseFloat(pendingResult?.total_pending || 0) - parseFloat(pendingResult?.total_paid || 0);
        const newDebt = currentDebt + parseFloat(sale.total_amount);
        const limit = parseFloat(creditCustomer.credit_limit);
        if (newDebt > limit) {
          const name = creditCustomer.business_name || `${creditCustomer.first_name} ${creditCustomer.last_name}`;
          return res.status(400).json({
            success: false,
            message: `Límite de crédito excedido para ${name}. Límite: $${limit.toLocaleString('es-CO')}, Deuda actual: $${currentDebt.toLocaleString('es-CO')}, Esta venta: $${parseFloat(sale.total_amount).toLocaleString('es-CO')}`,
            credit_limit: limit, current_debt: currentDebt, sale_total: parseFloat(sale.total_amount)
          });
        }
      }
    }

    const transaction = await sequelize.transaction();
    try {
      // Pre-validar stock
      const stockErrors = [];
      for (const item of sale.items) {
        if (item.item_type === 'service' || item.item_type === 'free_line') continue;
        if (!item.product_id) continue;
        const prodCheck = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId }, transaction });
        if (prodCheck && prodCheck.track_inventory && !prodCheck.allow_negative_stock) {
          const disponible = parseFloat(prodCheck.current_stock);
          const solicitado = parseFloat(item.quantity);
          if (disponible < solicitado) {
            stockErrors.push(`• ${prodCheck.name}: disponible ${disponible}, solicitado ${solicitado}`);
          }
        }
      }
      if (stockErrors.length > 0) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: `Stock insuficiente: ${stockErrors.join(', ')}` });
      }

      // Crear movimientos de salida
      for (const item of sale.items) {
        if (item.item_type === 'service' || item.item_type === 'free_line') continue;
        if (item.product_id) {
          const product = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId }, transaction });
          if (product && product.track_inventory) {
            await createMovement({
              tenant_id: tenantId, movement_type: 'salida', movement_reason: 'sale',
              reference_type: 'sale', reference_id: sale.id, product_id: item.product_id,
              warehouse_id: sale.warehouse_id || null, quantity: item.quantity,
              unit_cost: item.unit_cost || product.average_cost || item.unit_price, user_id: userId,
              movement_date: sale.sale_date ? new Date(sale.sale_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
              notes: `Venta ${sale.sale_number} - ${item.product_name}`
            }, transaction);
          }
        }
      }

      const amountPaid = paid_amount !== undefined ? parseFloat(paid_amount) : parseFloat(sale.total_amount);
      const updateData = { status: 'completed', payment_method, paid_amount: amountPaid };

      if (amountPaid >= parseFloat(sale.total_amount)) updateData.payment_status = 'paid';
      else if (amountPaid > 0) updateData.payment_status = 'partial';
      else updateData.payment_status = 'pending';

      await sale.update(updateData, { transaction });
      await transaction.commit();

      await audit({
        tenant_id: tenantId, user_id: userId, action: 'CONFIRM_SALE',
        entity: 'sale', entity_id: sale.id,
        changes: { sale_number: sale.sale_number, total_amount: sale.total_amount, payment_method }, req
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    const product_ids = sale.items.map(i => i.product_id);
    markProductsForAlertCheck(res, product_ids, tenantId);

    res.json({ success: true, message: 'Venta confirmada y pago registrado exitosamente', data: updatedSale });

  } catch (error) {
    logger.error('Error confirmando venta:', error);
    res.status(500).json({ success: false, message: 'Error confirmando venta' });
  }
};

// Cancelar venta
const cancel = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const userId = req.user_id || req.user?.id;
    const { reason } = req.body;

    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [{ model: SaleItem, as: 'items' }]
    });

    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (sale.status === 'cancelled') return res.status(400).json({ success: false, message: 'La venta ya está cancelada' });

    const transaction = await sequelize.transaction();
    try {
      if (sale.status === 'completed' || sale.status === 'delivered') {
        for (const item of sale.items) {
          if (item.product_id) {
            const product = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId }, transaction });
            if (product && product.track_inventory) {
              await createMovement({
                tenant_id: tenantId, movement_type: 'entrada', movement_reason: 'sale_reversal',
                reference_type: 'sale', reference_id: sale.id, product_id: item.product_id,
                warehouse_id: sale.warehouse_id || null, quantity: item.quantity,
                unit_cost: item.unit_cost || product.average_cost || item.unit_price, user_id: userId,
                notes: `Reversión venta ${sale.sale_number} cancelada - ${item.product_name}`
              }, transaction);
            }
          }
        }
      }

      await sale.update({ status: 'cancelled', internal_notes: reason || 'Venta cancelada' }, { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    res.json({ success: true, message: 'Venta cancelada exitosamente', data: updatedSale });

  } catch (error) {
    logger.error('Error cancelando venta:', error);
    res.status(500).json({ success: false, message: 'Error cancelando venta' });
  }
};

// Marcar como entregada
const markAsDelivered = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const { delivery_date } = req.body;

    const sale = await Sale.findOne({ where: { id, tenant_id: tenantId } });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (sale.status !== 'confirmed') {
      return res.status(400).json({ success: false, message: 'Solo se pueden marcar como entregadas las ventas confirmadas' });
    }

    await sale.update({ status: 'delivered', delivery_date: delivery_date || new Date() });

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    res.json({ success: true, message: 'Venta marcada como entregada', data: updatedSale });
  } catch (error) {
    logger.error('Error actualizando venta:', error);
    res.status(500).json({ success: false, message: 'Error actualizando venta' });
  }
};

// Registrar pago
const registerPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const userId = req.user.id;
    const { amount, payment_method, payment_date, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    const sale = await Sale.findOne({ where: { id, tenant_id: tenantId } });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (sale.status === 'draft') {
      return res.status(400).json({ success: false, message: 'No se puede registrar pago en una venta en borrador' });
    }

    const paid_amount = parseFloat(sale.paid_amount || 0) + parseFloat(amount);
    let payment_status = 'pending';
    if (paid_amount >= parseFloat(sale.total_amount)) payment_status = 'paid';
    else if (paid_amount > 0) payment_status = 'partial';

    const payment_history = sale.payment_history || [];
    payment_history.push({
      date: payment_date || new Date(),
      amount: parseFloat(amount),
      method: payment_method || sale.payment_method || 'Efectivo',
      user_id: userId,
      notes: notes || null
    });

    await sale.update({ paid_amount, payment_status, payment_method: payment_method || sale.payment_method, payment_history });

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    res.json({ success: true, message: 'Pago registrado exitosamente', data: updatedSale });
  } catch (error) {
    logger.error('Error registrando pago:', error);
    res.status(500).json({ success: false, message: 'Error registrando pago' });
  }
};

// Eliminar venta (solo si está en draft)
const deleteById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const sale = await Sale.findOne({ where: { id, tenant_id: tenantId } });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (sale.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Solo se pueden eliminar ventas en borrador' });
    }
    await sale.destroy();
    res.json({ success: true, message: 'Venta eliminada exitosamente' });
  } catch (error) {
    logger.error('Error eliminando venta:', error);
    res.status(500).json({ success: false, message: 'Error eliminando venta' });
  }
};

// Estadísticas
const getStats = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { from_date, to_date } = req.query;
    const where = { tenant_id: tenantId };
    if (from_date && to_date) where.sale_date = { [Op.between]: [from_date, to_date] };
    else if (from_date) where.sale_date = { [Op.gte]: from_date };
    else if (to_date) where.sale_date = { [Op.lte]: to_date };

    const stats = await Sale.findAll({
      where,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_amount'],
        [sequelize.fn('SUM', sequelize.literal("CASE WHEN payment_status = 'pending' THEN total_amount ELSE 0 END")), 'pending_amount'],
      ],
      raw: true
    });

    res.json({
      success: true,
      data: {
        total_sales:    parseInt(stats[0].total_sales)    || 0,
        total_amount:   parseFloat(stats[0].total_amount) || 0,
        pending_amount: parseFloat(stats[0].pending_amount) || 0,
        sales_count:    parseInt(stats[0].total_sales)    || 0
      }
    });
  } catch (error) {
    logger.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo estadísticas' });
  }
};

// Generar PDF
const generatePDF = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [
        { model: Customer, as: 'customer' },
        { model: SaleItem, as: 'items', include: [{ model: Product, as: 'product' }] }
      ]
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
    generateSalePDF(res, sale, tenant);
  } catch (error) {
    logger.error('Error generando PDF:', error);
    res.status(500).json({ success: false, message: 'Error generando PDF' });
  }
};

const generatePaymentReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const paymentIndex = req.query.payment_index !== undefined ? parseInt(req.query.payment_index) : -1;
    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [{ model: Customer, as: 'customer' }, { model: SaleItem, as: 'items' }]
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    const history = sale.payment_history || [];
    let payment, idx;
    if (history.length > 0) {
      idx = paymentIndex === -1 ? history.length - 1 : Math.min(paymentIndex, history.length - 1);
      payment = { ...history[idx] };
    } else {
      idx = 0;
      payment = { amount: sale.paid_amount || 0, method: sale.payment_method || 'efectivo', date: sale.updated_at || sale.created_at, notes: null };
    }
    payment.index = idx;
    payment.receipt_number = `REC-${sale.sale_number}-${String(idx + 1).padStart(2, '0')}`;
    const tenant = await Tenant.findByPk(tenantId);
    generatePaymentReceiptPDF(res, sale, tenant, payment);
  } catch (e) {
    logger.error('Error generando recibo:', e);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error generando recibo' });
  }
};

// ─── Función auxiliar para generar número de venta ───────────────────────────
// FACTURAS: usa el consecutivo de la resolución DIAN activa (prefijo + número)
// REMISIONES / COTIZACIONES: consecutivo interno REM-YYYY-XXXX / COT-YYYY-XXXX
async function generateSaleNumber(tenant_id, document_type, transaction) {
  if (document_type !== 'factura') {
    // Consecutivo interno (sin cambios respecto al original)
    const prefix = document_type === 'remision' ? 'REM' : 'COT';
    const year = new Date().getFullYear();
    const lastSale = await Sale.findOne({
      where: { tenant_id, sale_number: { [Op.like]: `${prefix}-${year}-%` } },
      order: [['sale_number', 'DESC']],
      transaction,
    });
    let sequence = 1;
    if (lastSale) {
      const lastNumber = lastSale.sale_number.split('-').pop();
      sequence = parseInt(lastNumber) + 1;
    }
    return `${prefix}-${year}-${sequence.toString().padStart(4, '0')}`;
  }

  // ── FACTURA: buscar resolución DIAN activa y obtener consecutivo ──────────
  // Se intenta con resolución de producción primero, luego pruebas
  const resolution = await DianResolution.findOne({
    where: { tenant_id, is_active: true, document_type: 'invoice' },
    order: [['is_test', 'ASC']], // producción (false) primero
    transaction,
  });

  if (resolution) {
    // El dian_invoice_number definitivo se asigna al enviar (con lock en dianService)
    // El sale_number usa el consecutivo actual como referencia provisional
    return `${resolution.prefix}${resolution.current_number}`;
  }

  // Fallback: si no hay resolución DIAN configurada, usar numeración interna
  const year = new Date().getFullYear();
  const lastSale = await Sale.findOne({
    where: { tenant_id, sale_number: { [Op.like]: `FAC-${year}-%` } },
    order: [['sale_number', 'DESC']],
    transaction,
  });
  let sequence = 1;
  if (lastSale) {
    const lastNumber = lastSale.sale_number.split('-').pop();
    sequence = parseInt(lastNumber) + 1;
  }
  return `FAC-${year}-${sequence.toString().padStart(4, '0')}`;
}

// Enviar PDF por WhatsApp — enlace temporal JWT (sin Cloudinary)
const sendWhatsApp = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [
        { model: Customer, as: 'customer' },
        { model: SaleItem, as: 'items', include: [{ model: Product, as: 'product' }] }
      ]
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });

    const customerPhone = sale.customer?.phone || sale.customer?.mobile || sale.customer_phone;
    if (!customerPhone) {
      return res.status(400).json({ success: false, message: 'El cliente no tiene número de teléfono registrado.' });
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const TYPES = { factura: 'Factura', remision: 'Remisión', cotizacion: 'Cotización' };
    const docLabel = TYPES[sale.document_type] || 'Documento';

    // Token JWT temporal (48h) — da acceso público al PDF sin sesión
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { type: 'pdf_share', saleId: id, tenantId },
      process.env.JWT_SECRET,
      { expiresIn: '48h' }
    );

    const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');
    const pdfUrl  = `${backendUrl}/api/public/pdf/${token}`;
    const caption = `Hola! Aquí tienes tu ${docLabel} *${sale.sale_number}* de *${tenant.company_name}*.\nTotal: *$${Number(sale.total_amount).toLocaleString('es-CO')}*\n\n📄 Descarga tu documento:\n${pdfUrl}\n\nCualquier duda estamos a tu servicio. 😊`;

    const result = await whatsappService.sendText(customerPhone, caption);

    res.json({
      success: true,
      waLink:  result.waLink,
      pdfUrl,
      message: `Enlace listo para ${customerPhone}. Se abrirá WhatsApp con el mensaje.`,
    });
  } catch (error) {
    logger.error('Error generando enlace WhatsApp:', error);
    res.status(500).json({ success: false, message: error.message || 'Error al generar enlace de WhatsApp' });
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  confirm,
  cancel,
  markAsDelivered,
  registerPayment,
  delete: deleteById,
  getStats,
  generatePDF,
  sendWhatsApp,
  generatePaymentReceipt
};