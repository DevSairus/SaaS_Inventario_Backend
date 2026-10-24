const { 
  SupplierReturn, 
  SupplierReturnItem, 
  Purchase, 
  PurchaseItem, 
  Product, 
  Supplier 
} = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { SUPPLIER_RETURN_REASONS, reasonLabel } = require('../../utils/returnLabels');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const { resolveLandedPurchaseUnitCost } = require('../../utils/costResolver');
const { purchaseBalance, purchasePaymentStatus, payablePurchaseWhere, round2 } = require('../../utils/purchaseAmounts');
const { getOpenSession, isTreasuryEnabled } = require('../../services/finance/cashSession.service');
const { resolveSelectedBankAccountId } = require('../../services/accounting/bankAccountSelection');
const { markPurchaseForAlertCheck } = require('../../middleware/autoCheckPayableAlerts.middleware');

const SETTLEMENT_TYPES = ['refund', 'credit'];
const badRequest = (message) => { const err = new Error(message); err.status = 400; return err; };

// Aplica saldo a favor con un proveedor a sus compras con saldo (la más
// antigua primero), como un abono SIN dinero: payment_history con source
// 'supplier_credit' (sin asiento propio -- el asiento de la devolución ya
// debitó Proveedores -- y fuera de Flujo de Caja). Devuelve lo aplicado.
async function applySupplierCredit({ supplierReturn, amount, tenantId, userId, transaction }) {
  const { Purchase } = require('../../models');
  let remaining = round2(amount);
  if (remaining <= 0) return { applied: 0, applications: [], purchaseIds: [] };
  const purchases = await Purchase.findAll({
    where: {
      tenant_id: tenantId,
      supplier_id: supplierReturn.supplier_id,
      payment_status: { [Op.in]: ['pending', 'partial'] },
      ...payablePurchaseWhere(),
    },
    order: [['purchase_date', 'ASC'], ['purchase_number', 'ASC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  const applications = [];
  for (const purchase of purchases) {
    if (remaining <= 0) break;
    const value = round2(Math.min(remaining, purchaseBalance(purchase)));
    if (value <= 0) continue;
    remaining = round2(remaining - value);
    const paid_amount = round2(Number(purchase.paid_amount || 0) + value);
    const date = new Date();
    await purchase.update({
      paid_amount,
      payment_status: purchasePaymentStatus(purchase, paid_amount),
      payment_history: [...(purchase.payment_history || []), {
        id: require('crypto').randomUUID(),
        date,
        amount: value,
        method: 'Saldo a favor',
        source: 'supplier_credit',
        supplier_return_id: supplierReturn.id,
        user_id: userId,
        notes: `Saldo a favor por devolución ${supplierReturn.return_number}`,
      }],
    }, { transaction });
    applications.push({ purchase_id: purchase.id, purchase_number: purchase.purchase_number, amount: value, date });
  }
  const applied = round2(amount - remaining);
  return { applied, applications, purchaseIds: applications.map((a) => a.purchase_id) };
}

const RETURNABLE_PURCHASE_STATUSES = ['received', 'partially_received'];

// Tope a devolver por línea = lo RECIBIDO (con recepción parcial puede ser
// menos que lo pedido; compras viejas sin received_quantity usan lo pedido).
const receivedQuantityOf = (purchaseItem) => (parseFloat(purchaseItem.received_quantity) > 0
  ? parseFloat(purchaseItem.received_quantity)
  : parseFloat(purchaseItem.quantity));

/**
 * Cantidades a devolver contra lo recibido menos lo ya devuelto. Antes no se
 * descontaban las devoluciones anteriores: la misma mercancía se podía
 * devolver varias veces. Agrupa líneas repetidas; `countPending` igual que
 * en devoluciones de cliente (al crear cuentan las pendientes, al aprobar
 * solo las aprobadas; las rechazadas nunca).
 */
async function validateSupplierReturnQuantities(purchase, requestedItems, { excludeReturnId = null, countPending = true, transaction } = {}) {
  const grouped = new Map();
  for (const item of requestedItems || []) {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty < 0) throw badRequest('Las cantidades a devolver deben ser números positivos.');
    if (qty === 0) continue;
    grouped.set(item.purchase_item_id, Math.round(((grouped.get(item.purchase_item_id) || 0) + qty) * 10000) / 10000);
  }
  if (grouped.size === 0) throw badRequest('Indica al menos un producto con cantidad mayor a cero.');

  const counted = await SupplierReturn.findAll({
    where: {
      purchase_id: purchase.id,
      status: { [Op.in]: countPending ? ['pending', 'approved'] : ['approved'] },
      ...(excludeReturnId ? { id: { [Op.ne]: excludeReturnId } } : {}),
    },
    attributes: ['id'],
    transaction,
  });
  const countedIds = counted.map((r) => r.id);

  for (const [purchaseItemId, qty] of grouped) {
    const purchaseItem = (purchase.items || []).find((pi) => pi.id === purchaseItemId);
    if (!purchaseItem) throw badRequest('Uno de los productos no pertenece a esta compra.');
    const alreadyReturned = Number(await SupplierReturnItem.sum('quantity', {
      where: { purchase_item_id: purchaseItemId, return_id: { [Op.in]: countedIds } },
      transaction,
    }) || 0);
    const remaining = Math.round((receivedQuantityOf(purchaseItem) - alreadyReturned) * 10000) / 10000;
    if (qty > remaining + 0.00001) {
      const name = purchaseItem.product_name || 'el producto';
      throw badRequest(remaining > 0
        ? `De ${name} solo quedan ${remaining} unidades recibidas por devolver.`
        : `${name} ya fue devuelto en su totalidad.`);
    }
  }
  return grouped;
}

async function priorSupplierRetentionReversal(purchaseId, excludeReturnId, transaction) {
  const { addRetentions } = require('../../services/returns/returnSettlement');
  const previous = await SupplierReturn.findAll({
    where: { purchase_id: purchaseId, status: 'approved', ...(excludeReturnId ? { id: { [Op.ne]: excludeReturnId } } : {}) },
    attributes: ['retention_reversal'],
    transaction,
  });
  return addRetentions(previous.map((r) => r.retention_reversal || {}));
}

/**
 * Liquida una devolución a proveedor al aprobarla, con la compra bloqueada
 * (services/returns/returnSettlement.js): reversa la parte proporcional de
 * las retenciones practicadas, baja primero lo que se le debe al proveedor
 * por esa compra (returned_amount) y el excedente -- lo que ya se le había
 * pagado -- es 'refund' (entra a caja/banco) o 'credit' (saldo a favor que se
 * aplica a sus otras compras pendientes).
 */
async function settleSupplierReturn(supplierReturn, settlementInput, req, transaction) {
  const { Purchase: PurchaseModel } = require('../../models');
  const { supplierReturnSettlement } = require('../../services/returns/returnSettlement');
  const tenantId = req.user.tenant_id;
  const purchase = await PurchaseModel.findOne({
    where: { id: supplierReturn.purchase_id, tenant_id: tenantId },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!purchase) throw badRequest('La compra de esta devolución no existe.');

  const prior = await priorSupplierRetentionReversal(purchase.id, supplierReturn.id, transaction);
  const calc = supplierReturnSettlement(purchase, supplierReturn.total_amount, prior);

  if (calc.reduction > 0) {
    purchase.returned_amount = round2(Number(purchase.returned_amount || 0) + calc.reduction);
    await purchase.update({ returned_amount: purchase.returned_amount, payment_status: purchasePaymentStatus(purchase) }, { transaction });
  }

  const fields = {
    payable_reduction: calc.reduction,
    retention_reversal: calc.retention_reversal,
    money_back_amount: calc.money_back,
  };
  if (calc.money_back <= 0) return { fields, purchaseIds: [] };

  const { settlement_type, payment_method, bank_account_id } = settlementInput || {};
  if (!SETTLEMENT_TYPES.includes(settlement_type)) {
    throw badRequest('Indica si el proveedor devuelve el dinero o queda como saldo a favor con el proveedor.');
  }

  if (settlement_type === 'credit') {
    const { applied, applications, purchaseIds } = await applySupplierCredit({
      supplierReturn, amount: calc.money_back, tenantId, userId: req.user.id, transaction,
    });
    return {
      fields: { ...fields, settlement_type, refund_amount: 0, credit_amount: calc.money_back, credit_applied_amount: applied, credit_applications: applications },
      purchaseIds,
    };
  }

  let openSession = null;
  if (await isTreasuryEnabled(tenantId)) {
    openSession = await getOpenSession(tenantId, req.branch_id, transaction);
    if (!openSession) throw badRequest('No hay una caja abierta en esta sede. Abre la caja antes de recibir el reintegro.');
  }
  const method = payment_method || 'Efectivo';
  return {
    fields: {
      ...fields,
      settlement_type,
      refund_amount: calc.money_back,
      refund_method: method,
      refund_bank_account_id: await resolveSelectedBankAccountId(tenantId, bank_account_id, method, transaction),
      refund_cash_session_id: openSession?.id || null,
      refund_branch_id: req.branch_id || purchase.branch_id || null,
      refund_date: new Date(),
    },
    purchaseIds: [],
  };
}

// GET /preview?purchase_id=&amount=&exclude_return_id=
const getSupplierReturnSettlementPreview = async (req, res) => {
  try {
    const { purchase_id, amount, exclude_return_id } = req.query;
    const value = Number(amount);
    if (!purchase_id || !Number.isFinite(value) || value < 0) {
      return res.status(400).json({ success: false, message: 'purchase_id y amount son obligatorios' });
    }
    const { supplierReturnSettlement, sumRetentions } = require('../../services/returns/returnSettlement');
    const purchase = await Purchase.findOne({ where: { id: purchase_id, tenant_id: req.user.tenant_id } });
    if (!purchase) return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    const prior = await priorSupplierRetentionReversal(purchase.id, exclude_return_id || null);
    const calc = supplierReturnSettlement(purchase, value, prior);
    res.json({
      success: true,
      data: {
        reduction: calc.reduction,
        retention_reversal: calc.retention_reversal,
        retention_reversal_total: sumRetentions(calc.retention_reversal),
        money_back: calc.money_back,
        needs_support_adjustment: !!(await acceptedSupportDocumentFor(purchase.id, req.user.tenant_id)),
      },
    });
  } catch (error) {
    console.error('Error en getSupplierReturnSettlementPreview:', error);
    res.status(500).json({ success: false, message: 'Error calculando la liquidación' });
  }
};

// Documento Soporte aceptado de la compra (proveedor no obligado a facturar):
// una devolución sobre él necesita Nota de Ajuste (tipo DIAN 95).
async function acceptedSupportDocumentFor(purchaseId, tenantId) {
  const { SupportDocument } = require('../../models');
  return SupportDocument.findOne({
    where: { tenant_id: tenantId, purchase_id: purchaseId, dian_status: 'accepted' },
    order: [['created_at', 'DESC']],
  });
}

// Nota de Ajuste (crédito) al Documento Soporte por lo devuelto. Solo
// documento fiscal (la de DIAN no genera asiento). Si falla, la devolución
// queda aprobada y se reintenta desde el detalle.
async function issueSupplierReturnSupportAdjustment(supplierReturn, tenantId, userId) {
  if (supplierReturn.support_adjustment_id) return null;
  const supportDocument = await acceptedSupportDocumentFor(supplierReturn.purchase_id, tenantId);
  if (!supportDocument) return null;
  const { createSupportDocumentAdjustment } = require('../../services/dian/supportDocumentAdjustment.service');
  const items = (supplierReturn.items || []).map((i) => ({
    description: i.product?.name || 'Devolución',
    quantity: Number(i.quantity),
    unit_price: Number(i.unit_cost || 0),
    tax_percentage: Number(i.subtotal) > 0 ? Math.round((Number(i.tax || 0) / Number(i.subtotal)) * 10000) / 100 : 0,
  }));
  const adjustment = await createSupportDocumentAdjustment({
    tenantId,
    supportDocumentId: supportDocument.id,
    adjustment_type: 'credit',
    reason: `Devolución ${supplierReturn.return_number}: ${reasonLabel(SUPPLIER_RETURN_REASONS, supplierReturn.reason)}`,
    items,
    userId,
  });
  await SupplierReturn.update({ support_adjustment_id: adjustment.id }, { where: { id: supplierReturn.id, tenant_id: tenantId } });
  supplierReturn.support_adjustment_id = adjustment.id;
  return adjustment;
}

// POST /:id/support-adjustment -- reintento de la Nota de Ajuste.
const issueSupplierReturnSupportAdjustmentHandler = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const supplierReturn = await SupplierReturn.findOne({
      where: { id: req.params.id, tenant_id },
      include: [{ model: SupplierReturnItem, as: 'items', include: [{ model: Product, as: 'product' }] }],
    });
    if (!supplierReturn) return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    if (supplierReturn.status !== 'approved') return res.status(400).json({ success: false, message: 'Solo las devoluciones aprobadas generan Nota de Ajuste' });
    if (supplierReturn.support_adjustment_id) return res.status(400).json({ success: false, message: 'Esta devolución ya tiene Nota de Ajuste' });
    const adjustment = await issueSupplierReturnSupportAdjustment(supplierReturn, tenant_id, req.user.id);
    if (!adjustment) return res.status(400).json({ success: false, message: 'La compra no tiene Documento Soporte aceptado: no requiere Nota de Ajuste' });
    res.json({ success: true, message: 'Nota de Ajuste creada. Envío a DIAN en proceso.', data: { support_adjustment_id: adjustment.id } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('Error en issueSupplierReturnSupportAdjustment:', error);
    res.status(500).json({ success: false, message: 'Error al crear la Nota de Ajuste' });
  }
};

const generateReturnNumber = async (tenant_id, transaction = null) => {
  const year = new Date().getFullYear();
  const prefix = `DEVP-${year}-`;

  const findOptions = {
    where: {
      tenant_id,
      return_number: { [Op.like]: `${prefix}%` }
    },
    order: [['return_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction: transaction || undefined
  };

  const lastReturn = await SupplierReturn.findOne(findOptions);

  let nextNumber = 1;
  if (lastReturn) {
    const lastNum = parseInt(lastReturn.return_number.split('-').pop(), 10);
    if (!isNaN(lastNum)) nextNumber = lastNum + 1;
  }

  return `${prefix}${String(nextNumber).padStart(5, '0')}`;
};

const getSupplierReturns = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const {
      search = '',
      supplier_id,
      status,
      start_date,
      end_date,
      sort_by = 'return_date',
      sort_order = 'DESC',
      page = 1,
      limit = 10
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;
    const where = { tenant_id };

    if (search) {
      where[Op.or] = [
        { return_number: { [Op.iLike]: `%${search}%` } },
        { notes: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (supplier_id) where.supplier_id = supplier_id;
    if (status) where.status = status;
    if (start_date) where.return_date = { [Op.gte]: start_date };
    if (end_date) where.return_date = { ...where.return_date, [Op.lte]: end_date };

    const { count, rows } = await SupplierReturn.findAndCountAll({
      where,
      include: [
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'business_name', 'email', 'phone']
        },
        {
          model: Purchase,
          as: 'purchase',
          attributes: ['id', 'purchase_number', 'purchase_date', 'total_amount', 'total_retentions', 'paid_amount']
        }
      ],
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(1, parseInt(limit) || 10), 200),
      offset: (Math.max(1, parseInt(page) || 1) - 1) * Math.min(Math.max(1, parseInt(limit) || 10), 200)
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: Math.max(1, parseInt(page) || 1),
        limit: Math.min(Math.max(1, parseInt(limit) || 10), 200),
        pages: Math.ceil(count / Math.min(Math.max(1, parseInt(limit) || 10), 200))
      }
    });
  } catch (error) {
    console.error('Error en getSupplierReturns:', error);
    res.status(500).json({ success: false, message: 'Error al obtener devoluciones' });
  }
};

const getSupplierReturnById = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const supplierReturn = await SupplierReturn.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: SupplierReturnItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku', 'barcode']
            },
            {
              model: PurchaseItem,
              as: 'purchaseItem',
              attributes: ['id', 'quantity', 'unit_cost']
            }
          ]
        },
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'business_name', 'email', 'phone']
        },
        {
          model: Purchase,
          as: 'purchase',
          attributes: ['id', 'purchase_number', 'purchase_date', 'total_amount', 'total_retentions', 'paid_amount']
        }
      ]
    });

    if (!supplierReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    // Nota de Ajuste al Documento Soporte: la emitida o si hace falta emitirla.
    const data = supplierReturn.toJSON();
    if (supplierReturn.support_adjustment_id) {
      const { SupportDocumentAdjustment } = require('../../models');
      data.support_adjustment = await SupportDocumentAdjustment.findOne({
        where: { id: supplierReturn.support_adjustment_id, tenant_id: req.user.tenant_id },
        attributes: ['id', 'adjustment_number', 'dian_status', 'dian_error_message'],
      });
    } else if (supplierReturn.status === 'approved') {
      data.requires_support_adjustment = !!(await acceptedSupportDocumentFor(supplierReturn.purchase_id, req.user.tenant_id));
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en getSupplierReturnById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener devolución' });
  }
};

