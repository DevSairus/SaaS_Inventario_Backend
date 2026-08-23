const logger = require('../../config/logger');
// backend/src/controllers/sales/sales.controller.js
const { Sale, SaleItem, Customer, Product, Vehicle, Tenant, InventoryMovement, DianResolution, CustomerReturn, User, Branch, Warehouse, SaleDiagnosisMark, DiagramTemplate } = require('../../models');
const audit = require('../../utils/audit');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');
const { generateSalePDF, generateSalePDFBuffer, generatePaymentReceiptPDF, generatePaymentReceiptPDFBuffer } = require('../../services/pdfService');
const whatsappService = require('../../services/whatsappService');
const { createMovement } = require('../inventory/movements.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const dianService = require('../../services/dian/dianService');
const taxService = require('../../services/taxService');
const { getOpenSession, isTreasuryEnabled } = require('../../services/finance/cashSession.service');
const { resolveBranchFilter } = require('../../utils/branchFilter');

// Descuento GLOBAL de la venta/cotización (independiente de discount_amount,
// que es la suma de los descuentos por línea) -- 'fixed' es un monto fijo
// (tope: no supera el total antes de descuento), 'percentage' es un % de
// ese mismo total (ya con impuestos y descuentos de línea aplicados). Se
// resta DESPUÉS de impuestos -- mismo criterio que ya usa el descuento
// global de las OT (ver resolveDiscountAmount en workOrders.controller.js).
function resolveGlobalDiscount(type, value, preDiscountTotal) {
  const v = parseFloat(value) || 0;
  if (v <= 0) return 0;
  if (type === 'percentage') {
    return Math.round(preDiscountTotal * Math.min(v, 100) / 100);
  }
  return Math.min(v, preDiscountTotal);
}

// Obtener todas las ventas
const getAll = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { status, quote_status, customer_id, from_date, to_date, document_type, search, customer_name, vehicle_plate, dian_status, quote_view, limit = 50, offset = 0 } = req.query;
    // Cap de seguridad — evita requests que traigan miles de ventas en memoria
    const safeLimit  = Math.min(Math.max(1, parseInt(limit)  || 50), 200);
    const safeOffset = Math.max(0, parseInt(offset) || 0);

    const where = { tenant_id: tenantId };

    // Para roles no-admin, se ignora el branch_id de query y se fuerza la
    // sede autorizada del usuario. Admin/super_admin conservan el filtro
    // opcional (ej: viendo el historial de una sede específica distinta a la
    // activa; si no lo envían, ven todas las sedes del tenant).
    const branch_id = resolveBranchFilter(req);
    if (branch_id) where.branch_id = branch_id;

    // Una venta nace en 'draft' con document_type=null (ver create() — el
    // tipo de documento se elige recién al confirmar). Hasta ese momento es,
    // en la práctica, una cotización: QuotesPage la necesita listada aunque
    // nunca haya tenido document_type='cotizacion' explícito. `quote_view`
    // trae borradores + cualquier venta ya tipada como cotización; el listado
    // normal de Ventas, en cambio, no debe mostrar borradores (son
    // cotizaciones, no ventas confirmadas) salvo que se pida un status puntual.
    if (quote_view === 'true') {
      where[Op.or] = [{ status: 'draft' }, { document_type: 'cotizacion' }];
    } else {
      if (status) where.status = status;
      else where.status = { [Op.ne]: 'draft' };
      if (document_type) where.document_type = document_type;
    }
    if (quote_status) where.quote_status = quote_status;
    if (customer_id) where.customer_id = customer_id;
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
          model: Branch,
          as: 'branch',
          attributes: ['id', 'name', 'code']
        },
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }]
        }
      ],
      order: [['sale_date', 'DESC'], ['created_at', 'DESC']],
      limit: safeLimit,
      offset: safeOffset,
    });

    const total = await Sale.count({ where });

    res.json({
      success: true,
      data: sales,
      pagination: {
        total,
        limit: safeLimit,
        offset: safeOffset,
        hasMore: total > (safeOffset + safeLimit),
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
        { model: User, as: 'creator', attributes: ['id', 'first_name', 'last_name'], required: false },
        {
          model: SaleItem,
          as: 'items',
          include: [
            { model: Product, as: 'product' },
            { model: User, as: 'item_technician', attributes: ['id', 'first_name', 'last_name'], required: false },
          ]
        },
        {
          model: CustomerReturn,
          as: 'returns',
          attributes: ['id', 'return_number', 'return_date', 'total_amount', 'status', 'reason'],
          required: false,
        }
      ]
    });

    if (!sale) {
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }

    const saleData = sale.toJSON();
    saleData.created_by_name = saleData.creator
      ? [saleData.creator.first_name, saleData.creator.last_name].filter(Boolean).join(' ')
      : null;

    res.json({ success: true, data: saleData });
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
      vehicle_type,
      vehicle_brand,
      vehicle_model,
      vehicle_year,
      mileage,
      technician_id,
      document_type = null,
      sale_date,
      due_date,
      payment_terms,
      opportunity_id = null,
      global_discount_type = 'fixed',
      global_discount_value = 0,
    } = req.body;

    if (!['fixed', 'percentage'].includes(global_discount_type)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "global_discount_type debe ser 'fixed' o 'percentage'" });
    }
    // El descuento global mueve el total a cobrar -- el técnico no debe
    // poder aplicarlo (mismo criterio que el descuento global de OT).
    if ((parseFloat(global_discount_value) || 0) > 0 && req.user.role === 'technician') {
      await transaction.rollback();
      return res.status(403).json({ success: false, message: 'No tienes permiso para aplicar descuentos' });
    }

    let finalCustomerId = customer_id;
    let customerInfo = {};
    let customerPaymentTerms = null;

    if (customer_id) {
      const customer = await Customer.findOne({ where: { id: customer_id, tenant_id: tenantId } });
      if (!customer) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
      }
      customerPaymentTerms = customer.payment_terms || null;
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

    // ── Número de venta: se asigna al CONFIRMAR ───────────────────────────────
    // El borrador no tiene tipo ni numeración hasta que el usuario confirme
    // y elija el tipo de documento en el modal.
    const saleNumber = `BORRADOR-${Date.now()}`;

    // Calcular totales
    let subtotal = 0;
    let tax_amount = 0;
    let discount_amount = 0;
    const saleItems = [];

    // Batch-load de todos los productos en 1 query (elimina N+1)
    const productIds = items
      .filter(i => (i.item_type || 'product') !== 'free_line' && i.product_id)
      .map(i => i.product_id);
    const productRows = productIds.length
      ? await Product.findAll({ where: { id: { [Op.in]: productIds }, tenant_id: tenantId }, transaction })
      : [];
    const productMap = Object.fromEntries(productRows.map(p => [p.id, p]));

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
          technician_id: item.technician_id || null,
        });
        continue;
      }

      const product = productMap[item.product_id];
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: `Producto ${item.product_id} no encontrado` });
      }

      // Usar taxService para calcular todos los impuestos
      const taxes = taxService.calculateItemTaxes(item, product, 'sale');

      subtotal += taxes.base; discount_amount += (item.quantity * item.unit_price - taxes.base); tax_amount += taxes.total_taxes;
      saleItems.push({
        tenant_id: tenantId,
        item_type: product.product_type === 'service' ? 'service' : 'product',
        product_id: product.id,
        product_name: product.name,
        product_sku: product.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percentage: item.discount_percentage || 0,
        discount_amount: item.quantity * item.unit_price - taxes.base,
        tax_percentage: taxes.iva.rate,
        tax_amount: taxes.iva.amount,
        inc_rate: taxes.inc.rate,
        inc_amount: taxes.inc.amount,
        ica_rate: taxes.ica.rate,
        ica_amount: taxes.ica.amount,
        subtotal: taxes.base,
        total: taxes.total_line,
        unit_cost: product.product_type === 'service' ? 0 : (product.average_cost || 0),
        technician_id: item.technician_id || null,
      });
    }

    const preDiscountTotal = saleItems.reduce((sum, i) => sum + i.total, 0);
    const global_discount_amount = resolveGlobalDiscount(global_discount_type, global_discount_value, preDiscountTotal);
    const total_amount = preDiscountTotal - global_discount_amount;

    // Si no viene bodega explícita, usar la bodega default de la sede activa
    // como respaldo (el frontend ya la precarga, pero esto protege contra
    // integraciones/clientes que no la envíen).
    let effectiveWarehouseId = (warehouse_id && uuidRegex.test(warehouse_id)) ? warehouse_id : null;
    if (!effectiveWarehouseId && req.branch_id) {
      const branchWarehouse = await Warehouse.findOne({
        where: { branch_id: req.branch_id, tenant_id: tenantId, is_active: true },
        order: [['is_default', 'DESC'], ['created_at', 'ASC']],
        transaction,
      });
      effectiveWarehouseId = branchWarehouse?.id || null;
    }

    // Calcular retenciones si hay cliente configurado
    let retentions = { retefuente: { rate: 0, amount: 0 }, reteiva: { rate: 0, amount: 0 }, reteica: { rate: 0, amount: 0 }, total: 0 };
    if (finalCustomerId) {
      const customer = await Customer.findByPk(finalCustomerId, { transaction });
      const tenant = await Tenant.findByPk(tenantId, { attributes: ['tax_config'], transaction });
      if (customer && tenant) {
        retentions = taxService.calculateRetentions(saleItems, tenant.tax_config || {}, customer.retention_config || {});
      }
    }

    const tax_breakdown = taxService.buildTaxBreakdown(saleItems, retentions);

    // Resolver plazo de pago: el que venga explícito en el body, si no, el
    // plazo por defecto configurado en el cliente (en días).
    const effectivePaymentTerms = payment_terms !== undefined && payment_terms !== null
      ? parseInt(payment_terms)
      : customerPaymentTerms;

    let effectiveDueDate = due_date || null;
    if (!effectiveDueDate && effectivePaymentTerms) {
      const base = sale_date ? new Date(sale_date) : new Date();
      base.setDate(base.getDate() + effectivePaymentTerms);
      effectiveDueDate = base.toISOString().split('T')[0];
    }

    const saleData = {
      tenant_id: tenantId,
      branch_id: req.branch_id || null,
      sale_number: saleNumber,
      // document_type: null — se asigna al confirmar, no al crear
      sale_date: sale_date || new Date(),
      due_date: effectiveDueDate,
      payment_terms: effectivePaymentTerms,
      customer_id: finalCustomerId,
      ...customerInfo,
      warehouse_id: effectiveWarehouseId,
      subtotal,
      tax_amount,
      discount_amount,
      global_discount_type,
      global_discount_value: parseFloat(global_discount_value) || 0,
      global_discount_amount,
      total_amount,
      payment_method,
      payment_status: 'pending',
      notes,
      status: 'draft',
      created_by: userId,
      // DIAN: el tipo de documento se asigna al confirmar, no al crear
      dian_status: 'not_applicable',
      // Retenciones
      retefuente_rate:   retentions.retefuente.rate,
      retefuente_amount: retentions.retefuente.amount,
      reteiva_rate:      retentions.reteiva.rate,
      reteiva_amount:    retentions.reteiva.amount,
      reteica_rate:      retentions.reteica.rate,
      reteica_amount:    retentions.reteica.amount,
      total_retentions:  retentions.total,
      tax_breakdown,
    };

    // ── Campo vehículo: respetar configuración del tenant ────────────────────
    // El tenant puede desactivar el campo placa/km en features.vehicle_field_enabled = false
    const tenantCfg = await Tenant.findByPk(tenantId, { attributes: ['features'] });
    const vehicleEnabled = tenantCfg?.features?.vehicle_field_enabled !== false; // default: habilitado

    if (vehicleEnabled) {
      if (vehicle_plate && vehicle_plate.trim()) {
        saleData.vehicle_plate = vehicle_plate.trim().toUpperCase();
      }
      if (vehicle_type && vehicle_type.trim()) {
        saleData.vehicle_type = vehicle_type.trim();
      }
      if (vehicle_brand && vehicle_brand.trim()) {
        saleData.vehicle_brand = vehicle_brand.trim();
      }
      if (vehicle_model && vehicle_model.trim()) {
        saleData.vehicle_model = vehicle_model.trim();
      }
      if (vehicle_year !== undefined && vehicle_year !== null && vehicle_year !== '') {
        const parsedYear = parseInt(vehicle_year);
        if (!isNaN(parsedYear)) saleData.vehicle_year = parsedYear;
      }
      if (mileage !== undefined && mileage !== null && mileage !== '') {
        const parsedMileage = parseInt(mileage);
        if (!isNaN(parsedMileage)) saleData.mileage = parsedMileage;
      }
    }

    // Técnico asignado — igual que en update(), se resuelve el nombre desde
    // User para no depender de un join en cada lectura/PDF posterior.
    if (technician_id && uuidRegex.test(technician_id)) {
      const technician = await User.findOne({ where: { id: technician_id, tenant_id: tenantId } });
      if (technician) {
        saleData.technician_id = technician.id;
        saleData.technician_name = [technician.first_name, technician.last_name].filter(Boolean).join(' ');
      }
    }

    const sale = await Sale.create(saleData, { transaction });

    // bulkCreate en vez de un .create() por ítem (elimina N+1 — ventas con
    // cientos de líneas hacían decenas de round-trips secuenciales a la DB).
    await SaleItem.bulkCreate(
      saleItems.map(item => ({
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
        inc_rate: item.inc_rate,
        inc_amount: item.inc_amount,
        ica_rate: item.ica_rate,
        ica_amount: item.ica_amount,
        subtotal: item.subtotal,
        total: item.total,
        unit_cost: item.unit_cost,
        notes: null,
        technician_id: item.technician_id || null,
      })),
      { transaction }
    );

    await transaction.commit();

    // ── CRM: si esta cotización nace de una Opportunity del pipeline, la
    // etapa avanza automáticamente (no bloquea la respuesta — mismo
    // criterio que el asiento contable async de más abajo).
    // Fase B.4 volvió las etapas configurables por tenant (CrmPipelineStage),
    // así que acá no se puede asumir que existan las keys fijas 'cotizado'/
    // 'ganado'/'perdido' — se resuelven contra la configuración real del
    // tenant, con 'cotizado' como default (así queda para los tenants que
    // no tocaron el embudo de fábrica) y fallback a la siguiente etapa
    // abierta si el tenant la renombró o la eliminó.
    if (opportunity_id && document_type === 'cotizacion') {
      setImmediate(async () => {
        try {
          const { Opportunity } = require('../../models');
          const { loadStageMap } = require('../../utils/crmPipelineStages');
          const opportunity = await Opportunity.findOne({ where: { id: opportunity_id, tenant_id: tenantId } });
          if (!opportunity) return;

          const stageMap = await loadStageMap(tenantId);
          const currentStage = stageMap[opportunity.stage];
          const updateData = { quote_sale_id: sale.id };

          // Solo se mueve de etapa si sigue abierta — una oportunidad ya
          // ganada/perdida no se reabre por generar una cotización aparte.
          if (currentStage && currentStage.stage_type === 'open') {
            const quotedStage = stageMap['cotizado'] && stageMap['cotizado'].stage_type === 'open'
              ? stageMap['cotizado']
              : Object.values(stageMap)
                  .filter(s => s.stage_type === 'open' && s.sort_order > currentStage.sort_order)
                  .sort((a, b) => a.sort_order - b.sort_order)[0];

            if (quotedStage) {
              updateData.stage = quotedStage.key;
              updateData.stage_changed_at = new Date();
            }
          }

          await opportunity.update(updateData);
        } catch (err) {
          logger.warn(`[crm] Error vinculando cotización ${sale.sale_number} a oportunidad ${opportunity_id}: ${err.message}`);
        }
      });
    }

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

    if ('global_discount_type' in updateData && !['fixed', 'percentage'].includes(updateData.global_discount_type)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "global_discount_type debe ser 'fixed' o 'percentage'" });
    }
    const discountFieldsChanged = 'global_discount_type' in updateData || 'global_discount_value' in updateData;
    // El descuento global mueve el total a cobrar -- el técnico no debe
    // poder aplicarlo (mismo criterio que el descuento global de OT).
    if (discountFieldsChanged) {
      const effValue = updateData.global_discount_value !== undefined ? updateData.global_discount_value : sale.global_discount_value;
      if ((parseFloat(effValue) || 0) > 0 && req.user.role === 'technician') {
        await transaction.rollback();
        return res.status(403).json({ success: false, message: 'No tienes permiso para aplicar descuentos' });
      }
    }

    if ('warehouse_id' in updateData) {
      updateData.warehouse_id = (updateData.warehouse_id && uuidRegex.test(updateData.warehouse_id))
        ? updateData.warehouse_id : null;
    }
    if ('customer_id' in updateData) {
      updateData.customer_id = (updateData.customer_id && uuidRegex.test(updateData.customer_id))
        ? updateData.customer_id : null;
    }
    if ('technician_id' in updateData) {
      updateData.technician_id = (updateData.technician_id && uuidRegex.test(updateData.technician_id))
        ? updateData.technician_id : null;
    }
    if ('vehicle_plate' in updateData) {
      updateData.vehicle_plate = updateData.vehicle_plate?.trim()
        ? updateData.vehicle_plate.trim().toUpperCase() : null;
    }
    if ('vehicle_type' in updateData) {
      updateData.vehicle_type = updateData.vehicle_type?.trim() || null;
    }
    if ('mileage' in updateData) {
      const parsed = parseInt(updateData.mileage);
      updateData.mileage = isNaN(parsed) ? null : parsed;
    }
    if ('vehicle_year' in updateData) {
      const parsed = parseInt(updateData.vehicle_year);
      updateData.vehicle_year = isNaN(parsed) ? null : parsed;
    }

    if ('technician_id' in updateData) {
      if (updateData.technician_id) {
        const technician = await User.findOne({ where: { id: updateData.technician_id, tenant_id: tenantId } });
        updateData.technician_name = technician
          ? [technician.first_name, technician.last_name].filter(Boolean).join(' ')
          : null;
      } else {
        updateData.technician_name = null;
      }
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

    let lineItemsTotal; // total pre-descuento-global -- solo se resuelve si cambian ítems o el descuento

    if (items && Array.isArray(items) && items.length > 0) {
      await SaleItem.destroy({ where: { sale_id: id }, transaction });

      let subtotal = 0, tax_amount = 0, discount_amount = 0;
      const newItems = [];

      // Batch-load de todos los productos en 1 query (elimina N+1 — con ventas
      // de cientos de líneas, una consulta por ítem hacía que la actualización
      // superara el timeout de 30s del cliente).
      const productIds = items
        .filter(i => (i.item_type || 'product') !== 'free_line' && i.product_id)
        .map(i => i.product_id);
      const productRows = productIds.length
        ? await Product.findAll({ where: { id: { [Op.in]: productIds }, tenant_id: tenantId }, transaction })
        : [];
      const productMap = Object.fromEntries(productRows.map(p => [p.id, p]));

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
            technician_id: item.technician_id || null,
          });
          continue;
        }

        const product = productMap[item.product_id];
        if (!product) {
          await transaction.rollback();
          return res.status(404).json({ success: false, message: `Producto ${item.product_id} no encontrado` });
        }

        const taxes = taxService.calculateItemTaxes(item, product, 'sale');

        subtotal += taxes.base; discount_amount += (item.quantity * item.unit_price - taxes.base); tax_amount += taxes.total_taxes;
        newItems.push({
          sale_id: id, tenant_id: tenantId,
          item_type: product.product_type === 'service' ? 'service' : 'product',
          product_id: product.id, product_name: product.name, product_sku: product.sku,
          quantity: item.quantity, unit_price: item.unit_price,
          discount_percentage: item.discount_percentage || 0, discount_amount: item.quantity * item.unit_price - taxes.base,
          tax_percentage: taxes.iva.rate, tax_amount: taxes.iva.amount,
          inc_rate: taxes.inc.rate, inc_amount: taxes.inc.amount,
          ica_rate: taxes.ica.rate, ica_amount: taxes.ica.amount,
          subtotal: taxes.base, total: taxes.total_line,
          unit_cost: product.product_type === 'service' ? 0 : (product.average_cost || 0),
          technician_id: item.technician_id || null,
        });
      }

      await SaleItem.bulkCreate(newItems, { transaction });

      lineItemsTotal = newItems.reduce((sum, i) => sum + i.total, 0);
      updateData.subtotal        = subtotal;
      updateData.tax_amount      = tax_amount;
      updateData.discount_amount = discount_amount;
    } else if (discountFieldsChanged) {
      // Ítems no cambiaron pero sí el descuento global -- reconstruir el
      // total pre-descuento-global desde lo ya persistido (total_amount
      // actual + el descuento global YA aplicado antes, si alguno), para no
      // perder la base sobre la que aplicar el descuento nuevo.
      lineItemsTotal = parseFloat(sale.total_amount) + (parseFloat(sale.global_discount_amount) || 0);
    }

    if (lineItemsTotal !== undefined) {
      const effType  = updateData.global_discount_type  !== undefined ? updateData.global_discount_type  : sale.global_discount_type;
      const effValue = updateData.global_discount_value  !== undefined ? updateData.global_discount_value : sale.global_discount_value;
      updateData.global_discount_amount = resolveGlobalDiscount(effType, effValue, lineItemsTotal);
      updateData.total_amount = lineItemsTotal - updateData.global_discount_amount;
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
    const { payment_method, paid_amount, document_type } = req.body;

    if (!payment_method) {
      return res.status(400).json({ success: false, message: 'Debe especificar el método de pago' });
    }

    // document_type es opcional — si se envía, debe ser uno de los tipos válidos
    if (document_type && !['factura', 'remision', 'cotizacion'].includes(document_type)) {
      return res.status(400).json({ success: false, message: 'document_type debe ser "factura", "remision" o "cotizacion"' });
    }

    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      include: [{ model: SaleItem, as: 'items' }]
    });

    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (sale.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Solo se pueden confirmar ventas en borrador' });
    }

    // Tipo de documento final -- se calcula acá para poder validar antes de
    // abrir la transacción; se reutiliza más abajo en vez de recalcularlo.
    const finalDocType = document_type || (sale.document_type !== null ? sale.document_type : 'remision');

    // Si se factura un producto tipo 'vehicle', su ficha de Vehicle debe traer
    // ya los datos que pide el organismo de tránsito (VIN, motor, color, etc.)
    // -- si falta alguno, es mejor bloquear la factura ahora que descubrirlo
    // ya emitida y sin forma fácil de corregirla.
    if (finalDocType === 'factura') {
      const vehicleItemProductIds = sale.items
        .filter(i => i.approval_status !== 'rechazado' && i.product_id)
        .map(i => i.product_id);
      if (vehicleItemProductIds.length > 0) {
        const vehicleProducts = await Product.findAll({
          where: { id: { [Op.in]: vehicleItemProductIds }, tenant_id: tenantId, product_type: 'vehicle' },
          include: [{ model: Vehicle, as: 'vehicle' }],
        });
        const REQUIRED_VEHICLE_FIELDS = [
          ['vin', 'VIN/Chasis'], ['engine_number', 'Número de motor'],
          ['brand', 'Marca'], ['model', 'Línea'], ['year', 'Modelo (año)'], ['color', 'Color'],
        ];
        const incomplete = [];
        for (const product of vehicleProducts) {
          if (!product.vehicle) {
            incomplete.push(`${product.name}: no tiene una ficha de vehículo asociada`);
            continue;
          }
          const missing = REQUIRED_VEHICLE_FIELDS
            .filter(([field]) => !product.vehicle[field])
            .map(([, label]) => label);
          if (missing.length > 0) {
            incomplete.push(`${product.name}: falta ${missing.join(', ')}`);
          }
        }
        if (incomplete.length > 0) {
          return res.status(400).json({
            success: false,
            message: `No se puede facturar: faltan datos del vehículo requeridos para tránsito. ${incomplete.join(' | ')}`,
          });
        }
      }
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
      // Pre-validar stock (y cachear los productos consultados para no repetir la query abajo)
      const stockErrors = [];
      const productCache = {};
      for (const item of sale.items) {
        // Ítem rechazado por el cliente al aprobar la cotización (ver
        // respondPublicQuoteBody) — no se cobra ni descuenta inventario.
        if (item.approval_status === 'rechazado') continue;
        if (item.item_type === 'service' || item.item_type === 'free_line') continue;
        if (!item.product_id) continue;
        const prodCheck = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId }, transaction });
        productCache[item.product_id] = prodCheck;
        if (prodCheck && prodCheck.track_inventory && !prodCheck.allow_negative_stock) {
          const disponible = parseFloat(prodCheck.current_stock);
          const solicitado = parseFloat(item.quantity);
          if (disponible < solicitado) {
            const { getEquivalentsWithStock } = require('../../utils/equivalenceHelper');
            const alternatives = await getEquivalentsWithStock(item.product_id, tenantId);
            stockErrors.push({
              product_id: item.product_id,
              sku: prodCheck.sku,
              name: prodCheck.name,
              available_stock: disponible,
              requested: solicitado,
              alternatives
            });
          }
        }
      }
      if (stockErrors.length > 0) {
        await transaction.rollback();
        const msgLines = stockErrors.map(e => `• ${e.name}: disponible ${e.available_stock}, solicitado ${e.requested}`);
        return res.status(400).json({ success: false, message: `Stock insuficiente en ${stockErrors.length} ítem(s): ${msgLines.join(', ')}`, stock_errors: stockErrors });
      }

      // Si hay ítems que descuentan inventario (track_inventory), la venta
      // necesita una bodega asignada. Sin esto, InventoryMovement.warehouse_id
      // (NOT NULL) revienta la transacción completa con un 500 y la venta se
      // queda en borrador sin poder confirmarse.
      const needsWarehouse = Object.values(productCache).some(p => p && p.track_inventory);
      if (needsWarehouse && !sale.warehouse_id) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Esta venta tiene productos que descuentan inventario. Selecciona una bodega antes de confirmarla.'
        });
      }

      // Crear movimientos de salida
      for (const item of sale.items) {
        if (item.approval_status === 'rechazado') continue;
        if (item.item_type === 'service' || item.item_type === 'free_line') continue;
        if (item.product_id) {
          const product = productCache[item.product_id] || await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId }, transaction });
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

      // Registrar el pago inicial en payment_history para que Flujo de Caja
      // (que solo lee payment_history) refleje el ingreso, igual que registerPayment.
      let initialPayment = null;
      let openSession = null;
      if (amountPaid > 0) {
        // Cualquier pago (efectivo, tarjeta, transferencia, otro) requiere una
        // caja abierta en la sede activa — sin esto, el cuadre de caja nunca
        // podría reconciliar de dónde salió este dinero. Pero esto solo aplica
        // a tenants con el módulo de Tesorería activo: sin ese módulo no hay
        // dónde abrir una caja, y exigirla les bloquearía las ventas.
        if (await isTreasuryEnabled(tenantId)) {
          openSession = await getOpenSession(tenantId, req.branch_id, transaction);
          if (!openSession) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'No hay una caja abierta en esta sede. Abre la caja antes de registrar pagos.' });
          }
        }

        initialPayment = {
          payment_id: require('crypto').randomUUID(),
          date: sale.sale_date || new Date(),
          amount: amountPaid,
          method: payment_method,
          user_id: userId,
          notes: 'Pago registrado al confirmar la venta',
          cash_session_id: openSession?.id || null,
          branch_id: req.branch_id,
        };
      }

      // ── Asignar tipo de documento al confirmar ───────────────────────────────
      // El tipo siempre se elige en este momento. Si llega document_type lo aplicamos;
      // si no viene, usar remision como fallback solo si ya tenía tipo previo.
      // (finalDocType ya se calculó arriba, antes de la transacción, para
      // poder validar los datos del vehículo sin abrirla innecesariamente.)
      if (finalDocType !== sale.document_type) {
        updateData.document_type = finalDocType;
        updateData.dian_status   = finalDocType === 'factura' ? 'pending' : 'not_applicable';
        const newNumber = await generateSaleNumber(tenantId, finalDocType, transaction, sale.id, sale.branch_id);
        updateData.sale_number = newNumber;
      } else if (document_type) {
        updateData.dian_status = document_type === 'factura' ? 'pending' : 'not_applicable';

      }

      // El recibo se numera al final, ya con el sale_number definitivo
      // (la renumeración de arriba puede cambiarlo respecto al de la Sale
      // recién creada), y viaja en el mismo payment_history entry.
      if (initialPayment) {
        const { generateReceiptNumber } = require('../../services/finance/receiptNumber.service');
        const { Receipt } = require('../../models');
        const receipt_number = await generateReceiptNumber(tenantId, transaction);
        initialPayment.receipt_number = receipt_number;
        await Receipt.create({
          tenant_id: tenantId,
          branch_id: req.branch_id,
          receipt_number,
          source_type: 'sale',
          source_id: sale.id,
          payment_id: initialPayment.payment_id,
          cash_session_id: openSession?.id || null,
          amount: initialPayment.amount,
          method: initialPayment.method,
          payment_date: initialPayment.date,
          reference: updateData.sale_number || sale.sale_number,
          customer_name: sale.customer_name,
          created_by: userId,
        }, { transaction });

        const payment_history = [...(sale.payment_history || [])];
        payment_history.push(initialPayment);
        updateData.payment_history = payment_history;
      }

      const wasQuote = sale.document_type === 'cotizacion';
      await sale.update(updateData, { transaction });
      await transaction.commit();

      // ── CRM: si la cotización tenía una Opportunity vinculada, al
      // confirmarse como factura/remisión (dejó de ser cotización) la
      // oportunidad se marca ganada. No bloquea la respuesta.
      // Fase B.4 — 'ganado' se resuelve contra CrmPipelineStage del tenant
      // (stage_type='won'), no como key fija (ver mismo fix en la creación
      // de la cotización, más arriba en este archivo).
      if (wasQuote && finalDocType !== 'cotizacion') {
        setImmediate(async () => {
          try {
            const { Opportunity } = require('../../models');
            const { loadStageMap, keysByType } = require('../../utils/crmPipelineStages');
            const opportunity = await Opportunity.findOne({ where: { quote_sale_id: sale.id, tenant_id: tenantId } });
            if (!opportunity) return;

            const stageMap = await loadStageMap(tenantId);
            if (stageMap[opportunity.stage]?.stage_type === 'won') return; // ya está ganada

            const wonStage = Object.values(stageMap).find(s => s.stage_type === 'won');
            if (wonStage) {
              await opportunity.update({ stage: wonStage.key, stage_changed_at: new Date() });
            }
          } catch (err) {
            logger.warn(`[crm] Error marcando oportunidad como ganada para venta ${sale.id}: ${err.message}`);
          }
        });
      }

      // Asiento contable en borrador (no bloqueante: si falla, solo se loguea).
      // Una cotización NO es una venta real todavía — no debe tocar el libro
      // diario hasta que se confirme como remisión/factura (o se convierta
      // en OT, cuyo cierre genera su propio asiento en workOrders.controller).
      if (finalDocType !== 'cotizacion') {
        setImmediate(async () => {
          try {
            const { generateSaleEntry } = require('../../services/accounting/autoEntries.service');
            const finalSaleForAccounting = await Sale.findByPk(id, { include: [{ model: SaleItem, as: 'items' }] });
            await generateSaleEntry(finalSaleForAccounting, finalSaleForAccounting.items, tenantId, userId);
          } catch (err) {
            logger.warn(`[accounting] Error generando asiento de venta ${id}: ${err.message}`);
          }
        });
      }

      // ── Disparar envío DIAN si quedó como factura ───────────────────────────
      if (finalDocType === 'factura') {
        const finalSale = await Sale.findByPk(id, { include: [{ model: SaleItem, as: 'items' }] });
        setImmediate(async () => {
          try {
            const tenant = await Tenant.findByPk(tenantId);
            await dianService.sendInvoiceToDian(finalSale, tenant);
          } catch (err) {
            logger.error(`[DIAN] Error async al enviar factura ${finalSale?.sale_number}:`, err.message);
          }
        });
      }

      await audit({
        tenant_id: tenantId, user_id: userId, action: 'CONFIRM_SALE',
        entity: 'sale', entity_id: sale.id,
        changes: { sale_number: updateData.sale_number || sale.sale_number, document_type: finalDocType, total_amount: sale.total_amount, payment_method }, req
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

    // Reversión del asiento contable de la venta (no bloqueante: si falla,
    // solo se loguea — igual que la generación original del asiento).
    // Sin esto, el balance/estado de resultados seguía mostrando el ingreso,
    // el IVA y el costo de una venta que ya no existe para el negocio.
    setImmediate(async () => {
      try {
        const { reverseSourceEntries } = require('../../services/accounting/autoEntries.service');
        await reverseSourceEntries('sale', sale.id, tenantId, userId, `Venta ${sale.sale_number || sale.id} cancelada${reason ? ' — ' + reason : ''}`);

        // Los abonos de esta venta generaron su propio asiento (ver
        // registerPayment) — sin esto, quedarían huérfanos: cash/cartera
        // contabilizados para una venta que ya no existe.
        // Los recibos de esos abonos quedan anulados junto con su asiento —
        // se conservan (no se borran) para trazabilidad, solo cambian de estado.
        const { Receipt, CustomerAdvance, CustomerAdvanceApplication } = require('../../models');
        for (const p of (sale.payment_history || [])) {
          if (!p.payment_id) continue;

          // Entradas con source: 'advance' no tienen Receipt (no movieron caja
          // hoy) — hay que revertir la aplicación en vez de anular un recibo:
          // marcar la CustomerAdvanceApplication como reversed y devolver el
          // balance al anticipo original, para que vuelva a estar disponible
          // (ver Anticipos-Clientes-Analisis-y-Plan.md §5 "Reversas").
          if (p.source === 'advance' && p.application_id) {
            try {
              const application = await CustomerAdvanceApplication.findOne({
                where: { id: p.application_id, tenant_id: tenantId, status: 'active' },
              });
              if (application) {
                await application.update({
                  status: 'reversed',
                  reversed_at: new Date(),
                  reversed_by: userId,
                  reversed_reason: `Venta ${sale.sale_number || sale.id} cancelada${reason ? ' — ' + reason : ''}`,
                });

                const advance = await CustomerAdvance.findOne({ where: { id: application.advance_id, tenant_id: tenantId } });
                if (advance) {
                  const newAppliedAmount = Math.max(0, parseFloat(advance.applied_amount) - parseFloat(application.amount));
                  const newBalance = parseFloat(advance.amount) - newAppliedAmount - parseFloat(advance.refunded_amount);
                  await advance.update({
                    applied_amount: newAppliedAmount,
                    balance: newBalance,
                    // Solo reactiva si no estaba anulado/devuelto por fuera de esta aplicación.
                    status: advance.status === 'fully_applied' ? 'active' : advance.status,
                  });
                }

                await reverseSourceEntries('customer_advance_application', application.id, tenantId, userId, `Venta ${sale.sale_number || sale.id} cancelada${reason ? ' — ' + reason : ''}`);
              }
            } catch (advErr) {
              logger.warn(`[accounting] Error revirtiendo aplicación de anticipo (venta ${id}): ${advErr.message}`);
            }
            continue;
          }

          await reverseSourceEntries('payment', p.payment_id, tenantId, userId, `Venta ${sale.sale_number || sale.id} cancelada${reason ? ' — ' + reason : ''}`);
          await Receipt.update(
            { status: 'voided', voided_at: new Date(), voided_reason: reason || 'Venta cancelada' },
            { where: { payment_id: p.payment_id } }
          );
        }
      } catch (err) {
        logger.warn(`[accounting] Error reversando asiento de venta cancelada ${id}: ${err.message}`);
      }
    });

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
    if (sale.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Solo se pueden marcar como entregadas las ventas completadas' });
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
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const userId = req.user.id;
    const { amount, payment_method, payment_date, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    // SELECT FOR UPDATE: evita que dos pagos concurrentes lean el mismo paid_amount
    const sale = await Sale.findOne({
      where: { id, tenant_id: tenantId },
      lock: transaction.LOCK.UPDATE,
      transaction
    });
    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }
    if (sale.status === 'draft') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se puede registrar pago en una venta en borrador' });
    }

    const total = parseFloat(sale.total_amount);
    const alreadyPaid = parseFloat(sale.paid_amount || 0);
    const remaining = total - alreadyPaid;

    if (remaining <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta venta ya está pagada en su totalidad' });
    }

    // Cualquier pago (efectivo, tarjeta, transferencia, otro) requiere una
    // caja abierta en la sede activa — solo para tenants con Tesorería activa.
    let openSession = null;
    if (await isTreasuryEnabled(tenantId)) {
      openSession = await getOpenSession(tenantId, req.branch_id, transaction);
      if (!openSession) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'No hay una caja abierta en esta sede. Abre la caja antes de registrar pagos.' });
      }
    }

    // Limitar el monto al saldo pendiente para evitar sobrepagos
    const effectiveAmount = Math.min(parseFloat(amount), remaining);
    const paid_amount = alreadyPaid + effectiveAmount;

    let payment_status = 'pending';
    if (paid_amount >= total) payment_status = 'paid';
    else if (paid_amount > 0) payment_status = 'partial';

    const payment_id = require('crypto').randomUUID();
    const payment_history = [...(sale.payment_history || [])];
    const effectiveMethod = payment_method || sale.payment_method || 'Efectivo';
    const effectiveDate = payment_date || new Date();

    const { generateReceiptNumber } = require('../../services/finance/receiptNumber.service');
    const { Receipt } = require('../../models');
    const receipt_number = await generateReceiptNumber(tenantId, transaction);
    await Receipt.create({
      tenant_id: tenantId,
      branch_id: req.branch_id,
      receipt_number,
      source_type: 'sale',
      source_id: sale.id,
      payment_id,
      cash_session_id: openSession?.id || null,
      amount: effectiveAmount,
      method: effectiveMethod,
      payment_date: effectiveDate,
      reference: sale.sale_number,
      customer_name: sale.customer_name,
      created_by: userId,
    }, { transaction });

    payment_history.push({
      payment_id,
      date: effectiveDate,
      amount: effectiveAmount,
      method: effectiveMethod,
      user_id: userId,
      notes: notes || null,
      cash_session_id: openSession?.id || null,
      branch_id: req.branch_id,
      receipt_number,
    });

    await sale.update(
      { paid_amount, payment_status, payment_method: payment_method || sale.payment_method, payment_history },
      { transaction }
    );

    await transaction.commit();

    // Asiento contable del abono (caja/bancos vs cartera), no bloqueante —
    // mismo patrón fire-and-forget que el asiento de la venta en confirm().
    setImmediate(async () => {
      try {
        const { generatePaymentEntry } = require('../../services/accounting/autoEntries.service');
        await generatePaymentEntry(
          { payment_id, amount: effectiveAmount, method: effectiveMethod, date: effectiveDate },
          sale,
          tenantId,
          userId
        );
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de abono (venta ${id}): ${err.message}`);
      }
    });

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    res.json({ success: true, message: 'Pago registrado exitosamente', data: updatedSale });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
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
    // Los borradores son cotizaciones, no ventas confirmadas — no deben
    // sumar en los totales de Ventas (mismo criterio que getAll/quote_view).
    const where = { tenant_id: tenantId, status: { [Op.ne]: 'draft' } };
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
        { model: SaleItem, as: 'items', include: [{ model: Product, as: 'product', include: [{ model: Vehicle, as: 'vehicle' }] }] },
        { model: SaleDiagnosisMark, as: 'diagnosis_marks', include: [{ model: DiagramTemplate, as: 'diagram_template' }] }
      ]
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    // Buffer mode: necesario para Vercel serverless (no soporta streaming)
    const TYPES = { factura: 'Factura', remision: 'Remision', cotizacion: 'Cotizacion' };
    const docLabel = TYPES[sale.document_type] || 'Documento';
    const filename = `${docLabel}-${sale.sale_number}.pdf`;
    const pdfBuffer = await generateSalePDFBuffer(sale, tenant);
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-store',
    });
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('Error generando PDF:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error generando PDF' });
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
    // El número real vive en la tabla receipts (fuente única de verdad desde
    // que existe); si el pago es anterior a ese cambio, se conserva el
    // fallback histórico por índice para no romper reimpresiones viejas.
    if (payment.payment_id) {
      const { Receipt } = require('../../models');
      const receipt = await Receipt.findOne({ where: { tenant_id: tenantId, payment_id: payment.payment_id } });
      if (receipt) payment.receipt_number = receipt.receipt_number;
    }
    if (!payment.receipt_number) {
      payment.receipt_number = `REC-${sale.sale_number}-${String(idx + 1).padStart(2, '0')}`;
    }
    const tenant = await Tenant.findByPk(tenantId);

    // Buffer mode: necesario para Vercel serverless (no soporta streaming)
    const recNum = payment.receipt_number;
    const pdfBuffer = await generatePaymentReceiptPDFBuffer(sale, tenant, payment);
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="recibo-${recNum}.pdf"`,
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-store',
    });
    res.send(pdfBuffer);
  } catch (e) {
    logger.error('Error generando recibo:', e);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error generando recibo' });
  }
};

