const { Purchase, PurchaseItem, Product, Supplier } = require('../../models/inventory');
const ProductSupplier = require('../../models/inventory/ProductSupplier');
const { Branch, Warehouse, Tenant } = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const taxService = require('../../services/taxService');
const { computePurchaseRetentions, computeExpenseRetentions } = require('../../services/retentionEngine.service');
const { createMovement } = require('./movements.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const { markPurchaseForAlertCheck } = require('../../middleware/autoCheckPayableAlerts.middleware');
const { resolveBranchFilter } = require('../../utils/branchFilter');
const { resolveLandedPurchaseUnitCost } = require('../../utils/costResolver');
const { purchaseNetPayable, purchasePaymentStatus, round2 } = require('../../utils/purchaseAmounts');
const { recordPurchasePaymentEntries, newPaymentRecord } = require('../../services/inventory/purchasePayments.service');

// Pago de contado marcado al crear la compra (plazo 0). Se reemplaza si al
// confirmar se indica otro pago, y se recalcula si se editan los ítems.
const CREATION_CASH_SOURCE = 'creation_cash';
const creationCashPayment = (amount, method, date, user_id) => ({
  ...newPaymentRecord({ date, amount, method, user_id, notes: 'Compra de contado' }),
  source: CREATION_CASH_SOURCE,
});

/**
 * Generar número de compra único
 */
const generatePurchaseNumber = async (tenant_id, transaction = null) => {
  const year = new Date().getFullYear();
  const prefix = `PC-${year}-`;

  const lastPurchase = await Purchase.findOne({
    where: {
      tenant_id,
      purchase_number: { [Op.like]: `${prefix}%` }
    },
    order: [['purchase_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction: transaction || undefined
  });

  let nextNumber = 1;
  if (lastPurchase) {
    const lastNumber = parseInt(lastPurchase.purchase_number.split('-').pop(), 10);
    if (!isNaN(lastNumber)) nextNumber = lastNumber + 1;
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

    // Para roles no-admin, se ignora el branch_id de query y se fuerza la
    // sede autorizada del usuario. Admin/super_admin conservan el filtro
    // opcional (ven todas las sedes si no lo envían).
    const branch_id = resolveBranchFilter(req);
    if (branch_id) where.branch_id = branch_id;

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
    res.status(500).json({ success: false, message: 'Error al obtener compras'});
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
    res.status(500).json({ success: false, message: 'Error al obtener compra'});
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
      due_date,
      payment_terms,
      items,
      discount_amount = 0,
      shipping_cost = 0,
      payment_method,
      invoice_number,
      reference,
      notes,
      internal_notes,
      warehouse_id,
      requires_support_document,
      applied_retentions,
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

    // Resolver plazo de pago: el que venga explícito en el body, si no, el
    // plazo por defecto configurado en el proveedor (en días).
    const parsedPaymentTerms = payment_terms !== undefined && payment_terms !== null && payment_terms !== ''
      ? parseInt(payment_terms)
      : null;
    const effectivePaymentTerms = (parsedPaymentTerms !== null && !isNaN(parsedPaymentTerms))
      ? parsedPaymentTerms
      : (supplier.payment_terms ?? null);

    // Resolver fecha de vencimiento: la que venga explícita, o calculada a
    // partir de la fecha de compra + plazo de pago (en días).
    let effectiveDueDate = due_date || null;
    if (!effectiveDueDate && effectivePaymentTerms) {
      const base = purchase_date ? new Date(purchase_date) : new Date();
      base.setDate(base.getDate() + effectivePaymentTerms);
      effectiveDueDate = base.toISOString().split('T')[0];
    }

    // Plazo 0 = compra de contado: se marca pagada de inmediato y no debe
    // aparecer en cuentas por pagar (mismo criterio que en la importación de facturas).
    const isCash = effectivePaymentTerms === 0;

    // Documento Soporte DIAN: si el proveedor no está obligado a facturar y
    // la compra no trae ya un invoice_number del proveedor, se precarga
    // requires_support_document=true — el usuario puede destildarlo desde
    // el formulario si al final sí llegó una factura del proveedor (ver
    // Documento-Soporte-Analisis-y-Plan.md §5). No dispara envío a la DIAN
    // automáticamente: eso queda como acción explícita desde
    // PurchaseDetailPage una vez la compra esté confirmada/recibida.
    const effectiveRequiresSupportDocument = requires_support_document !== undefined
      ? !!requires_support_document
      : (supplier.is_obligated_to_invoice === false && !invoice_number);

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
        product_name: product.name,
        product_sku: product.sku,
        unit_of_measure: product.unit_of_measure || 'unit',
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

    // Calcular retenciones (Fase C) — el tenant, como comprador, puede
    // retener a este proveedor en ReteFuente/ReteIVA/ReteICA. No se aplica
    // si el proveedor está exento, o si el proveedor mismo es autorretenedor
    // (así el tenant no lo sea) — ver taxService.calculateRetentions.
    const tenantForRetentions = await Tenant.findByPk(tenant_id, { attributes: ['tax_config'], transaction: t });
    // Motor de retenciones: perfil del tenant + del proveedor + concepto de
    // cada ítem (ver services/retentionEngine.service.js).
    const retentions = await computePurchaseRetentions({
      tenantId: tenant_id,
      taxConfig: tenantForRetentions?.tax_config || {},
      supplier,
      items: itemsToCreate,
      requested: applied_retentions,
      transaction: t,
    });
    const tax_breakdown = taxService.buildTaxBreakdown(
      itemsToCreate.map(i => ({ ...i, tax_percentage: i.tax_rate })),
      retentions
    );

    // Generar número de compra con lock dentro de la transacción (evita duplicados bajo concurrencia)
    const MAX_RETRIES = 5;
    let purchase;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const purchase_number = await generatePurchaseNumber(tenant_id, t);
      try {
        purchase = await Purchase.create({
          tenant_id,
          branch_id: req.branch_id || null,
          purchase_number,
          supplier_id,
          user_id,
          purchase_date: purchase_date || new Date(),
          expected_delivery_date,
          due_date: isCash ? null : effectiveDueDate,
          payment_terms: effectivePaymentTerms,
          status: 'draft',
          subtotal,
          tax_amount,
          discount_amount: parseFloat(discount_amount),
          shipping_cost: parseFloat(shipping_cost),
          total_amount,
          payment_method,
          payment_status: isCash ? 'paid' : 'pending',
          // Contado: se paga el neto (total - retenciones), no el total.
          paid_amount: isCash ? round2(total_amount - retentions.total) : 0,
          payment_history: isCash
            ? [creationCashPayment(round2(total_amount - retentions.total), payment_method || 'Efectivo', purchase_date || new Date(), user_id)]
            : [],
          invoice_number,
          reference,
          notes,
          internal_notes,
          warehouse_id,
          // Retenciones (Fase C) — agregadas por tipo + detalle por concepto
          ...taxService.purchaseRetentionFields(retentions),
          tax_breakdown,
          requires_support_document: effectiveRequiresSupportDocument,
        }, { transaction: t });
        break; // éxito
      } catch (uniqueErr) {
        if (
          uniqueErr.name === 'SequelizeUniqueConstraintError' &&
          uniqueErr.fields?.purchase_number &&
          attempt < MAX_RETRIES
        ) {
          continue;
        }
        throw uniqueErr;
      }
    }

    // Crear los items
    for (const [index, itemData] of itemsToCreate.entries()) {
      await PurchaseItem.create({
        tenant_id,
        purchase_id: purchase.id,
        line_number: index + 1,
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
      message: process.env.NODE_ENV === 'development' ? (error.message || 'Error al crear compra') : 'Error al crear compra'
    });
  }
};

/**
 * Si el borrador tiene solo el pago de contado marcado al crearlo, lo ajusta
 * al nuevo neto a pagar (al editar ítems cambia el total).
 */
function cashDraftPaymentRefresh(purchase, newNet) {
  const history = purchase.payment_history || [];
  if (history.length !== 1 || history[0].source !== CREATION_CASH_SOURCE) return {};
  return {
    paid_amount: newNet,
    payment_status: 'paid',
    payment_history: [{ ...history[0], amount: newNet }],
  };
}

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
      due_date,
      payment_terms,
      items,
      discount_amount,
      shipping_cost,
      payment_method,
      invoice_number,
      reference,
      notes,
      internal_notes,
      warehouse_id,
      requires_support_document,
      applied_retentions,
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
      const itemsForRetentions = [];

      // Crear nuevos items
      for (const [index, item] of items.entries()) {
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

        const item_subtotal = quantity * unit_cost;
        const item_discount = (item_subtotal * discount_percentage) / 100;
        const item_subtotal_after_discount = item_subtotal - item_discount;
        const item_tax = (item_subtotal_after_discount * tax_rate) / 100;
        const item_total = item_subtotal_after_discount + item_tax;

        subtotal += item_subtotal_after_discount;
        tax_amount += item_tax;

        const newItemData = {
          tenant_id,
          purchase_id: id,
          line_number: index + 1,
          product_id: item.product_id,
          product_name: product.name,
          product_sku: product.sku,
          unit_of_measure: product.unit_of_measure || 'unit',
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
        };

        await PurchaseItem.create(newItemData, { transaction: t });
        itemsForRetentions.push(newItemData);
      }

      const total_amount = subtotal + tax_amount - 
        parseFloat(discount_amount || 0) + 
        parseFloat(shipping_cost || 0);

      // Retenciones (Fase C) — recalcular con el proveedor efectivo (puede
      // venir cambiado en el mismo request) y su retention_config vigente.
      const effectiveSupplierId = supplier_id ?? purchase.supplier_id;
      const [supplierForRetentions, tenantForRetentions] = await Promise.all([
        Supplier.findOne({ where: { id: effectiveSupplierId, tenant_id }, transaction: t }),
        Tenant.findByPk(tenant_id, { attributes: ['tax_config'], transaction: t }),
      ]);
      // Si el formulario no reenvía applied_retentions y el proveedor no
      // cambió, se conserva la selección guardada (con base recalculada
      // solo para las líneas que usaban la base completa por defecto).
      const supplierChanged = supplier_id && supplier_id !== purchase.supplier_id;
      const requestedRetentions = applied_retentions !== undefined
        ? applied_retentions
        // Solo se conservan líneas que el usuario editó a mano; si no, se
        // recalcula con el motor (los ítems pudieron cambiar de concepto).
        : (!supplierChanged && Array.isArray(purchase.applied_retentions) && purchase.applied_retentions.some((l) => l.manual)
          ? purchase.applied_retentions.map(({ base, amount, ...rest }) => rest)
          : undefined);
      const retentions = await computePurchaseRetentions({
        tenantId: tenant_id,
        taxConfig: tenantForRetentions?.tax_config || {},
        supplier: supplierForRetentions || {},
        items: itemsForRetentions,
        requested: requestedRetentions,
        transaction: t,
      });
      const tax_breakdown = taxService.buildTaxBreakdown(
        itemsForRetentions.map(i => ({ ...i, tax_percentage: i.tax_rate })),
        retentions
      );

      await purchase.update({
        supplier_id:              supplier_id              ?? purchase.supplier_id,
        purchase_date:            purchase_date            ?? purchase.purchase_date,
        expected_delivery_date:   expected_delivery_date   !== undefined ? expected_delivery_date : purchase.expected_delivery_date,
        due_date:                 due_date                 !== undefined ? due_date : purchase.due_date,
        payment_terms:            payment_terms            !== undefined ? parseInt(payment_terms) : purchase.payment_terms,
        subtotal,
        tax_amount,
        discount_amount:          parseFloat(discount_amount || 0),
        shipping_cost:            parseFloat(shipping_cost  || 0),
        total_amount,
        payment_method:           payment_method           !== undefined ? (payment_method  || null) : purchase.payment_method,
        invoice_number:           invoice_number           !== undefined ? (invoice_number  || null) : purchase.invoice_number,
        reference:                reference                !== undefined ? (reference       || null) : purchase.reference,
        notes:                    notes                    !== undefined ? (notes           || null) : purchase.notes,
        internal_notes:           internal_notes           !== undefined ? (internal_notes  || null) : purchase.internal_notes,
        warehouse_id:             warehouse_id             ?? purchase.warehouse_id,
        requires_support_document: requires_support_document !== undefined ? !!requires_support_document : purchase.requires_support_document,
        // Retenciones (Fase C) — agregadas por tipo + detalle por concepto
        ...taxService.purchaseRetentionFields(retentions),
        tax_breakdown,
        // Borrador de contado: el pago marcado al crear sigue al nuevo neto.
        ...cashDraftPaymentRefresh(purchase, round2(total_amount - retentions.total)),
      }, { transaction: t });
    } else {
      // Solo actualizar campos de la compra. Si cambia el proveedor sin
      // reenviar items, igual recalculamos retenciones sobre los items
      // existentes: el proveedor nuevo puede tener otro retention_config
      // (exento / autorretenedor / tarifas) que el anterior.
      let retentionFields = {};
      const supplierChanged = supplier_id && supplier_id !== purchase.supplier_id;
      if (supplierChanged || applied_retentions !== undefined) {
        const [supplierForRetentions, tenantForRetentions] = await Promise.all([
          Supplier.findOne({ where: { id: supplier_id || purchase.supplier_id, tenant_id }, transaction: t }),
          Tenant.findByPk(tenant_id, { attributes: ['tax_config'], transaction: t }),
        ]);
        const existingItems = (purchase.items || []).map(i => (i.toJSON ? i.toJSON() : i));
        const retentions = await computePurchaseRetentions({
          tenantId: tenant_id,
          taxConfig: tenantForRetentions?.tax_config || {},
          supplier: supplierForRetentions || {},
          items: existingItems,
          requested: applied_retentions,
          transaction: t,
        });
        retentionFields = {
          ...taxService.purchaseRetentionFields(retentions),
          tax_breakdown: taxService.buildTaxBreakdown(
            existingItems.map(i => ({ ...i, tax_percentage: i.tax_rate })),
            retentions
          ),
        };
      }

      await purchase.update({
        supplier_id:            supplier_id            ?? purchase.supplier_id,
        purchase_date:          purchase_date          ?? purchase.purchase_date,
        expected_delivery_date: expected_delivery_date !== undefined ? expected_delivery_date : purchase.expected_delivery_date,
        due_date:               due_date               !== undefined ? due_date : purchase.due_date,
        payment_terms:          payment_terms          !== undefined ? parseInt(payment_terms) : purchase.payment_terms,
        discount_amount:        discount_amount        !== undefined ? parseFloat(discount_amount) : purchase.discount_amount,
        shipping_cost:          shipping_cost          !== undefined ? parseFloat(shipping_cost)   : purchase.shipping_cost,
        payment_method:         payment_method         !== undefined ? (payment_method  || null) : purchase.payment_method,
        invoice_number:         invoice_number         !== undefined ? (invoice_number  || null) : purchase.invoice_number,
        reference:              reference              !== undefined ? (reference       || null) : purchase.reference,
        notes:                  notes                  !== undefined ? (notes           || null) : purchase.notes,
        internal_notes:         internal_notes         !== undefined ? (internal_notes  || null) : purchase.internal_notes,
        warehouse_id:           warehouse_id           ?? purchase.warehouse_id,
        requires_support_document: requires_support_document !== undefined ? !!requires_support_document : purchase.requires_support_document,
        ...retentionFields,
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
    res.status(500).json({ success: false, message: 'Error al actualizar compra'});
  }
};

/**
 * Confirmar una compra (cambiar de draft a confirmed)
 */
const confirmPurchase = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const { payment_method, paid_amount, credit_days, bank_account_id } = req.body || {};

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

    // Lo que se le debe al proveedor: total - retenciones.
    const net = purchaseNetPayable(purchase);
    const updates = { status: 'confirmed' };

    // Si el modal de confirmación envió datos de pago (contado/parcial/crédito),
    // se aplican aquí — antes esto se ignoraba y la compra quedaba en
    // payment_status='pending' para siempre, aunque el usuario hubiera
    // marcado "Contado" (ver Contabilidad-Declaraciones-Periodicas-Analisis-y-Plan.md).
    if (payment_method !== undefined || paid_amount !== undefined || credit_days !== undefined) {
      const effectiveAmount = round2(Math.min(Math.max(parseFloat(paid_amount) || 0, 0), net));

      // El pago indicado al confirmar reemplaza el de contado marcado al
      // crear la compra (si lo había) — si no, se contaría dos veces.
      const priorPayments = (purchase.payment_history || []).filter((p) => p.source !== CREATION_CASH_SOURCE);
      const priorPaid = priorPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const totalPaid = round2(Math.min(priorPaid + effectiveAmount, net));

      updates.payment_method = payment_method || purchase.payment_method;
      updates.paid_amount = totalPaid;
      updates.payment_status = purchasePaymentStatus(purchase, totalPaid);
      updates.payment_history = effectiveAmount > 0
        ? [...priorPayments, newPaymentRecord({
          date: new Date(),
          amount: effectiveAmount,
          method: payment_method || purchase.payment_method || 'Efectivo',
          bank_account_id,
          user_id: req.user.id,
          notes: 'Pago registrado al confirmar la compra',
        })]
        : priorPayments;

      // Vencimiento: plazo contado desde la fecha de la compra (factura), no
      // desde el día en que se confirma en el sistema.
      if (updates.payment_status !== 'paid' && credit_days) {
        const dueDate = new Date(`${String(purchase.purchase_date || new Date().toISOString()).slice(0, 10)}T12:00:00`);
        dueDate.setDate(dueDate.getDate() + parseInt(credit_days));
        updates.due_date = dueDate.toISOString().split('T')[0];
      }
    }

    await purchase.update(updates);

    // Asientos de los pagos (contado al crear o pago al confirmar).
    try {
      await recordPurchasePaymentEntries(purchase.id, tenant_id, req.user.id);
    } catch (e) {
      require('../../config/logger').warn(`[accounting] Asiento de pago al confirmar compra ${purchase.id}: ${e.message}`);
    }

    // 🔔 Verificación automática de alertas de cuentas por pagar
    markPurchaseForAlertCheck(res, purchase.id, tenant_id);

    res.json({
      success: true,
      message: 'Compra confirmada exitosamente',
      data: purchase
    });
  } catch (error) {
    console.error('Error en confirmPurchase:', error);
    res.status(500).json({ success: false, message: 'Error al confirmar compra'});
  }
};

/**
 * Valores contables de una recepción (parcial o total) — los usa
 * generatePurchaseEntry como `portion`.
 *
 * Proporcional al valor de lo recibido: ratio = Σ(subtotal de línea ×
 * cantidad recibida / cantidad pedida) / Σ subtotal de líneas. El IVA se
 * toma línea por línea (cada ítem tiene su tarifa). La recepción que cierra
 * la compra toma el REMANENTE (valores completos − recepciones anteriores)
 * para que la suma de los asientos cuadre exacto con la compra, sin
 * diferencias de redondeo.
 */
function buildReceiptPortion(purchase, receivedNow, previousReceipts, isFinal) {
  const items = purchase.items || [];
  const total = Number(purchase.total_amount || 0);
  const taxTotal = Number(purchase.tax_amount || 0);
  const full = {
    inventory: round2(total - taxTotal),
    tax: round2(taxTotal),
    retefuente: round2(purchase.retefuente_amount || 0),
    reteiva: round2(purchase.reteiva_amount || 0),
    reteica: round2(purchase.reteica_amount || 0),
    retention_lines: (purchase.applied_retentions || []).map((l) => ({ ...l, amount: round2(l.amount) })),
  };

  if (isFinal) {
    const prev = previousReceipts.map((r) => r.amounts || {});
    const sum = (key) => prev.reduce((acc, a) => acc + Number(a[key] || 0), 0);
    return {
      inventory: round2(full.inventory - sum('inventory')),
      tax: round2(full.tax - sum('tax')),
      retefuente: round2(full.retefuente - sum('retefuente')),
      reteiva: round2(full.reteiva - sum('reteiva')),
      reteica: round2(full.reteica - sum('reteica')),
      retention_lines: full.retention_lines.map((l, idx) => ({
        ...l,
        amount: round2(l.amount - prev.reduce((acc, a) => acc + Number(a.retention_lines?.[idx]?.amount || 0), 0)),
      })),
    };
  }

  const lineSubtotal = (it) => Number(it.subtotal || 0);
  const subtotalAll = items.reduce((acc, it) => acc + lineSubtotal(it), 0);
  let valueNow = 0;
  let taxNow = 0;
  for (const it of items) {
    const qty = Number(receivedNow.get(it.id) || 0);
    const ordered = Number(it.quantity || 0);
    if (!qty || !ordered) continue;
    valueNow += lineSubtotal(it) * (qty / ordered);
    taxNow += Number(it.tax_amount || 0) * (qty / ordered);
  }
  const ratio = subtotalAll > 0 ? valueNow / subtotalAll : 0;
  return {
    inventory: round2(full.inventory * ratio),
    tax: round2(Math.min(taxNow, full.tax)),
    retefuente: round2(full.retefuente * ratio),
    reteiva: round2(full.reteiva * (full.tax > 0 ? taxNow / full.tax : ratio)),
    reteica: round2(full.reteica * ratio),
    retention_lines: full.retention_lines.map((l) => ({
      ...l,
      amount: round2(l.amount * (l.code === '05' && full.tax > 0 ? taxNow / full.tax : ratio)),
    })),
  };
}

/**
 * Recibir una compra, total o parcialmente (actualiza stock, costo promedio
 * y precio de venta si aplica).
 *
 * Body: { received_items: [{ item_id, received_quantity }] } — cantidad que
 * llega EN ESTA recepción (no acumulada). Sin received_items se recibe todo
 * lo pendiente. Si queda algo pendiente la compra pasa a
 * 'partially_received' y admite nuevas recepciones; cada recepción genera
 * su asiento por el valor de lo recibido.
 */
const receivePurchase = async (req, res) => {
  const t = await sequelize.transaction();

  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const { received_items, receipt_date, notes: receiptNotes } = req.body || {};

    const purchase = await Purchase.findOne({
      where: { id, tenant_id },
      include: [{ model: PurchaseItem, as: 'items' }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: Purchase },
    });

    if (!purchase) {
      throw Object.assign(new Error('Compra no encontrada'), { statusCode: 404 });
    }
    if (purchase.status === 'received') {
      throw Object.assign(new Error('Esta compra ya fue recibida completamente'), { statusCode: 400 });
    }
    if (purchase.status === 'cancelled') {
      throw Object.assign(new Error('No se puede recibir una compra cancelada'), { statusCode: 400 });
    }

    // Resolver la bodega destino: prioridad a la bodega explícita de la compra;
    // si no tiene (ej. compras importadas desde factura electrónica), usar la
    // bodega de la sede (branch) de la compra; si tampoco, la sede activa del request.
    let resolvedWarehouseId = purchase.warehouse_id || null;
    if (!resolvedWarehouseId) {
      const branchId = purchase.branch_id || req.branch_id;
      if (branchId) {
        const branch = await Branch.findOne({
          where: { id: branchId, tenant_id },
          include: [{ model: Warehouse, as: 'warehouse' }],
          transaction: t
        });
        resolvedWarehouseId = branch?.warehouse?.id || null;
      }
    }
    if (!resolvedWarehouseId) {
      throw Object.assign(new Error('No se pudo determinar la bodega destino: la compra no tiene bodega ni sede con bodega asociada. Asigna una bodega o sede a esta compra antes de recibirla.'), { statusCode: 400 });
    }

    // Cantidades de ESTA recepción. Antes `received_quantity || cantidad`
    // convertía un 0 explícito en la cantidad completa.
    const pendingOf = (it) => round2(Number(it.quantity || 0) - Number(it.received_quantity || 0));
    const receivedNow = new Map();
    if (Array.isArray(received_items) && received_items.length > 0) {
      for (const ri of received_items) {
        const item = purchase.items.find((it) => it.id === ri.item_id);
        if (!item) continue;
        const raw = ri.received_quantity;
        const qty = raw === undefined || raw === null || raw === '' ? pendingOf(item) : Number(raw);
        if (!Number.isFinite(qty) || qty < 0) {
          throw Object.assign(new Error(`Cantidad inválida para ${item.product_name}`), { statusCode: 400 });
        }
        if (qty > pendingOf(item) + 0.0001) {
          throw Object.assign(new Error(`${item.product_name}: se intenta recibir ${qty} pero solo quedan ${pendingOf(item)} pendientes`), { statusCode: 400 });
        }
        if (qty > 0) receivedNow.set(item.id, qty);
      }
    } else {
      for (const it of purchase.items) if (pendingOf(it) > 0) receivedNow.set(it.id, pendingOf(it));
    }
    if (receivedNow.size === 0) {
      throw Object.assign(new Error('Indica la cantidad recibida de al menos un producto'), { statusCode: 400 });
    }

    const movementDate = receipt_date
      ? String(receipt_date).slice(0, 10)
      : (purchase.purchase_date ? new Date(purchase.purchase_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]);
    const receiptItems = [];

    for (const purchaseItem of purchase.items) {
      const received_quantity = receivedNow.get(purchaseItem.id);
      if (!received_quantity) continue;

      // Cantidad recibida ACUMULADA en el ítem.
      await purchaseItem.update({
        received_quantity: round2(Number(purchaseItem.received_quantity || 0) + received_quantity)
      }, { transaction: t });

      const product = await Product.findByPk(purchaseItem.product_id, { transaction: t });
      if (!product) continue;

      // El kardex debe capitalizar lo mismo que el asiento contable acredita
      // a 143501 (subtotal - descuento global + flete, ver
      // generatePurchaseEntry), no el precio de lista de la línea.
      const landedUnitCost = resolveLandedPurchaseUnitCost(purchaseItem, purchase);

      // Crear movimiento de entrada (actualiza current_stock y average_cost automáticamente)
      await createMovement({
        tenant_id: tenant_id,
        movement_type: 'entrada',
        movement_reason: 'purchase_receipt',
        reference_type: 'purchase',
        reference_id: purchase.id,
        product_id: purchaseItem.product_id,
        warehouse_id: resolvedWarehouseId,
        quantity: received_quantity,
        unit_cost: landedUnitCost,
        user_id: req.user.id,
        movement_date: movementDate,
        notes: `Recepcion compra ${purchase.purchase_number} - ${purchaseItem.product_name}`
      }, t);

      receiptItems.push({ item_id: purchaseItem.id, product_id: purchaseItem.product_id, product_name: purchaseItem.product_name, quantity: received_quantity });

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

    // ¿Quedó todo recibido? purchaseItem.update ya dejó en memoria la
    // cantidad acumulada de los ítems recibidos ahora.
    const previousReceipts = Array.isArray(purchase.receipts) ? purchase.receipts : [];
    const finalReceipt = purchase.items.every((it) => Number(it.received_quantity || 0) >= Number(it.quantity || 0) - 0.0001);

    // Una sola recepción que lo trae todo = el asiento de siempre (compra
    // completa, fecha de la compra). Con varias, cada una lleva su porción.
    const singleFull = finalReceipt && previousReceipts.length === 0;
    const portion = singleFull ? null : {
      ...buildReceiptPortion(purchase, receivedNow, previousReceipts, finalReceipt),
      label: `Recepción ${previousReceipts.length + 1}${finalReceipt ? ' (final)' : ' (parcial)'}`,
      entry_date: movementDate,
    };

    const receipt = {
      id: require('crypto').randomUUID(),
      number: previousReceipts.length + 1,
      date: movementDate,
      user_id: req.user.id,
      notes: receiptNotes || null,
      is_final: finalReceipt,
      items: receiptItems,
      amounts: portion
        ? { inventory: portion.inventory, tax: portion.tax, retefuente: portion.retefuente, reteiva: portion.reteiva, reteica: portion.reteica, retention_lines: portion.retention_lines }
        : null,
      journal_entry_id: null,
    };

    await purchase.update({
      status: finalReceipt ? 'received' : 'partially_received',
      received_date: finalReceipt ? new Date() : purchase.received_date,
      receipts: [...previousReceipts, receipt],
    }, { transaction: t });

    await t.commit();

    // Asiento de esta recepción y de pagos pendientes (no bloqueante: si
    // falla, se loguea y queda para "Salud contable").
    try {
      const { generatePurchaseEntry } = require('../../services/accounting/autoEntries.service');
      const entry = await generatePurchaseEntry(purchase, tenant_id, req.user.id, portion ? { portion } : {});
      if (entry?.id) {
        const fresh = await Purchase.findByPk(purchase.id);
        await fresh.update({
          receipts: (fresh.receipts || []).map((r) => (r.id === receipt.id ? { ...r, journal_entry_id: entry.id } : r)),
        });
      }
      await recordPurchasePaymentEntries(purchase.id, tenant_id, req.user.id);
    } catch (err) {
      require('../../config/logger').warn(`[accounting] Error generando asiento de recepción de compra ${purchase.id}: ${err.message}`);
    }

    // Obtener compra actualizada
    const updatedPurchase = await Purchase.findByPk(id, {
      include: [
        { model: Supplier, as: 'supplier' },
        { model: PurchaseItem, as: 'items', include: [{ model: Product, as: 'product' }] }
      ]
    });

    // 🔔 Verificación automática de alertas
    markProductsForAlertCheck(res, [...receivedNow.keys()].map((itemId) => purchase.items.find((i) => i.id === itemId)?.product_id).filter(Boolean), tenant_id);
    markPurchaseForAlertCheck(res, purchase.id, tenant_id);

    res.json({
      success: true,
      message: finalReceipt
        ? 'Compra recibida completamente. Stock, costos y precios actualizados.'
        : `Recepción parcial registrada (${receiptItems.length} producto(s)). La compra queda abierta para lo pendiente.`,
      data: updatedPurchase
    });
  } catch (error) {
    if (t && !t.finished) {
      await t.rollback();
    }
    console.error('Error en receivePurchase:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode || process.env.NODE_ENV === 'development' ? (error.message || 'Error al recibir compra') : 'Error al recibir compra'
    });
  }
};