const createSupplierReturn = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const tenant_id = req.user.tenant_id;
    const { purchase_id, reason, notes, items } = req.body;

    const purchase = await Purchase.findOne({
      where: { id: purchase_id, tenant_id },
      include: [{ model: PurchaseItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
    });

    if (!purchase) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    // Solo se devuelve mercancía que efectivamente entró al inventario.
    if (!['received', 'partially_received'].includes(purchase.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Solo se puede devolver mercancía de una compra recibida (total o parcialmente)' });
    }

    // Validar items: cantidades válidas, líneas repetidas agrupadas y tope =
    // recibido - ya devuelto (pendientes y aprobadas).
    try {
      await validateSupplierReturnQuantities(purchase, items, { countPending: true, transaction });
    } catch (validationError) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: validationError.message });
    }

    let subtotal = 0;
    let tax = 0;

    const returnItems = items.map(item => {
      const purchaseItem = purchase.items.find(pi => pi.id === item.purchase_item_id);
      // Mismo costo "aterrizado" que capitalizó el kardex al recibir la compra
      // (ver resolveLandedPurchaseUnitCost) -- usar el precio de lista bruto
      // acá dejaba el 143501 reversado por menos de lo que realmente salió
      // de inventario.
      // Sin IVA en el costo: aquí el IVA se calcula aparte (itemTax) y el
      // asiento de la devolución lo lleva al inventario si el tenant no es
      // responsable de IVA (autoEntries.generateSupplierReturnEntry).
      const landedUnitCost = resolveLandedPurchaseUnitCost(purchaseItem, purchase);
      const itemSubtotal = parseFloat(item.quantity) * landedUnitCost;
      const itemTax = itemSubtotal * (parseFloat(purchaseItem.tax_rate || 0) / 100);

      subtotal += itemSubtotal;
      tax += itemTax;

      return {
        purchase_item_id: item.purchase_item_id,
        product_id: purchaseItem.product_id,
        quantity: item.quantity,
        unit_cost: landedUnitCost,
        subtotal: itemSubtotal,
        tax: itemTax,
        total: itemSubtotal + itemTax
      };
    });

    const total_amount = subtotal + tax;

    // Generate number inside the transaction with a row-level lock to prevent
    // duplicate numbers under concurrent requests. A retry handles the rare
    // case where two transactions commit simultaneously with the same number.
    const MAX_RETRIES = 5;
    let supplierReturn;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const return_number = await generateReturnNumber(tenant_id, transaction);

      try {
        supplierReturn = await SupplierReturn.create({
      tenant_id,
          return_number,
          purchase_id,
          supplier_id: purchase.supplier_id,
          return_date: new Date(),
          reason,
          notes,
          subtotal,
          tax,
          total_amount,
          status: 'pending',
          created_by: req.user.id
        }, { transaction });

        break; // success — exit retry loop
      } catch (uniqueErr) {
        if (
          uniqueErr.name === 'SequelizeUniqueConstraintError' &&
          uniqueErr.fields &&
          uniqueErr.fields.return_number &&
          attempt < MAX_RETRIES
        ) {
          // Another request grabbed this number — try again with the next one
          continue;
        }
        throw uniqueErr; // unrelated error or max retries exceeded
      }
    }

    for (const item of returnItems) {
      await SupplierReturnItem.create({
        return_id: supplierReturn.id,
        ...item
      }, { transaction });
    }

    const returnComplete = await SupplierReturn.findByPk(supplierReturn.id, {
      include: [
        {
          model: SupplierReturnItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }]
        },
        { model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name'] },
        { model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number'] }
      ],
      transaction
    });

    await transaction.commit();

    res.status(201).json({
      success: true,
      message: 'Devolución creada exitosamente. Pendiente de aprobación.',
      data: returnComplete
    });
  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    console.error('Error en createSupplierReturn:', error);
    res.status(500).json({ success: false, message: 'Error al crear devolución' });
  }
};