// ─── Función auxiliar para generar número de venta ───────────────────────────
// FACTURAS: usa el consecutivo de la resolución DIAN activa (prefijo + número)
// REMISIONES / COTIZACIONES: consecutivo interno REM-YYYY-XXXX / COT-YYYY-XXXX
async function generateSaleNumber(tenant_id, document_type, transaction, excludeId = null, branch_id = null) {
  // Sin tipo aún (borrador): número provisional BOD-
  if (!document_type || document_type === null) {
    const year = new Date().getFullYear();
    const where = { tenant_id, sale_number: { [Op.like]: `BOD-${year}-%` } };
    if (excludeId) where.id = { [Op.ne]: excludeId };
    const lastSale = await Sale.findOne({
      where,
      order: [['sale_number', 'DESC']],
      transaction,
    });
    let sequence = 1;
    if (lastSale) {
      const lastNumber = lastSale.sale_number.split('-').pop();
      sequence = parseInt(lastNumber) + 1;
    }
    return `BOD-${year}-${sequence.toString().padStart(4, '0')}`;
  }

  if (document_type !== 'factura') {
    // Consecutivo interno (sin cambios respecto al original)
    const prefix = document_type === 'remision' ? 'REM' : 'COT';
    const year = new Date().getFullYear();
    const where = { tenant_id, sale_number: { [Op.like]: `${prefix}-${year}-%` } };
    if (excludeId) where.id = { [Op.ne]: excludeId };
    const lastSale = await Sale.findOne({
      where,
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
    where: { tenant_id, branch_id, is_active: true, document_type: 'invoice' },
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

// Genera (o reutiliza) el share_token de la venta y devuelve el enlace
// público — mismo token que usa sendWhatsApp, pero sin requerir teléfono
// del cliente ni disparar el mensaje. Permite copiar el link directamente
// (botón "Copiar enlace" en SaleDetailPage).
const generateShareLink = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;

    const sale = await Sale.findOne({ where: { id, tenant_id: tenantId } });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });

    let token = sale.share_token;
    const updates = {};
    if (!token) {
      token = require('crypto').randomUUID();
      updates.share_token = token;
    }
    // Mismo criterio que el frontend (SaleDetailPage#isQuote): ventas antiguas
    // sin document_type asignado se tratan como cotización.
    const isQuote = !sale.document_type || sale.document_type === 'cotizacion';
    if (isQuote && (!sale.quote_status || sale.quote_status === 'borrador')) {
      updates.quote_status = 'enviada';
    }
    if (Object.keys(updates).length) {
      await sale.update(updates);
    }

    // BACKEND_URL puede no estar seteado en algunos entornos -- si falta,
    // se reconstruye desde el propio request en vez de dejar el link relativo.
    const backendUrl = (process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const pdfUrl = `${backendUrl}/api/public/pdf/${token}`;
    // El link que se comparte SIEMPRE debe apuntar al frontend (la SPA
    // consulta la API por dentro) -- antes, para factura/remisión, `url`
    // terminaba siendo `pdfUrl` (directo al backend) y al abrirla el
    // navegador mostraba el JSON crudo del endpoint, no una página. La
    // página pública (QuotePublicPage) ya es genérica por document_type.
    const documentUrl = `${frontendUrl}/public/quote/${token}`;

    res.json({
      success: true,
      token,
      url: documentUrl,
      pdf_url: pdfUrl,
      quote_url: isQuote ? documentUrl : null,
    });
  } catch (error) {
    logger.error('Error generando enlace de venta:', error);
    res.status(500).json({ success: false, message: 'Error al generar el enlace' });
  }
};

// Enviar PDF por WhatsApp — enlace persistente por venta (sin Cloudinary)
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
    const docLabel = TYPES[sale.document_type] || 'Cotización';
    // Mismo criterio que generateShareLink/frontend: ventas antiguas sin
    // document_type asignado se tratan como cotización.
    const isQuote = !sale.document_type || sale.document_type === 'cotizacion';

    // Token persistente — se genera una sola vez y se reutiliza siempre
    // (mismo patrón que WorkOrder.share_token / generateShareToken).
    let token = sale.share_token;
    const updates = {};
    if (!token) {
      token = require('crypto').randomUUID();
      updates.share_token = token;
    }
    // Marca la cotización como "enviada" la primera vez que se comparte.
    if (isQuote && (!sale.quote_status || sale.quote_status === 'borrador')) {
      updates.quote_status = 'enviada';
    }
    if (Object.keys(updates).length) {
      await sale.update(updates);
    }

    // BACKEND_URL puede no estar seteado en algunos entornos -- si falta,
    // se reconstruye desde el propio request en vez de dejar el link relativo.
    const backendUrl = (process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const pdfUrl = `${backendUrl}/api/public/pdf/${token}`;
    // Igual que en generateShareLink: el link compartido por WhatsApp debe
    // apuntar siempre al frontend, no al endpoint del backend que sirve el
    // PDF crudo (ver comentario ahí).
    const documentUrl = `${frontendUrl}/public/quote/${token}`;

    let caption;
    if (isQuote) {
      caption = `Hola! Aquí tienes tu ${docLabel} *${sale.sale_number}* de *${tenant.company_name}*.\nTotal: *$${Number(sale.total_amount).toLocaleString('es-CO')}*\n\n📄 Revisa y aprueba tu cotización aquí:\n${documentUrl}\n\nCualquier duda estamos a tu servicio. 😊`;
    } else {
      caption = `Hola! Aquí tienes tu ${docLabel} *${sale.sale_number}* de *${tenant.company_name}*.\nTotal: *$${Number(sale.total_amount).toLocaleString('es-CO')}*\n\n📄 Consulta tu documento aquí:\n${documentUrl}\n\nCualquier duda estamos a tu servicio. 😊`;
    }

    const result = await whatsappService.sendText(customerPhone, caption);

    res.json({
      success: true,
      waLink:  result.waLink,
      pdfUrl,
      message: `Enlace listo para ${customerPhone}. Se abrirá WhatsApp con el mensaje.`,
    });
  } catch (error) {
    logger.error('Error generando enlace WhatsApp:', error);
    res.status(500).json({ success: false, message: 'Error al generar enlace de WhatsApp' });
  }
};

