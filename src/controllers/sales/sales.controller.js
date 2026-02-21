// backend/src/controllers/sales/sales.controller.js
const { Sale, SaleItem, Customer, Product, Tenant, InventoryMovement } = require('../../models');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');
const { generateSalePDF } = require('../../services/pdfService');
const { createMovement } = require('../inventory/movements.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

// Obtener todas las ventas
const getAll = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { status, customer_id, from_date, to_date, document_type, search, customer_name, vehicle_plate, limit = 50, offset = 0 } = req.query;

    const where = { tenant_id: tenantId };

    // Filtros opcionales
    if (status) where.status = status;
    if (customer_id) where.customer_id = customer_id;
    if (document_type) where.document_type = document_type;
    
    // Filtro específico por nombre de cliente
    if (customer_name) {
      where.customer_name = { [Op.iLike]: `%${customer_name}%` };
    }
    
    // Filtro específico por placa de vehículo
    if (vehicle_plate) {
      where.vehicle_plate = { [Op.iLike]: `%${vehicle_plate}%` };
    }
    
    // Búsqueda general por término (solo si no hay filtros específicos)
    if (search && !customer_name && !vehicle_plate) {
      where[Op.or] = [
        { sale_number: { [Op.iLike]: `%${search}%` } },
        { customer_name: { [Op.iLike]: `%${search}%` } },
        { customer_tax_id: { [Op.iLike]: `%${search}%` } },
        { customer_email: { [Op.iLike]: `%${search}%` } },
        { customer_phone: { [Op.iLike]: `%${search}%` } },
        { vehicle_plate: { [Op.iLike]: `%${search}%` } }
      ];
    }
    
    if (from_date && to_date) {
      where.sale_date = {
        [Op.between]: [from_date, to_date]
      };
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
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku']
            }
          ]
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
    console.error('Error al obtener ventas:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener ventas',
      error: error.message
    });
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
        {
          model: Customer,
          as: 'customer'
        },
        {
          model: SaleItem,
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

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    res.json({
      success: true,
      data: sale
    });
  } catch (error) {
    console.error('Error al obtener venta:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener venta',
      error: error.message
    });
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
    
    // Si se proporciona customer_id, obtener datos del cliente
    if (customer_id) {
      const customer = await Customer.findOne({
        where: { id: customer_id, tenant_id: tenantId },
      });
      
      if (!customer) {
        await transaction.rollback();
        return res.status(404).json({ 
          success: false,
          message: 'Cliente no encontrado' 
        });
      }
      
      customerInfo = {
        customer_name: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
        customer_tax_id: customer.tax_id,
        customer_email: customer.email,
        customer_phone: customer.phone || customer.mobile,
        customer_address: customer.address,
      };
    }
    // Si no hay customer_id pero hay customer_data, crear cliente rápido
    else if (customer_data) {
      const { full_name: cdFullName, ...cdRest } = customer_data;
      let cdNames = {};
      if (cdFullName) {
        const parts = cdFullName.trim().split(/\s+/);
        cdNames = { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '' };
      }
      const newCustomer = await Customer.create({
        tenant_id: tenantId,
        ...cdRest,
        ...cdNames,
        is_active: true,
      }, { transaction });
      
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
      return res.status(400).json({ 
        success: false,
        message: 'Debe proporcionar customer_id o customer_data' 
      });
    }
    
    // Generar número de venta
    const saleNumber = await generateSaleNumber(tenantId, document_type);
    
    // Calcular totales
    let subtotal = 0;
    let tax_amount = 0;
    let discount_amount = 0;
    
    // Validar productos y calcular
    const saleItems = [];
    for (const item of items) {
      const itemType = item.item_type || 'product';

      // ── Línea libre ad-hoc (sin product_id) ──────────────
      if (itemType === 'free_line') {
        const fs  = item.quantity * item.unit_price;
        const fd  = fs * (item.discount_percentage || 0) / 100;
        const ftb = fs - fd;
        let ftax = 0, ftotal = 0, ftaxpct = 0;
        if (item.tax_percentage > 0) {
          ftaxpct = item.tax_percentage;
          ftax    = ftb * ftaxpct / 100;
          ftotal  = ftb + ftax;
        } else { ftotal = ftb; }
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

      // ── Producto o servicio del catálogo ─────────────────
      const product = await Product.findOne({
        where: { id: item.product_id, tenant_id: tenantId },
      });
      
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({ 
          success: false,
          message: `Producto ${item.product_id} no encontrado` 
        });
      }
      
      const itemSubtotal = item.quantity * item.unit_price;
      const itemDiscount = itemSubtotal * (item.discount_percentage || 0) / 100;
      const itemTaxBase = itemSubtotal - itemDiscount;
      
      // ✅ CORREGIDO: Considerar si el precio incluye IVA
      // 🆕 NUEVO: Las remisiones NO llevan IVA, solo las facturas
      let itemTax = 0;
      let itemTotal = 0;
      let itemBaseWithoutTax = 0;
      let taxPercentage = 0; // Declarar aquí para que esté disponible en todo el scope
      
      if (product.has_tax === false) {
        // Producto exento de IVA
        itemTax = 0;
        itemBaseWithoutTax = itemTaxBase;
        itemTotal = itemTaxBase;
        taxPercentage = 0;
      } else {
        taxPercentage = item.tax_percentage || product.tax_percentage || 19;
        const priceIncludesTax = product.price_includes_tax || false;

        if (priceIncludesTax) {
          // El precio YA INCLUYE el IVA - extraerlo
          itemTax = (itemTaxBase * taxPercentage) / (100 + taxPercentage);
          itemBaseWithoutTax = itemTaxBase - itemTax;
          itemTotal = itemTaxBase;
        } else {
          // El precio NO incluye IVA - sumarlo
          itemTax = itemTaxBase * taxPercentage / 100;
          itemBaseWithoutTax = itemTaxBase;
          itemTotal = itemTaxBase + itemTax;
        }
      }
      
      subtotal += itemSubtotal;
      discount_amount += itemDiscount;
      tax_amount += itemTax;
      
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
    
    // ✅ CORREGIDO: Sumar los totales individuales (ya consideran si IVA está incluido)
    const total_amount = saleItems.reduce((sum, item) => sum + item.total, 0);
    
    // ✨ NUEVO: Preparar datos de venta incluyendo vehicle_plate
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
    };

    if (vehicle_plate && vehicle_plate.trim()) {
      saleData.vehicle_plate = vehicle_plate.trim().toUpperCase();
    }
    if (mileage !== undefined && mileage !== null && mileage !== '') {
      const parsedMileage = parseInt(mileage);
      if (!isNaN(parsedMileage)) {
        saleData.mileage = parsedMileage;
      }
    }

    // Crear venta
    const sale = await Sale.create(saleData, { transaction });

    // Crear items
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

    // Recargar con relaciones (DESPUÉS del commit)
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
    console.error('Error creando venta:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error creando venta', 
      error: error.message 
    });
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

    // Si viene customer_id válido, actualizar info del cliente en la venta
    if (updateData.customer_id) {
      const customer = await Customer.findOne({
        where: { id: updateData.customer_id, tenant_id: tenantId }
      });
      if (customer) {
        updateData.customer_name = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
        updateData.customer_tax_id = customer.tax_id;
        updateData.customer_email = customer.email;
        updateData.customer_phone = customer.phone || customer.mobile;
        updateData.customer_address = customer.address;
      }
    }

    const document_type = updateData.document_type || sale.document_type;

    // Recalcular y guardar items si vienen en el body
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

          if (item.tax_percentage > 0) {
            ftaxpct = item.tax_percentage;
            ftax    = ftb * ftaxpct / 100;
            ftotal  = ftb + ftax;
          }

          subtotal += fs; discount_amount += fd; tax_amount += ftax;
          newItems.push({
            sale_id: id, tenant_id: tenantId, item_type: 'free_line',
            product_id: null, product_name: item.product_name, product_sku: null,
            quantity: item.quantity, unit_price: item.unit_price,
            discount_percentage: item.discount_percentage || 0, discount_amount: fd,
            tax_percentage: ftaxpct, tax_amount: ftax,
            subtotal: fs, total: ftotal, unit_cost: 0,
          });
          continue;
        }

        const product = await Product.findOne({
          where: { id: item.product_id, tenant_id: tenantId }
        });

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

        subtotal        += itemSubtotal;
        discount_amount += itemDiscount;
        tax_amount      += itemTax;

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

      for (const item of newItems) {
        await SaleItem.create(item, { transaction });
      }

      const total_amount = newItems.reduce((sum, i) => sum + i.total, 0);
      updateData.subtotal        = subtotal;
      updateData.tax_amount      = tax_amount;
      updateData.discount_amount = discount_amount;
      updateData.total_amount    = total_amount;
    }

    await sale.update(updateData, { transaction });
    await transaction.commit();

    const updatedSale = await Sale.findByPk(id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: Customer, as: 'customer' }
      ]
    });

    res.json({ success: true, message: 'Venta actualizada exitosamente', data: updatedSale });

  } catch (error) {
    await transaction.rollback();
    console.error('Error actualizando venta:', error);
    res.status(500).json({ success: false, message: 'Error actualizando venta', error: error.message });
  }
};