const approveSupplierReturn = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    // Bloqueo de la fila: evita una doble aprobación simultánea.
    const lockedReturn = await SupplierReturn.findOne({ where: { id, tenant_id }, lock: transaction.LOCK.UPDATE, transaction });
    if (!lockedReturn) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    const supplierReturn = await SupplierReturn.findOne({
      where: { id, tenant_id },
      transaction,
      include: [
        { model: SupplierReturnItem, as: 'items', include: [{ model: Product, as: 'product' }] },
        { model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number', 'branch_id', 'supplier_id', 'payment_status', 'payment_method', 'total_amount', 'total_retentions', 'paid_amount', 'returned_amount'] }
      ]
    });

    if (!supplierReturn) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    if (supplierReturn.status !== 'pending') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La devolución ya fue procesada' });
    }

    // Revalidar contra el estado actual de la compra (pudo cancelarse u otra
    // devolución de las mismas unidades pudo aprobarse mientras tanto).
    const purchaseForCheck = await Purchase.findOne({
      where: { id: supplierReturn.purchase_id, tenant_id },
      include: [{ model: PurchaseItem, as: 'items' }],
      transaction,
    });
    if (!purchaseForCheck || !RETURNABLE_PURCHASE_STATUSES.includes(purchaseForCheck.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La compra ya no está recibida (pudo cancelarse): no se puede aprobar la devolución.' });
    }
    await validateSupplierReturnQuantities(
      purchaseForCheck,
      supplierReturn.items.map((i) => ({ purchase_item_id: i.purchase_item_id, quantity: i.quantity })),
      { excludeReturnId: supplierReturn.id, countPending: false, transaction }
    );

    const { createMovement } = require('./movements.controller');

    // REDUCE stock (es devolución a proveedor)
    for (const item of supplierReturn.items) {
      const product = item.product;
      
      // Generar movimiento de salida por devolución a proveedor
      // La función createMovement actualiza automáticamente el current_stock
      await createMovement({
        tenant_id,
        movement_type: 'salida',
        movement_reason: 'supplier_return',
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        reference_type: 'supplier_return',
        reference_id: supplierReturn.id,
        user_id: req.user.id,
        notes: `Devolución a proveedor ${supplierReturn.return_number} - ${reasonLabel(SUPPLIER_RETURN_REASONS, supplierReturn.reason)}`
      }, transaction);

      // Obtener el producto actualizado y recalcular available_stock
      const updatedProduct = await Product.findByPk(item.product_id, { transaction });
      if (updatedProduct) {
        await updatedProduct.update({
          available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
        }, { transaction });
      }
    }

    // Cartera con el proveedor: primero baja la parte no pagada de esta
    // compra; luego se liquida la parte ya pagada (reintegro o saldo a favor,
    // que puede aplicarse a otras compras). Ambas usan el paid/total de la
    // compra tal como estaba al aprobar (igual que el asiento).
    await require('../../services/accounting/journalEntry.service').assertPeriodOpen(tenant_id, new Date(), transaction);
    const settlement = await settleSupplierReturn(supplierReturn, req.body || {}, req, transaction);

    await supplierReturn.update({
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date(),
      ...settlement.fields
    }, { transaction });

    await transaction.commit();

    if (supplierReturn.purchase) markPurchaseForAlertCheck(res, supplierReturn.purchase.id, tenant_id);
    for (const pid of settlement.purchaseIds) markPurchaseForAlertCheck(res, pid, tenant_id);

    // Asiento contable en borrador (no bloqueante: si falla, solo se loguea).
    setImmediate(async () => {
      try {
        const { generateSupplierReturnEntry } = require('../../services/accounting/autoEntries.service');
        await generateSupplierReturnEntry(supplierReturn, supplierReturn.items, supplierReturn.purchase, tenant_id, req.user.id);
      } catch (err) {
        console.error(`[accounting] Error generando asiento de devolución a proveedor ${supplierReturn.id}:`, err.message);
      }
    });

    const product_ids = supplierReturn.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenant_id);

    // Nota de Ajuste al Documento Soporte (compra a no obligado a facturar).
    let adjustmentWarning = null;
    try {
      await issueSupplierReturnSupportAdjustment(supplierReturn, tenant_id, req.user.id);
    } catch (err) {
      console.error(`[DIAN] No se pudo crear la Nota de Ajuste de la devolución ${supplierReturn.id}:`, err.message);
      adjustmentWarning = `Devolución aprobada, pero no se pudo crear la Nota de Ajuste al Documento Soporte: ${err.message}. Reintenta desde el detalle.`;
    }

    res.json({
      success: true,
      message: adjustmentWarning || 'Devolución aprobada exitosamente',
      support_adjustment_warning: adjustmentWarning,
      data: supplierReturn
    });
  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    console.error('Error en approveSupplierReturn:', error);
    // Errores de negocio de createMovement (stock insuficiente, producto
    // inexistente): se devuelven tal cual para que el usuario sepa qué ajustar.
    if (error?.status === 400 || /Stock insuficiente|Producto no encontrado/i.test(error?.message || '')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: 'Error al aprobar devolución' });
  }
};