/**
 * Compra completa + datos para el PDF de la orden (códigos del proveedor,
 * lugar de entrega, quién autoriza).
 */
async function loadPurchaseOrderData(req) {
  const tenant_id = req.user.tenant_id;
  const purchase = await Purchase.findOne({
    where: { id: req.params.id, tenant_id },
    include: [
      { model: Supplier, as: 'supplier' },
      { model: PurchaseItem, as: 'items', include: [{ model: Product, as: 'product', attributes: ['id', 'sku', 'name'] }] },
    ],
    order: [[{ model: PurchaseItem, as: 'items' }, 'line_number', 'ASC']],
  });
  if (!purchase) throw Object.assign(new Error('Compra no encontrada'), { statusCode: 404 });

  // Código del producto EN EL PROVEEDOR (el que él reconoce), si se conoce.
  const links = await ProductSupplier.findAll({
    where: { tenant_id, supplier_id: purchase.supplier_id, product_id: (purchase.items || []).map((i) => i.product_id) },
    attributes: ['product_id', 'supplier_code'],
  });
  const supplierCodes = new Map(links.filter((l) => l.supplier_code).map((l) => [l.product_id, l.supplier_code]));

  // Lugar de entrega: bodega de la compra, o la de su sede.
  let deliveryPlace = null;
  if (purchase.warehouse_id) {
    const wh = await Warehouse.findOne({ where: { id: purchase.warehouse_id, tenant_id } });
    deliveryPlace = wh ? [wh.name, wh.address].filter(Boolean).join(' — ') : null;
  }
  if (!deliveryPlace && purchase.branch_id) {
    const br = await Branch.findOne({ where: { id: purchase.branch_id, tenant_id } });
    deliveryPlace = br ? [br.name, br.address].filter(Boolean).join(' — ') : null;
  }

  const tenant = await Tenant.findByPk(tenant_id);
  const authorizedBy = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || req.user.email || null;
  return { purchase, tenant, opts: { supplierCodes, deliveryPlace, authorizedBy } };
}

