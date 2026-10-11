const { 
  CustomerReturn, 
  CustomerReturnItem,
  Sale,
  SaleItem,
  Product,
  Customer 
} = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { CUSTOMER_RETURN_REASONS, reasonLabel } = require('../../utils/returnLabels');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const { getCurrentSchema } = require('../../config/tenantContext');
const { resolveUnitCost } = require('../../utils/costResolver');
const { saleBalance, salePaymentStatus } = require('../../utils/saleAmounts');
const { getOpenSession, isTreasuryEnabled, assertCashAvailable } = require('../../services/finance/cashSession.service');
const { resolveSelectedBankAccountId } = require('../../services/accounting/bankAccountSelection');

/**
 * Generar número de devolución único.
 *
 * USA SQL DIRECTO con MAX() — el sequelize.literal en order[] falla silenciosamente
 * y siempre retornaba el mismo número. Con MAX() obtenemos el entero más alto real.
 *
 * Recibe la transacción activa para que el advisory lock sea efectivo:
 * si se llama sin transacción, el SELECT ve datos committed pero no ve lo que
 * la propia transacción bloqueada aún no ha committed.
 *
 * NOTA schema-per-tenant: la unicidad "global" que describe el comentario de
 * abajo era válida cuando todos los tenants compartían `public.customer_returns`.
 * Con schema-per-tenant cada tenant migrado tiene su propia tabla en su propio
 * schema (mismo constraint único, ahora aislado por tenant) -- calificar el
 * schema aquí no rompe esa unicidad, la vuelve "única por tenant", que es lo
 * correcto una vez los datos están físicamente separados. Sin calificar,
 * esto siempre leía "public" y podía repetir un número ya usado en el schema
 * real del tenant, sin ningún error visible.
 */
const generateReturnNumber = async (tenant_id, transaction) => {
  const year = new Date().getFullYear();
  const prefix = `DEV-${year}-`;
  const schema = getCurrentSchema() || 'public';

  // IMPORTANTE: El unique constraint de la DB es GLOBAL (solo columna return_number, sin tenant_id).
  // Si filtramos por tenant_id, no vemos los numeros de otros tenants y colisionamos con ellos.
  // La query busca el MAX global del año para garantizar unicidad en toda la DB.
  const [result] = await sequelize.query(
    `SELECT MAX(CAST(SPLIT_PART(return_number, '-', 3) AS INTEGER)) AS max_num
     FROM "${schema}"."customer_returns"
     WHERE return_number LIKE :prefix`,
    {
      replacements: { prefix: `${prefix}%` },
      type: sequelize.QueryTypes.SELECT,
      transaction
    }
  );

  const nextNumber = (result && result.max_num != null ? parseInt(result.max_num, 10) : 0) + 1;
  return `${prefix}${String(nextNumber).padStart(5, '0')}`;
};

/**
 * Obtener todas las devoluciones con filtros
 */
const getCustomerReturns = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
    }

    const {
      search = '',
      customer_id,
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
        { notes: { [Op.iLike]: `%${search}%` } },
        // La lista también busca por cliente y por número de venta.
        { '$customer.business_name$': { [Op.iLike]: `%${search}%` } },
        { '$customer.first_name$': { [Op.iLike]: `%${search}%` } },
        { '$customer.last_name$': { [Op.iLike]: `%${search}%` } },
        { '$sale.sale_number$': { [Op.iLike]: `%${search}%` } }
      ];
    }
    if (customer_id) where.customer_id = customer_id;
    if (status) where.status = status;
    if (start_date) where.return_date = { [Op.gte]: start_date };
    if (end_date) where.return_date = { ...where.return_date, [Op.lte]: end_date };

    const { count, rows } = await CustomerReturn.findAndCountAll({
      where,
      include: [
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'business_name', 'customer_type', 'email', 'phone']
        },
        {
          model: Sale,
          as: 'sale',
          // total/pagado/cliente: el modal de aprobar calcula la parte ya pagada.
          attributes: ['id', 'sale_number', 'sale_date', 'total_amount', 'paid_amount', 'customer_id']
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
    console.error('Error en getCustomerReturns:', error);
    res.status(500).json({ success: false, message: 'Error al obtener devoluciones' });
  }
};