// Confirmar venta
const confirm = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const userId = req.user_id || req.user?.id;
    const { payment_method, paid_amount } = req.body;

    // Validar que se proporcione método de pago
    if (!payment_method) {
      return res.status(400).json({
        success: false,
        message: 'Debe especificar el método de pago'
      });
    }

    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [{ model: SaleItem, as: 'items' }]
    });

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    if (sale.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden confirmar ventas en borrador'
      });
    }

    const transaction = await sequelize.transaction();
    try {
      // Pre-validar stock de TODOS los items antes de mover
      const stockErrors = [];
      for (const item of sale.items) {
        if (item.item_type === 'service' || item.item_type === 'free_line') continue;
        if (!item.product_id) continue;
        const prodCheck = await Product.findOne({
          where: { id: item.product_id, tenant_id: tenantId },
          transaction
        });
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
        return res.status(400).json({
          success: false,
          message: `Stock insuficiente: ${stockErrors.join(', ')}`
        });
      }

      // Crear movimiento de salida por cada item
      for (const item of sale.items) {
        // Servicios y líneas libres no mueven inventario
        if (item.item_type === 'service' || item.item_type === 'free_line') continue;
        if (item.product_id) {
          const product = await Product.findOne({
            where: { id: item.product_id, tenant_id: tenantId },
            transaction
          });

          if (product && product.track_inventory) {
            await createMovement({
              tenant_id: tenantId,
              movement_type: 'salida',
              movement_reason: 'sale',
              reference_type: 'sale',
              reference_id: sale.id,
              product_id: item.product_id,
              warehouse_id: sale.warehouse_id || null,
              quantity: item.quantity,
              unit_cost: item.unit_cost || product.average_cost || item.unit_price,
              user_id: userId,
              movement_date: sale.sale_date ? new Date(sale.sale_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
              notes: `Venta ${sale.sale_number} - ${item.product_name}`
            }, transaction);
          }
        }
      }

      // Preparar datos de actualización con pago
      const amountPaid = paid_amount !== undefined ? parseFloat(paid_amount) : parseFloat(sale.total_amount);
      
      const updateData = { 
        status: 'completed',
        payment_method: payment_method,
        paid_amount: amountPaid
      };

      // Determinar el estado de pago
      if (amountPaid >= parseFloat(sale.total_amount)) {
        updateData.payment_status = 'paid';
      } else if (amountPaid > 0) {
        updateData.payment_status = 'partial';
      } else {
        updateData.payment_status = 'pending';
      }

      await sale.update(updateData, { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const updatedSale = await Sale.findByPk(id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: Customer, as: 'customer' }
      ]
    });

    // 🔔 Verificación automática de alertas
    const product_ids = sale.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenantId);

    res.json({
      success: true,
      message: 'Venta confirmada y pago registrado exitosamente',
      data: updatedSale
    });
  } catch (error) {
    console.error('Error confirmando venta:', error);
    res.status(500).json({
      success: false,
      message: 'Error confirmando venta',
      error: error.message
    });
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

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    if (sale.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'La venta ya está cancelada'
      });
    }

    const transaction = await sequelize.transaction();
    try {
      // Si ya estaba confirmada o entregada, revertir stock con movimiento de entrada
      if (sale.status === 'completed' || sale.status === 'delivered') {
        for (const item of sale.items) {
          if (item.product_id) {
            const product = await Product.findOne({
              where: { id: item.product_id, tenant_id: tenantId },
              transaction
            });

            if (product && product.track_inventory) {
              await createMovement({
                tenant_id: tenantId,
                movement_type: 'entrada',
                movement_reason: 'sale_reversal',
                reference_type: 'sale',
                reference_id: sale.id,
                product_id: item.product_id,
                warehouse_id: sale.warehouse_id || null,
                quantity: item.quantity,
                unit_cost: item.unit_cost || product.average_cost || item.unit_price,
                user_id: userId,
                notes: `Reversión venta ${sale.sale_number} cancelada - ${item.product_name}`
              }, transaction);
            }
          }
        }
      }

      await sale.update({
        status: 'cancelled',
        internal_notes: reason || 'Venta cancelada'
      }, { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const updatedSale = await Sale.findByPk(id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: Customer, as: 'customer' }
      ]
    });

    res.json({
      success: true,
      message: 'Venta cancelada exitosamente',
      data: updatedSale
    });
  } catch (error) {
    console.error('Error cancelando venta:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelando venta',
      error: error.message
    });
  }
};