// POST /:id/apply-credit -- aplica el saldo a favor que haya quedado sin
// usar (no había compras pendientes al aprobar) a las compras con saldo de
// ese proveedor.
const applySupplierReturnCredit = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const supplierReturn = await SupplierReturn.findOne({
      where: { id: req.params.id, tenant_id },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!supplierReturn) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }
    const available = round2(Number(supplierReturn.credit_amount || 0) - Number(supplierReturn.credit_applied_amount || 0));
    if (supplierReturn.status !== 'approved' || supplierReturn.settlement_type !== 'credit' || available <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta devolución no tiene saldo a favor disponible' });
    }
    const { applied, applications, purchaseIds } = await applySupplierCredit({
      supplierReturn, amount: available, tenantId: tenant_id, userId: req.user.id, transaction,
    });
    if (applied <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El proveedor no tiene compras pendientes de pago a las que aplicar el saldo' });
    }
    await supplierReturn.update({
      credit_applied_amount: round2(Number(supplierReturn.credit_applied_amount || 0) + applied),
      credit_applications: [...(supplierReturn.credit_applications || []), ...applications],
    }, { transaction });
    await transaction.commit();
    for (const pid of purchaseIds) markPurchaseForAlertCheck(res, pid, tenant_id);
    res.json({ success: true, message: `Saldo a favor aplicado: ${applied}`, data: supplierReturn });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    console.error('Error en applySupplierReturnCredit:', error);
    res.status(500).json({ success: false, message: 'Error al aplicar el saldo a favor' });
  }
};