/**
 * Obtener una devolución por ID
 */
const getCustomerReturnById = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const customerReturn = await CustomerReturn.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: CustomerReturnItem,
          as: 'items',
          include: [
            { model: Product, as: 'product', attributes: ['id', 'name', 'sku', 'barcode'] },
            { model: SaleItem, as: 'saleItem', attributes: ['id', 'quantity', 'unit_price', 'product_name', 'product_sku', 'item_type'] }
          ]
        },
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'business_name', 'customer_type', 'email', 'phone', 'address']
        },
        {
          model: Sale,
          as: 'sale',
          attributes: ['id', 'sale_number', 'sale_date', 'total_amount', 'paid_amount', 'customer_id']
        }
      ]
    });

    if (!customerReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    // Saldo a favor generado al aprobar (settlement_type 'credit').
    const data = customerReturn.toJSON();
    if (customerReturn.credit_note_sale_id) {
      data.credit_note = await Sale.findOne({
        where: { id: customerReturn.credit_note_sale_id, tenant_id: req.user.tenant_id },
        attributes: ['id', 'sale_number', 'dian_invoice_number', 'dian_status', 'dian_error_message'],
      });
    } else if (customerReturn.status === 'approved') {
      data.requires_credit_note = await saleNeedsCreditNote(customerReturn.sale_id, req.user.tenant_id);
    }
    if (customerReturn.credit_advance_id) {
      const { CustomerAdvance } = require('../../models');
      data.credit_advance = await CustomerAdvance.findOne({
        where: { id: customerReturn.credit_advance_id, tenant_id: req.user.tenant_id },
        attributes: ['id', 'advance_number', 'amount', 'balance', 'status'],
      });
    }

    res.json({ success: true, data });

  } catch (error) {
    console.error('Error en getCustomerReturnById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener devolución' });
  }
};

/**
 * Crear nueva devolución de cliente
 */