// Marcar como entregada
const markAsDelivered = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const { delivery_date } = req.body;
    
    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId }
    });
    
    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }
    
    if (sale.status !== 'confirmed') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden marcar como entregadas las ventas confirmadas'
      });
    }
    
    await sale.update({ 
      status: 'delivered',
      delivery_date: delivery_date || new Date()
    });
    
    const updatedSale = await Sale.findByPk(id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: Customer, as: 'customer' }
      ]
    });
    
    res.json({
      success: true,
      message: 'Venta marcada como entregada',
      data: updatedSale
    });
  } catch (error) {
    console.error('Error actualizando venta:', error);
    res.status(500).json({
      success: false,
      message: 'Error actualizando venta',
      error: error.message
    });
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
      return res.status(400).json({
        success: false,
        message: 'El monto debe ser mayor a 0'
      });
    }

    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId }
    });

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    if (sale.status === 'draft') {
      return res.status(400).json({
        success: false,
        message: 'No se puede registrar pago en una venta en borrador'
      });
    }

    const paid_amount = parseFloat(sale.paid_amount || 0) + parseFloat(amount);
    let payment_status = 'pending';

    if (paid_amount >= parseFloat(sale.total_amount)) {
      payment_status = 'paid';
    } else if (paid_amount > 0) {
      payment_status = 'partial';
    }

    // Obtener historial actual o inicializar array vacío
    const payment_history = sale.payment_history || [];
    
    // Agregar nuevo pago al historial
    payment_history.push({
      date: payment_date || new Date(),
      amount: parseFloat(amount),
      method: payment_method || sale.payment_method || 'Efectivo',
      user_id: userId,
      notes: notes || null
    });

    await sale.update({
      paid_amount,
      payment_status,
      payment_method: payment_method || sale.payment_method,
      payment_history
    });

    const updatedSale = await Sale.findByPk(id, {
      include: [
        { model: SaleItem, as: 'items' },
        { model: Customer, as: 'customer' }
      ]
    });

    res.json({
      success: true,
      message: 'Pago registrado exitosamente',
      data: updatedSale
    });
  } catch (error) {
    console.error('Error registrando pago:', error);
    res.status(500).json({
      success: false,
      message: 'Error registrando pago',
      error: error.message
    });
  }
};