// Resuelve a qué tenant/schema pertenece un share_token de sales, buscando
// primero en public.sales y luego en cada schema de tenant — mismo patrón
// que resolveWorkOrderSchemaByToken (workOrders.controller.js). Compartido
// entre publicPdf.routes.js y los endpoints públicos de cotización de abajo.
async function resolveSaleSchemaByToken(token) {
  const [publicRows] = await sequelize.query(
    'SELECT id FROM "public"."sales" WHERE share_token = :token LIMIT 1',
    { replacements: { token } }
  );
  if (publicRows[0]) return { saleId: publicRows[0].id, schemaName: null };

  const [tenants] = await sequelize.query(
    'SELECT schema_name FROM "public"."tenants" WHERE schema_name IS NOT NULL'
  );
  for (const { schema_name } of tenants) {
    const [rows] = await sequelize.query(
      `SELECT id FROM "${schema_name}"."sales" WHERE share_token = :token LIMIT 1`,
      { replacements: { token } }
    );
    if (rows[0]) return { saleId: rows[0].id, schemaName: schema_name };
  }
  return null;
}

// GET /api/public/sales/:token — vista pública sin autenticación de una
// cotización (usada por QuotePublicPage.jsx para mostrar detalle + botones
// de aprobar/rechazar).
const getPublicSale = async (req, res) => {
  const { runWithTenantSchema } = require('../../config/tenantContext');
  try {
    const { token } = req.params;
    let resolved;
    try {
      resolved = await resolveSaleSchemaByToken(token);
    } catch {
      return res.status(503).json({ success: false, message: 'Función no disponible aún' });
    }
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Documento no encontrado o enlace inválido' });
    }
    return runWithTenantSchema(resolved.schemaName, () => getPublicSaleBody(resolved.saleId, res));
  } catch (error) {
    logger.error('[Cotización pública] Error:', error.message);
    res.status(500).json({ success: false, message: 'Error obteniendo la cotización' });
  }
};