const createCustomerReturn = async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
  }
  if (!req.user.tenant_id) {
    return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
  }

  const tenant_id = req.user.tenant_id;
  const { sale_id, reason, notes, items } = req.body;

  console.log('📦 Datos recibidos para crear devolución:', { sale_id, reason, notes, items });

  if (!sale_id) {
    return res.status(400).json({ success: false, message: 'El ID de la venta es requerido' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Debe especificar al menos un producto para devolver' });
  }

  const transaction = await sequelize.transaction();

  try {
    // 1. Validar que existe la venta
    const sale = await Sale.findOne({
      where: { id: sale_id, tenant_id },
      include: [
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product' }]
        }
      ]
    });

    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }
    const { lifecycleBlocker } = require('../../services/sales/remisionInvoicing.service');
    const invoicingBlocker = lifecycleBlocker(sale);
    if (invoicingBlocker) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: invoicingBlocker });
    }

    const statusBlocker = saleReturnBlocker(sale);
    if (statusBlocker) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: statusBlocker });
    }

    // 2. Validar items a devolver: cantidades válidas, líneas repetidas
    // agrupadas y tope = vendido - devuelto (pendientes y aprobadas; antes
    // contaba también las rechazadas y no detectaba líneas repetidas).
    try {
      await validateReturnQuantities(sale, items, { countPending: true, transaction });
    } catch (validationError) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: validationError.message });
    }

    // 3. Calcular totales
    let subtotal = 0;
    let tax = 0;

    const returnItems = items.map(item => {
      const saleItem = sale.items.find(si => si.id === item.sale_item_id);
      // Proporción del subtotal e IVA REALES de la línea (ya con su descuento
      // por línea) -- mismo criterio que voidSale. Antes era cantidad ×
      // precio unitario y la devolución ignoraba el descuento de la línea.
      const ratio = parseFloat(item.quantity) / parseFloat(saleItem.quantity);
      const itemSubtotal = parseFloat(saleItem.subtotal || 0) * ratio;
      const itemTax = parseFloat(saleItem.tax_amount || 0) * ratio;

      subtotal += itemSubtotal;
      tax += itemTax;

      return {
        sale_item_id: item.sale_item_id,
        product_id: saleItem.product_id,
        quantity: item.quantity,
        unit_price: saleItem.unit_price,
        unit_cost: resolveUnitCost(saleItem, saleItem.product),
        condition: item.condition || 'used',
        // 'none': línea libre, sin producto de catálogo que reingresar.
        destination: !saleItem.product_id ? 'none' : (item.condition === 'defective' ? 'quarantine' : 'inventory'),
        subtotal: itemSubtotal,
        tax: itemTax,
        total: itemSubtotal + itemTax
      };
    });

    // Factura AIU: A, I, U y el IVA (que va solo sobre la U) se devuelven en
    // proporción al costo directo devuelto -- mismo criterio que la nota
    // crédito (aiu.service.js#prorateAiu). Sin esto la devolución acreditaba
    // solo el costo directo y quedaba por debajo de lo facturado.
    if (sale.aiu_enabled) {
      const aiu = require('../../services/sales/aiu.service').prorateAiu(sale, subtotal);
      subtotal = aiu.subtotal;
      tax = aiu.tax;
    }

    // Neto de la parte del descuento global que le toca a lo devuelto
    // (services/sales/globalDiscount.service.js).
    const { discountShare, round2 } = require('../../services/sales/globalDiscount.service');
    const discount_amount = discountShare(sale, subtotal + tax);
    const total_amount = round2(subtotal + tax - discount_amount);

    // 4. Advisory lock + generar número de forma atómica
    //
    // PROBLEMA: En Vercel, múltiples Lambdas ejecutan simultáneamente. Sin bloqueo,
    // dos Lambdas pueden leer el mismo MAX y ambas intentar insertar DEV-2026-00001.
    //
    // SOLUCIÓN: pg_advisory_xact_lock serializa el acceso por tenant.
    // La segunda Lambda queda bloqueada aquí hasta que la primera haga COMMIT/ROLLBACK.
    // El lock se libera automáticamente al finalizar la transacción.
    //
    // El hash convierte el tenant_id (string) en un bigint para el lock.
    await sequelize.query(
      `SELECT pg_advisory_xact_lock(
         ('x' || substr(md5(:lock_key), 1, 16))::bit(64)::bigint
       )`,
      {
        replacements: { lock_key: `customer_return_${tenant_id}` },
        transaction
      }
    );

    // generateReturnNumber recibe la transacción para que el SELECT
    // se ejecute dentro del mismo contexto bloqueado y vea los datos correctos.
    const return_number = await generateReturnNumber(tenant_id, transaction);

    const customerReturn = await CustomerReturn.create({
      tenant_id,
      return_number,
      sale_id,
      customer_id: sale.customer_id,
      return_date: new Date(),
      reason,
      notes,
      subtotal,
      tax,
      discount_amount,
      total_amount,
      status: 'pending',
      created_by: req.user.id
    }, { transaction });

    // 5. Crear items
    for (const item of returnItems) {
      await CustomerReturnItem.create({
        return_id: customerReturn.id,
        ...item
      }, { transaction });
    }

    // 6. Obtener devolución completa
    const returnComplete = await CustomerReturn.findByPk(customerReturn.id, {
      include: [
        {
          model: CustomerReturnItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }]
        },
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'business_name', 'email']
        },
        {
          model: Sale,
          as: 'sale',
          attributes: ['id', 'sale_number']
        }
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
    console.error('Error en createCustomerReturn:', error);
    res.status(500).json({ success: false, message: 'Error al crear devolución' });
  }
};

/**
 * Aprobar devolución (genera movimientos y actualiza stock)
 */
const SETTLEMENT_TYPES = ['refund', 'credit'];
const badRequest = (message) => { const err = new Error(message); err.status = 400; return err; };

// Estados de venta sobre los que se puede devolver (mismo criterio que
// Cuentas por Cobrar: confirmada o entregada; facturas y remisiones).
const RETURNABLE_DOCUMENT_TYPES = ['factura', 'remision'];
const RETURNABLE_SALE_STATUSES = ['pending', 'completed'];

function saleReturnBlocker(sale) {
  if (!RETURNABLE_DOCUMENT_TYPES.includes(sale.document_type || 'remision')) {
    return 'Solo se pueden devolver facturas y remisiones.';
  }
  if (!RETURNABLE_SALE_STATUSES.includes(sale.status)) {
    return sale.status === 'draft'
      ? 'La venta está en borrador: edítala o cancélala en vez de devolverla.'
      : 'La venta está cancelada o anulada: no admite devoluciones.';
  }
  return null;
}