// Eliminar venta (solo si está en draft)
const deleteById = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    
    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId }
    });
    
    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }
    
    if (sale.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden eliminar ventas en borrador'
      });
    }
    
    await sale.destroy();
    
    res.json({
      success: true,
      message: 'Venta eliminada exitosamente'
    });
  } catch (error) {
    console.error('Error eliminando venta:', error);
    res.status(500).json({
      success: false,
      message: 'Error eliminando venta',
      error: error.message
    });
  }
};

// Obtener estadísticas
const getStats = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { from_date, to_date } = req.query;
    
    const where = { tenant_id: tenantId };
    
    if (from_date && to_date) {
      where.sale_date = {
        [Op.between]: [from_date, to_date]
      };
    } else if (from_date) {
      where.sale_date = { [Op.gte]: from_date };
    } else if (to_date) {
      where.sale_date = { [Op.lte]: to_date };
    }
    
    const stats = await Sale.findAll({
      where,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_amount'],
        [sequelize.fn('SUM', sequelize.literal('CASE WHEN payment_status = \'pending\' THEN total_amount ELSE 0 END')), 'pending_amount'],
      ],
      raw: true
    });
    
    res.json({
      success: true,
      data: {
        total_sales: parseInt(stats[0].total_sales) || 0,
        total_amount: parseFloat(stats[0].total_amount) || 0,
        pending_amount: parseFloat(stats[0].pending_amount) || 0,
        sales_count: parseInt(stats[0].total_sales) || 0
      }
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estadísticas',
      error: error.message
    });
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
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product' }]
        }
      ]
    });
    
    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    // Obtener datos del tenant para el branding del PDF
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado'
      });
    }

    // Genera el PDF y hace pipe directamente a la respuesta
    generateSalePDF(res, sale, tenant);

  } catch (error) {
    console.error('Error generando PDF:', error);
    res.status(500).json({
      success: false,
      message: 'Error generando PDF',
      error: error.message
    });
  }
};

// Función auxiliar para generar número de venta
async function generateSaleNumber(tenant_id, document_type) {
  const prefix = document_type === 'remision' ? 'REM' : 
                 document_type === 'factura' ? 'FAC' : 'COT';
  
  const year = new Date().getFullYear();
  
  const lastSale = await Sale.findOne({
    where: {
      tenant_id,
      sale_number: {
        [Op.like]: `${prefix}-${year}-%`
      }
    },
    order: [['sale_number', 'DESC']],
  });
  
  let sequence = 1;
  if (lastSale) {
    const lastNumber = lastSale.sale_number.split('-').pop();
    sequence = parseInt(lastNumber) + 1;
  }
  
  return `${prefix}-${year}-${sequence.toString().padStart(4, '0')}`;
}

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
  generatePDF
};