async function getPublicSaleBody(saleId, res) {
  const sale = await Sale.findOne({
    where: { id: saleId },
    include: [{ model: SaleItem, as: 'items', include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }] }],
  });
  if (!sale) return res.status(404).json({ success: false, message: 'Documento no encontrado' });

  const tenant = await Tenant.findByPk(sale.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

  const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');

  res.json({
    success: true,
    data: {
      sale_number: sale.sale_number,
      document_type: sale.document_type,
      quote_status: sale.quote_status,
      pdf_url: `${backendUrl}/api/public/pdf/${sale.share_token}`,
      customer_name: sale.customer_name,
      sale_date: sale.sale_date,
      subtotal: sale.subtotal,
      tax_amount: sale.tax_amount,
      discount_amount: sale.discount_amount,
      total_amount: sale.total_amount,
      notes: sale.notes,
      items: (sale.items || []).map(i => ({
        id: i.id,
        product_name: i.product?.name || i.description,
        quantity: i.quantity,
        unit_price: i.unit_price,
        subtotal: i.subtotal,
        tax_amount: i.tax_amount,
        total: i.total,
        approval_status: i.approval_status,
      })),
      quote_approved_by_name: sale.quote_approved_by_name,
      quote_responded_at: sale.quote_responded_at,
      tenant: { company_name: tenant.company_name },
    },
  });
}