/**
 * Valida cantidades a devolver contra lo vendido menos lo ya devuelto.
 * - Agrupa líneas repetidas de la misma solicitud.
 * - `countPending`: al crear se cuentan también las devoluciones pendientes
 *   (para no abrir dos sobre las mismas unidades); al aprobar solo las
 *   aprobadas (una pendiente puede terminar rechazada). Las rechazadas nunca.
 * @returns {Map<sale_item_id, number>} cantidades agrupadas
 */
async function validateReturnQuantities(sale, requestedItems, { excludeReturnId = null, countPending = true, transaction } = {}) {
  const grouped = new Map();
  for (const item of requestedItems || []) {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty < 0) throw badRequest('Las cantidades a devolver deben ser números positivos.');
    if (qty === 0) continue;
    grouped.set(item.sale_item_id, Math.round(((grouped.get(item.sale_item_id) || 0) + qty) * 10000) / 10000);
  }
  if (grouped.size === 0) throw badRequest('Indica al menos un producto con cantidad mayor a cero.');

  const statuses = countPending ? ['pending', 'approved'] : ['approved'];
  const countedReturns = await CustomerReturn.findAll({
    where: {
      sale_id: sale.id,
      status: { [Op.in]: statuses },
      ...(excludeReturnId ? { id: { [Op.ne]: excludeReturnId } } : {}),
    },
    attributes: ['id'],
    transaction,
  });
  const countedReturnIds = countedReturns.map((r) => r.id);
  for (const [saleItemId, qty] of grouped) {
    const saleItem = (sale.items || []).find((si) => si.id === saleItemId);
    if (!saleItem) throw badRequest('Uno de los productos no pertenece a esta venta.');
    const alreadyReturned = Number(await CustomerReturnItem.sum('quantity', {
      where: { sale_item_id: saleItemId, return_id: { [Op.in]: countedReturnIds } },
      transaction,
    }) || 0);
    const remaining = Math.round((Number(saleItem.quantity) - alreadyReturned) * 10000) / 10000;
    if (qty > remaining + 0.00001) {
      const name = saleItem.product_name || 'el producto';
      throw badRequest(remaining > 0
        ? `De ${name} solo quedan ${remaining} unidades por devolver.`
        : `${name} ya fue devuelto en su totalidad.`);
    }
  }
  return grouped;
}

// GET /preview?sale_id=&amount=&exclude_return_id= -- cómo se liquidaría.
const getCustomerReturnSettlementPreview = async (req, res) => {
  try {
    const { sale_id, amount, exclude_return_id } = req.query;
    const value = Number(amount);
    if (!sale_id || !Number.isFinite(value) || value < 0) {
      return res.status(400).json({ success: false, message: 'sale_id y amount son obligatorios' });
    }
    const data = await previewCustomerReturnSettlement(sale_id, value, req.user.tenant_id, exclude_return_id || null);
    if (!data) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en getCustomerReturnSettlementPreview:', error);
    res.status(500).json({ success: false, message: 'Error calculando la liquidación' });
  }
};

// Retenciones ya reversadas por otras devoluciones aprobadas de la venta
// (para no reversar dos veces lo que el cliente retuvo).
async function priorRetentionReversal(saleId, excludeReturnId, tenantId, transaction) {
  const { addRetentions } = require('../../services/returns/returnSettlement');
  const previous = await CustomerReturn.findAll({
    where: { tenant_id: tenantId, sale_id: saleId, status: 'approved', ...(excludeReturnId ? { id: { [Op.ne]: excludeReturnId } } : {}) },
    attributes: ['retention_reversal'],
    transaction,
  });
  return addRetentions(previous.map((r) => r.retention_reversal || {}));
}