/**
 * PDF de la orden de compra (para descargar/imprimir o enviar al proveedor).
 * GET /purchases/:id/pdf
 */
const getPurchaseOrderPdf = async (req, res) => {
  try {
    const { purchase, tenant, opts } = await loadPurchaseOrderData(req);
    const { generatePurchaseOrderPDFBuffer } = require('../../services/purchaseOrderPdf.service');
    const buffer = await generatePurchaseOrderPDFBuffer(purchase, tenant, opts);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Orden-de-compra-${purchase.purchase_number}.pdf"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error en getPurchaseOrderPdf:', error);
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Error generando el PDF de la orden' });
  }
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);
const escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Envía la orden de compra al proveedor por correo, con el PDF adjunto.
 * POST /purchases/:id/send-email  { to?, cc?, message? }
 * Sin `to`, se usa el correo del proveedor (y el de su contacto). Las
 * respuestas del proveedor llegan al correo de la empresa (replyTo).
 */
const sendPurchaseOrderEmail = async (req, res) => {
  try {
    const { purchase, tenant, opts } = await loadPurchaseOrderData(req);
    if (purchase.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'No se puede enviar una orden cancelada' });
    }

    const supplier = purchase.supplier || {};
    const to = toList(req.body?.to).length ? toList(req.body.to) : [supplier.email, supplier.contact_email].filter(Boolean);
    const cc = toList(req.body?.cc);
    const invalid = [...to, ...cc].filter((e) => !isEmail(e));
    if (to.length === 0) {
      return res.status(400).json({ success: false, message: 'El proveedor no tiene correo registrado: indica a quién enviar la orden' });
    }
    if (invalid.length) {
      return res.status(400).json({ success: false, message: `Correo(s) inválido(s): ${invalid.join(', ')}` });
    }

    const { generatePurchaseOrderPDFBuffer } = require('../../services/purchaseOrderPdf.service');
    const pdf = await generatePurchaseOrderPDFBuffer(purchase, tenant, opts);

    const cfg = tenant?.dian_config || {};
    const company = cfg.company_name || tenant?.company_name || 'Nuestra empresa';
    const replyEmail = tenant?.email || cfg.email || req.user.email || null;
    const message = String(req.body?.message || '').trim();
    const html = `
      <p>Estimado(a) ${escapeHtml(supplier.contact_name || supplier.business_name || supplier.name || 'proveedor')},</p>
      ${message ? `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>` : `<p>Adjuntamos la orden de compra <strong>${escapeHtml(purchase.purchase_number)}</strong>.</p>`}
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Orden</td><td><strong>${escapeHtml(purchase.purchase_number)}</strong></td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Fecha</td><td>${escapeHtml(String(purchase.purchase_date || '').slice(0, 10))}</td></tr>
        ${purchase.expected_delivery_date ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">Entrega esperada</td><td>${escapeHtml(String(purchase.expected_delivery_date).slice(0, 10))}</td></tr>` : ''}
        ${opts.deliveryPlace ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">Lugar de entrega</td><td>${escapeHtml(opts.deliveryPlace)}</td></tr>` : ''}
        <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Productos</td><td>${(purchase.items || []).length}</td></tr>
      </table>
      <p>Por favor cite el número de orden en la factura electrónica.${replyEmail ? ` Para cualquier inquietud responda a este correo (${escapeHtml(replyEmail)}).` : ''}</p>
      <p>Cordialmente,<br>${escapeHtml(opts.authorizedBy || '')}<br><strong>${escapeHtml(company)}</strong></p>
    `;

    const emailService = require('../../services/emailService');
    const result = await emailService.sendEmail({
      to,
      cc,
      replyTo: replyEmail ? { email: replyEmail, name: company } : undefined,
      subject: `Orden de compra ${purchase.purchase_number} — ${company}`,
      html,
      attachments: [{ filename: `Orden-de-compra-${purchase.purchase_number}.pdf`, content: pdf }],
    });

    if (result?.mode === 'log') {
      return res.status(503).json({ success: false, message: 'El envío de correos no está configurado en el servidor (Brevo). Descarga el PDF y envíalo manualmente.' });
    }

    await purchase.update({
      order_emails: [...(purchase.order_emails || []), {
        date: new Date(), to, cc, user_id: req.user.id, message_id: result?.messageId || null,
      }],
    });

    res.json({ success: true, message: `Orden enviada a ${to.join(', ')}`, data: { to, cc } });
  } catch (error) {
    console.error('Error en sendPurchaseOrderEmail:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : (error.response?.data?.message || 'Error enviando la orden por correo'),
    });
  }
};

/**
 * Registrar la factura del proveedor sobre una orden ya confirmada (o
 * recibida): número de factura y, opcional, fecha de vencimiento. Con la
 * factura registrada la orden pasa a ser cuenta por pagar aunque la
 * mercancía no haya llegado (ver utils/purchaseAmounts.isPayablePurchase).
 * PATCH /purchases/:id/invoice  { invoice_number, due_date? }
 */
const registerSupplierInvoice = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const invoice_number = String(req.body?.invoice_number || '').trim();
    const { due_date } = req.body || {};
    if (!invoice_number) return res.status(400).json({ success: false, message: 'Indica el número de factura del proveedor' });

    const purchase = await Purchase.findOne({ where: { id: req.params.id, tenant_id } });
    if (!purchase) return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    if (['draft', 'cancelled'].includes(purchase.status)) {
      return res.status(400).json({ success: false, message: purchase.status === 'draft' ? 'En borrador, edita la compra para indicar la factura' : 'La compra está cancelada' });
    }

    const duplicate = await Purchase.findOne({ where: { tenant_id, invoice_number, id: { [Op.ne]: purchase.id } }, attributes: ['purchase_number'] });
    if (duplicate) {
      return res.status(409).json({ success: false, message: `Esa factura ya está registrada en la compra ${duplicate.purchase_number}` });
    }

    const updates = { invoice_number };
    if (due_date) updates.due_date = String(due_date).slice(0, 10);
    await purchase.update(updates);
    markPurchaseForAlertCheck(res, purchase.id, tenant_id);
    res.json({ success: true, message: 'Factura del proveedor registrada', data: purchase });
  } catch (error) {
    console.error('Error en registerSupplierInvoice:', error);
    res.status(500).json({ success: false, message: 'Error registrando la factura del proveedor' });
  }
};

/**
 * Catálogo de retenciones del tenant (conceptos vigentes + valores por
 * defecto + perfil tributario), para la configuración y los selectores de
 * producto/categoría/proveedor.
 * GET /purchases/retentions/catalog
 */
const getRetentionCatalog = async (req, res) => {
  try {
    const { resolveFiscalProfile } = require('../../services/retentionEngine.service');
    const defaults = require('../../data/retention-concepts-default');
    const tenant = await Tenant.findByPk(req.user.tenant_id, { attributes: ['tax_config'] });
    const profile = resolveFiscalProfile(tenant?.tax_config || {});
    res.json({
      success: true,
      data: {
        profile: {
          regime: profile.regime,
          is_gran_contribuyente: profile.is_gran_contribuyente,
          is_agente_reteiva: profile.is_agente_reteiva,
          reteiva_rate: profile.reteiva_rate,
          uvt_value: profile.uvt_value,
        },
        concepts: profile.concepts,
        expense_category_concepts: profile.expense_category_concepts,
        defaults: {
          concepts: defaults.DEFAULT_RETENTION_CONCEPTS,
          expense_category_concepts: defaults.DEFAULT_EXPENSE_CATEGORY_CONCEPTS,
          uvt_value: defaults.DEFAULT_UVT_VALUE,
          concept_by_type: defaults.DEFAULT_CONCEPT_BY_TYPE,
        },
      },
    });
  } catch (error) {
    console.error('Error en getRetentionCatalog:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo el catálogo de retenciones' });
  }
};

/**
 * Vista previa de retenciones para el formulario de compra/gasto, con las
 * notas que explican por qué aplica o no cada una.
 * POST /purchases/retentions/preview
 *   compra: { supplier_id, items: [{ product_id, quantity, unit_cost, discount_percentage, tax_rate }] }
 *   gasto:  { supplier_id, expense: { category, subtotal, tax_amount } }
 */
const previewRetentions = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { supplier_id, items, expense } = req.body || {};
    const [tenant, supplier] = await Promise.all([
      Tenant.findByPk(tenant_id, { attributes: ['tax_config'] }),
      supplier_id ? Supplier.findOne({ where: { id: supplier_id, tenant_id } }) : null,
    ]);
    const taxConfig = tenant?.tax_config || {};

    if (expense) {
      const data = computeExpenseRetentions({
        taxConfig, supplier: supplier || {}, category: expense.category,
        subtotal: Number(expense.subtotal) || 0, tax_amount: Number(expense.tax_amount) || 0,
      });
      return res.json({ success: true, data });
    }

    const lines = (Array.isArray(items) ? items : []).map((it) => {
      const quantity = Number(it.quantity) || 0;
      const unit = Number(it.unit_cost) || 0;
      const disc = Number(it.discount_percentage) || 0;
      const subtotal = quantity * unit * (1 - disc / 100);
      return { product_id: it.product_id, subtotal, tax_amount: subtotal * (Number(it.tax_rate) || 0) / 100 };
    });
    const data = await computePurchaseRetentions({ tenantId: tenant_id, taxConfig, supplier: supplier || {}, items: lines });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en previewRetentions:', error);
    res.status(500).json({ success: false, message: 'Error calculando retenciones' });
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

    if (['received', 'partially_received'].includes(purchase.status)) {
      return res.status(400).json({
        success: false,
        message: purchase.status === 'received'
          ? 'No se puede cancelar una compra que ya fue recibida'
          : 'Esta compra ya tiene mercancía recibida: registra una devolución en vez de cancelarla'
      });
    }

    // Con pagos ya contabilizados, cancelar dejaría el dinero entregado sin
    // contrapartida (ni deuda ni reembolso). El pago de contado marcado en un
    // borrador no cuenta: todavía no tiene asiento.
    const accountedPayments = (purchase.payment_history || []).filter((p) => p.journal_entry_id);
    if (purchase.status !== 'draft' && accountedPayments.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Esta compra tiene pagos registrados al proveedor. Registra primero el reembolso (o aplícalo a otra compra) antes de cancelarla.'
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

    // 🔔 Resolver alertas de cuentas por pagar que ya no aplican
    markPurchaseForAlertCheck(res, purchase.id, tenant_id);

    res.json({
      success: true,
      message: 'Compra cancelada exitosamente',
      data: purchase
    });
  } catch (error) {
    console.error('Error en cancelPurchase:', error);
    res.status(500).json({ success: false, message: 'Error al cancelar compra'});
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
    res.status(500).json({ success: false, message: 'Error al eliminar compra'});
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

    const partiallyReceivedPurchases = await Purchase.count({
      where: { tenant_id, status: 'partially_received' }
    });

    const cancelledPurchases = await Purchase.count({
      where: { tenant_id, status: 'cancelled' }
    });

    // Total gastado este mes
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const totalThisMonth = await Purchase.sum('total_amount', {
      where: {
        tenant_id,
        status: { [Op.in]: ['confirmed', 'partially_received', 'received'] },
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
        partially_received: partiallyReceivedPurchases,
        cancelled: cancelledPurchases,
        total_this_month: parseFloat(totalThisMonth)
      }
    });
  } catch (error) {
    console.error('Error en getPurchaseStats:', error);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas'});
  }
};

module.exports = {
  buildReceiptPortion,
  getRetentionCatalog,
  previewRetentions,
  registerSupplierInvoice,
  getPurchaseOrderPdf,
  sendPurchaseOrderEmail,
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