// POST /api/public/sales/:token/respond — el cliente aprueba/rechaza la
// cotización desde el link público. Sin autenticación; protegido por
// quoteResponseLimiter en la ruta (backend/src/middleware/rateLimiter.js).
const respondPublicQuote = async (req, res) => {
  const { runWithTenantSchema } = require('../../config/tenantContext');
  try {
    const { token } = req.params;
    const { approvals, approved_by_name, approved_by_document } = req.body;

    if (!approved_by_name || !approved_by_document) {
      return res.status(400).json({ success: false, message: 'Nombre y documento son requeridos para responder' });
    }
    if (!Array.isArray(approvals) || approvals.length === 0) {
      return res.status(400).json({ success: false, message: 'No se recibió ninguna decisión' });
    }

    let resolved;
    try {
      resolved = await resolveSaleSchemaByToken(token);
    } catch {
      return res.status(503).json({ success: false, message: 'Función no disponible aún' });
    }
    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Cotización no encontrada o enlace inválido' });
    }

    return runWithTenantSchema(resolved.schemaName, () =>
      respondPublicQuoteBody({ saleId: resolved.saleId, approvals, approved_by_name, approved_by_document, req, res })
    );
  } catch (error) {
    logger.error('[Cotización pública] Error respondiendo:', error.message);
    res.status(500).json({ success: false, message: 'Error al procesar la respuesta' });
  }
};