// Vista previa (sin bloquear ni escribir) de cómo se liquidaría una
// devolución de `amount` sobre la venta: lo usa el modal de aprobar/anular.
async function previewCustomerReturnSettlement(saleId, amount, tenantId, excludeReturnId = null) {
  const { customerReturnSettlement, sumRetentions } = require('../../services/returns/returnSettlement');
  const sale = await Sale.findOne({ where: { id: saleId, tenant_id: tenantId } });
  if (!sale) return null;
  const prior = await priorRetentionReversal(sale.id, excludeReturnId, tenantId);
  const calc = customerReturnSettlement(sale, amount, prior);
  return {
    reduction: calc.reduction,
    retention_reversal: calc.retention_reversal,
    retention_reversal_total: sumRetentions(calc.retention_reversal),
    money_back: calc.money_back,
    has_customer: !!sale.customer_id,
    needs_credit_note: await saleNeedsCreditNote(sale.id, tenantId),
  };
}

/**
 * Liquida una devolución al aprobarla (o al anular la venta, voidSale.js),
 * dentro de `transaction` y con la venta bloqueada:
 *  1. Lo devuelto baja primero el saldo de la venta (returned_amount).
 *  2. Del excedente, la parte que corresponde a retenciones que el cliente
 *     practicó se reversa (no es dinero que haya entrado a caja).
 *  3. El resto es dinero del cliente: 'refund' (sale de la caja abierta o de
 *     una cuenta bancaria) o 'credit' (saldo a favor = anticipo).
 * Devuelve los campos a guardar en la devolución; el asiento los usa tal cual.
 *
 * @param {object} settlementInput - { settlement_type, payment_method, bank_account_id }
 *   null/undefined = flujo de reversión de OT: el excedente se reintegra
 *   contablemente por el medio de la venta, sin caja (comportamiento previo).
 */