const rejectSupplierReturn = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const { rejection_reason } = req.body;
    const tenant_id = req.user.tenant_id;

    const supplierReturn = await SupplierReturn.findOne({ where: { id, tenant_id } });

    if (!supplierReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    if (supplierReturn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'La devolución ya fue procesada' });
    }

    await supplierReturn.update({
      status: 'rejected',
      rejected_by: req.user.id,
      rejected_at: new Date(),
      rejection_reason
    });

    res.json({ success: true, message: 'Devolución rechazada', data: supplierReturn });
  } catch (error) {
    console.error('Error en rejectSupplierReturn:', error);
    res.status(500).json({ success: false, message: 'Error al rechazar devolución' });
  }
};

const deleteSupplierReturn = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const supplierReturn = await SupplierReturn.findOne({ where: { id, tenant_id } });

    if (!supplierReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    if (supplierReturn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Solo se pueden eliminar devoluciones pendientes' });
    }

    await supplierReturn.destroy();

    res.json({ success: true, message: 'Devolución eliminada exitosamente' });
  } catch (error) {
    console.error('Error en deleteSupplierReturn:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar devolución' });
  }
};


// POST /:id/reverse -- reversa una devolución aprobada (services/returns/returnReversal.js).
const reverseSupplierReturn = async (req, res) => {
  try {
    const { reverseSupplierReturn: run } = require('../../services/returns/returnReversal');
    const result = await run({
      id: req.params.id,
      tenantId: req.user.tenant_id,
      userId: req.user.id,
      branchId: req.branch_id || null,
      body: req.body || {},
    });
    markProductsForAlertCheck(res, result.productIds, req.user.tenant_id);
    for (const pid of result.purchaseIds) markPurchaseForAlertCheck(res, pid, req.user.tenant_id);
    res.json({ success: true, message: 'Devolución reversada', data: result.supplierReturn });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    if (/Stock insuficiente|Producto no encontrado/i.test(error?.message || '')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('Error reversando devolución:', error);
    res.status(500).json({ success: false, message: 'Error al reversar la devolución' });
  }
};

module.exports = {
  getSupplierReturns,
  getSupplierReturnById,
  createSupplierReturn,
  approveSupplierReturn,
  reverseSupplierReturn,
  applySupplierReturnCredit,
  getSupplierReturnSettlementPreview,
  issueSupplierReturnSupportAdjustment: issueSupplierReturnSupportAdjustmentHandler,
  rejectSupplierReturn,
  deleteSupplierReturn
};