// approvals: [{ item_id, approved }] — el cliente puede aprobar algunos
// ítems y rechazar otros (mismo patrón que respondQuoteRequestBody en
// workOrders.controller.js). El estado final de la cotización depende de la
// mezcla resultante: 'aprobada' si aprobó todo, 'rechazada' si rechazó todo,
// 'parcial' si mezcló ambas.
async function respondPublicQuoteBody({ saleId, approvals, approved_by_name, approved_by_document, req, res }) {
  const transaction = await sequelize.transaction();
  try {
    const sale = await Sale.findOne({ where: { id: saleId }, include: [{ model: SaleItem, as: 'items' }], transaction });
    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cotización no encontrada' });
    }
    if (sale.quote_status !== 'enviada') {
      await transaction.rollback();
      return res.status(409).json({ success: false, message: 'Esta cotización ya fue respondida anteriormente' });
    }

    const itemIds = new Set(sale.items.map(i => i.id));
    const validApprovals = approvals.filter(a => itemIds.has(a.item_id));
    if (validApprovals.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se recibió ninguna decisión válida' });
    }

    for (const a of validApprovals) {
      await SaleItem.update(
        {
          approval_status: a.approved ? 'aprobado' : 'rechazado',
          rejection_reason: a.approved ? null : (a.rejection_reason || null),
        },
        { where: { id: a.item_id, sale_id: sale.id }, transaction }
      );
    }

    // Recalcular totales sobre los ítems aprobados — mismo criterio que
    // calcTotals en workOrders.controller.js: un ítem rechazado por el
    // cliente no se factura, así que no debe inflar lo que se cobra.
    const refreshedItems = await SaleItem.findAll({ where: { sale_id: sale.id }, transaction });
    const billable = refreshedItems.filter(i => i.approval_status === 'aprobado');
    const subtotal        = billable.reduce((s, i) => s + parseFloat(i.subtotal || 0), 0);
    const discount_amount = billable.reduce((s, i) => s + parseFloat(i.discount_amount || 0), 0);
    const tax_amount      = billable.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0);
    const total_amount    = billable.reduce((s, i) => s + parseFloat(i.total || 0), 0);

    const anyApproved = refreshedItems.some(i => i.approval_status === 'aprobado');
    const anyRejected = refreshedItems.some(i => i.approval_status === 'rechazado');
    const quote_status = anyApproved && anyRejected ? 'parcial' : anyApproved ? 'aprobada' : 'rechazada';

    await sale.update({
      quote_status,
      subtotal, discount_amount, tax_amount, total_amount,
      quote_approved_by_name: approved_by_name,
      quote_approved_by_document: approved_by_document,
      quote_approved_ip: req.ip,
      quote_responded_at: new Date(),
    }, { transaction });

    await transaction.commit();
    res.json({ success: true, message: 'Respuesta registrada correctamente' });
  } catch (error) {
    await transaction.rollback();
    logger.error('[Cotización pública] Error en respondPublicQuoteBody:', error);
    res.status(500).json({ success: false, message: 'Error al procesar la respuesta' });
  }
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
  generatePDF,
  sendWhatsApp,
  generateShareLink,
  generatePaymentReceipt,
  resolveSaleSchemaByToken,
  getPublicSale,
  respondPublicQuote,
};