async function settleCustomerReturn(customerReturn, settlementInput, ctx, transaction) {
  const { customerReturnSettlement } = require('../../services/returns/returnSettlement');
  const tenantId = ctx.user.tenant_id;
  const sale = await Sale.findOne({
    where: { id: customerReturn.sale_id, tenant_id: tenantId },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!sale) throw badRequest('La venta de esta devolución no existe.');
  if (sale.is_consolidated_invoice || sale.invoiced_in_sale_id) {
    throw badRequest('Esta venta hace parte de una factura agrupada: no se puede devolver por separado.');
  }

  const prior = await priorRetentionReversal(sale.id, customerReturn.id, tenantId, transaction);
  const calc = customerReturnSettlement(sale, customerReturn.total_amount, prior);

  if (calc.reduction > 0) {
    sale.returned_amount = Math.round((Number(sale.returned_amount || 0) + calc.reduction) * 100) / 100;
    await sale.update({ returned_amount: sale.returned_amount, payment_status: salePaymentStatus(sale) }, { transaction });
  }

  const fields = {
    receivable_reduction: calc.reduction,
    retention_reversal: calc.retention_reversal,
    money_back_amount: calc.money_back,
  };
  if (calc.money_back <= 0 || settlementInput == null) return fields;

  const { settlement_type, payment_method, bank_account_id } = settlementInput;
  if (!SETTLEMENT_TYPES.includes(settlement_type)) {
    throw badRequest('Indica si el dinero ya pagado se le devuelve al cliente o queda como saldo a favor.');
  }

  if (settlement_type === 'credit') {
    if (!sale.customer_id) throw badRequest('La venta no tiene cliente: el saldo a favor necesita un cliente. Devuelve el dinero.');
    const { CustomerAdvance } = require('../../models');
    const { generateAdvanceNumber } = require('../../services/finance/advanceNumber.service');
    const advance = await CustomerAdvance.create({
      tenant_id: tenantId,
      branch_id: sale.branch_id || ctx.branch_id || null,
      customer_id: sale.customer_id,
      advance_number: await generateAdvanceNumber(tenantId, transaction),
      amount: calc.money_back,
      applied_amount: 0,
      refunded_amount: 0,
      balance: calc.money_back,
      method: null,
      received_date: new Date(),
      reference_note: `Saldo a favor por devolución ${customerReturn.return_number}`,
      triggers_iva: false,
      customer_return_id: customerReturn.id,
      status: 'active',
      created_by: ctx.user.id,
    }, { transaction });
    // Sin asiento propio: el de la devolución acredita este valor a
    // Anticipos de clientes en vez de Caja.
    return { ...fields, settlement_type, refund_amount: 0, credit_advance_id: advance.id };
  }

  let openSession = null;
  if (await isTreasuryEnabled(tenantId)) {
    openSession = await getOpenSession(tenantId, ctx.branch_id, transaction);
    if (!openSession) throw badRequest('No hay una caja abierta en esta sede. Abre la caja antes de devolver dinero.');
  }
  const method = payment_method || 'Efectivo';
  // Efectivo: que lo haya en la caja (según el cuadre de la sesión).
  await assertCashAvailable(openSession, calc.money_back, method);
  return {
    ...fields,
    settlement_type,
    refund_amount: calc.money_back,
    refund_method: method,
    refund_bank_account_id: await resolveSelectedBankAccountId(tenantId, bank_account_id, method, transaction),
    refund_cash_session_id: openSession?.id || null,
    refund_branch_id: ctx.branch_id || sale.branch_id || null,
    refund_date: new Date(),
  };
}

// Una devolución sobre una factura electrónica aceptada por la DIAN necesita
// nota crédito electrónica. Se emite al aprobar, por lo devuelto, SOLO como
// documento fiscal (skipAccounting): inventario, cartera y la reversión de
// ingreso/IVA ya los hace la devolución -- con el asiento de la nota se
// duplicaría la reversión.
async function saleNeedsCreditNote(saleId, tenantId) {
  const sale = await Sale.findOne({
    where: { id: saleId, tenant_id: tenantId },
    attributes: ['id', 'document_type', 'dian_status', 'cufe', 'is_consolidated_invoice'],
  });
  return !!sale && sale.document_type === 'factura' && sale.dian_status === 'accepted' && !!sale.cufe && !sale.is_consolidated_invoice;
}

async function issueReturnCreditNote(customerReturn, tenantId, userId) {
  if (customerReturn.credit_note_sale_id) return null;
  if (!(await saleNeedsCreditNote(customerReturn.sale_id, tenantId))) return null;
  const items = (customerReturn.items || [])
    .filter((i) => i.sale_item_id && Number(i.quantity) > 0)
    .map((i) => ({ sale_item_id: i.sale_item_id, quantity: Number(i.quantity) }));
  if (!items.length) throw badRequest('La devolución no tiene ítems ligados a la factura para la nota crédito.');
  const { createAndSendCreditNote } = require('../../services/sales/creditNote.service');
  const { noteSale } = await createAndSendCreditNote({
    tenantId,
    saleId: customerReturn.sale_id,
    items,
    reason: `Devolución ${customerReturn.return_number}: ${reasonLabel(CUSTOMER_RETURN_REASONS, customerReturn.reason)}`,
    userId,
    skipAccounting: true,
  });
  await CustomerReturn.update({ credit_note_sale_id: noteSale.id }, { where: { id: customerReturn.id, tenant_id: tenantId } });
  customerReturn.credit_note_sale_id = noteSale.id;
  return noteSale;
}

// POST /:id/credit-note -- reintenta la nota crédito si falló al aprobar.
const issueCustomerReturnCreditNote = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const customerReturn = await CustomerReturn.findOne({
      where: { id: req.params.id, tenant_id },
      include: [{ model: CustomerReturnItem, as: 'items' }],
    });
    if (!customerReturn) return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    if (customerReturn.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Solo las devoluciones aprobadas generan nota crédito' });
    }
    if (customerReturn.credit_note_sale_id) {
      return res.status(400).json({ success: false, message: 'Esta devolución ya tiene nota crédito' });
    }
    const note = await issueReturnCreditNote(customerReturn, tenant_id, req.user.id);
    if (!note) return res.status(400).json({ success: false, message: 'La venta no es una factura electrónica aceptada: no requiere nota crédito' });
    res.json({ success: true, message: 'Nota crédito creada. Envío a DIAN en proceso.', data: { credit_note_sale_id: note.id } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('Error en issueCustomerReturnCreditNote:', error);
    res.status(500).json({ success: false, message: 'Error al crear la nota crédito' });
  }
};

const approveCustomerReturn = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    // Bloqueo de la fila: dos aprobaciones simultáneas de la misma
    // devolución moverían inventario y cartera dos veces.
    const locked = await CustomerReturn.findOne({ where: { id, tenant_id }, lock: transaction.LOCK.UPDATE, transaction });
    if (!locked) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    const customerReturn = await CustomerReturn.findOne({
      where: { id, tenant_id },
      transaction,
      include: [
        {
          model: CustomerReturnItem,
          as: 'items',
          include: [
            { model: Product, as: 'product' },
            { model: SaleItem, as: 'saleItem', attributes: ['id', 'item_type'] },
          ]
        },
        {
          model: Sale,
          as: 'sale',
          attributes: ['id', 'sale_number', 'warehouse_id', 'branch_id', 'customer_id', 'payment_method', 'paid_amount', 'total_amount', 'is_consolidated_invoice', 'aiu_enabled']
        }
      ]
    });

    if (!customerReturn) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    if (customerReturn.status !== 'pending') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `La devolución ya fue ${customerReturn.status === 'approved' ? 'aprobada' : 'rechazada'}`
      });
    }

    // Revalidar contra el estado ACTUAL de la venta: pudo cancelarse, quedar
    // en envío a la DIAN u otra devolución de las mismas unidades pudo
    // aprobarse mientras esta esperaba.
    const saleForCheck = await Sale.findOne({
      where: { id: customerReturn.sale_id, tenant_id },
      include: [{ model: SaleItem, as: 'items' }],
      transaction,
    });
    const approveBlocker = !saleForCheck
      ? 'La venta de esta devolución ya no existe.'
      : saleReturnBlocker(saleForCheck)
        || (saleForCheck.dian_status === 'sending' ? 'La factura está en envío a la DIAN: espera la respuesta antes de aprobar la devolución.' : null);
    if (approveBlocker) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: approveBlocker });
    }
    await validateReturnQuantities(
      saleForCheck,
      customerReturn.items.map((i) => ({ sale_item_id: i.sale_item_id, quantity: i.quantity })),
      { excludeReturnId: customerReturn.id, countPending: false, transaction }
    );

    const { createMovement } = require('../inventory/movements.controller');

    // warehouse_id viene de la venta original
    const warehouse_id = customerReturn.sale ? customerReturn.sale.warehouse_id : null;

    for (const item of customerReturn.items) {
      const product = item.product;
      if (!product) continue;

      // Solo mover inventario si el producto lo trackea y el destino es inventario
      if (!product.track_inventory) continue;
      if (item.destination !== 'inventory') continue;

      await createMovement({
        tenant_id,
        movement_type: 'entrada',
        movement_reason: 'customer_return',
        product_id: item.product_id,
        warehouse_id: warehouse_id || null,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        reference_type: 'customer_return',
        reference_id: customerReturn.id,
        user_id: req.user.id,
        notes: `Devolución de cliente ${customerReturn.return_number} - ${reasonLabel(CUSTOMER_RETURN_REASONS, customerReturn.reason)}`
      }, transaction);

      const updatedProduct = await Product.findByPk(item.product_id, { transaction });
      if (updatedProduct) {
        await updatedProduct.update({
          available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
        }, { transaction });
      }
    }

    // Cartera: la parte de la devolución que el cliente aún no había pagado
    // deja de cobrarse (returned_amount). Mismo reparto pagado/pendiente que
    // generateCustomerReturnEntry, que acredita esa misma parte a
    // sale_receivable -- antes el asiento bajaba la cartera pero la venta
    // seguía mostrando el saldo completo en Cuentas por Cobrar.
    await require('../../services/accounting/journalEntry.service').assertPeriodOpen(tenant_id, new Date(), transaction);

    // Cartera, retenciones y dinero del cliente (ver settleCustomerReturn).
    const settlement = await settleCustomerReturn(customerReturn, req.body || {}, req, transaction);

    await customerReturn.update({
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date(),
      ...settlement
    }, { transaction });

    await transaction.commit();

    // Asiento contable en borrador (no bloqueante: si falla, solo se loguea).
    // Mismo patrón que sales.controller.js#update para generateSaleEntry.
    setImmediate(async () => {
      try {
        const { generateCustomerReturnEntry } = require('../../services/accounting/autoEntries.service');
        await generateCustomerReturnEntry(customerReturn, customerReturn.items, customerReturn.sale, tenant_id, req.user.id);
      } catch (err) {
        console.error(`[accounting] Error generando asiento de devolución de cliente ${customerReturn.id}:`, err.message);
      }
    });

    // FIX: era supplierReturn.items y tenantId (variables inexistentes)
    const product_ids = customerReturn.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenant_id);

    // Nota crédito electrónica (si la venta es una factura aceptada). Si
    // falla, la devolución queda aprobada y se reintenta desde el detalle.
    let creditNoteWarning = null;
    // Comisiones ya liquidadas sobre esta venta: el sistema no las reversa solo.
    const commissionWarning = (saleForCheck.product_settled_at || saleForCheck.labor_settled_at)
      ? 'Las comisiones de esta venta ya se liquidaron: si corresponde, descuenta lo devuelto en la próxima liquidación.'
      : null;
    try {
      await issueReturnCreditNote(customerReturn, tenant_id, req.user.id);
    } catch (err) {
      console.error(`[DIAN] No se pudo crear la nota crédito de la devolución ${customerReturn.id}:`, err.message);
      creditNoteWarning = `Devolución aprobada, pero no se pudo crear la nota crédito: ${err.message}. Reintenta desde el detalle de la devolución.`;
    }

    res.json({
      success: true,
      message: creditNoteWarning || (customerReturn.credit_note_sale_id
        ? 'Devolución aprobada. Nota crédito creada, envío a DIAN en proceso.'
        : 'Devolución aprobada exitosamente'),
      credit_note_warning: creditNoteWarning,
      commission_warning: commissionWarning,
      data: customerReturn
    });

  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    console.error('Error en approveCustomerReturn:', error);
    // Errores de negocio de createMovement (stock insuficiente, producto
    // inexistente): se devuelven tal cual para que el usuario sepa qué ajustar.
    if (error?.status === 400 || /Stock insuficiente|Producto no encontrado/i.test(error?.message || '')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: 'Error al aprobar devolución' });
  }
};

/**
 * Rechazar devolución
 */
const rejectCustomerReturn = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
    }

    const { id } = req.params;
    const { rejection_reason } = req.body;
    const tenant_id = req.user.tenant_id;

    const customerReturn = await CustomerReturn.findOne({ where: { id, tenant_id } });

    if (!customerReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }
    if (customerReturn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'La devolución ya fue procesada' });
    }

    await customerReturn.update({
      status: 'rejected',
      rejected_by: req.user.id,
      rejected_at: new Date(),
      rejection_reason
    });

    res.json({ success: true, message: 'Devolución rechazada', data: customerReturn });

  } catch (error) {
    console.error('Error en rejectCustomerReturn:', error);
    res.status(500).json({ success: false, message: 'Error al rechazar devolución' });
  }
};

/**
 * Eliminar devolución (solo si está en pending)
 */
const deleteCustomerReturn = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const customerReturn = await CustomerReturn.findOne({ where: { id, tenant_id } });

    if (!customerReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }
    if (customerReturn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Solo se pueden eliminar devoluciones pendientes' });
    }

    await customerReturn.destroy();

    res.json({ success: true, message: 'Devolución eliminada exitosamente' });

  } catch (error) {
    console.error('Error en deleteCustomerReturn:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar devolución' });
  }
};


// POST /:id/reverse -- reversa una devolución aprobada (services/returns/returnReversal.js).
const reverseCustomerReturn = async (req, res) => {
  try {
    const { reverseCustomerReturn: run } = require('../../services/returns/returnReversal');
    const result = await run({
      id: req.params.id,
      tenantId: req.user.tenant_id,
      userId: req.user.id,
      branchId: req.branch_id || null,
      body: req.body || {},
    });
    markProductsForAlertCheck(res, result.productIds, req.user.tenant_id);
    res.json({ success: true, message: 'Devolución reversada', data: result.customerReturn });
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
  getCustomerReturns,
  getCustomerReturnById,
  createCustomerReturn,
  approveCustomerReturn,
  reverseCustomerReturn,
  issueCustomerReturnCreditNote,
  rejectCustomerReturn,
  deleteCustomerReturn,
  getCustomerReturnSettlementPreview,
  // Usados por voidSale.js y por los tests.
  settleCustomerReturn,
  validateReturnQuantities,
  issueReturnCreditNote
};