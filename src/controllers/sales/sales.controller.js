const logger = require('../../config/logger');
// backend/src/controllers/sales/sales.controller.js
const { Sale, SaleItem, Customer, Product, Vehicle, Tenant, InventoryMovement, DianResolution, CustomerReturn, User, Branch, Warehouse, SaleDiagnosisMark, DiagramTemplate, CustomerInteraction } = require('../../models');
const audit = require('../../utils/audit');
const { sequelize } = require('../../config/database');
const { Op } = require('sequelize');
const { resolveSelectedBankAccountId } = require('../../services/accounting/bankAccountSelection');
const { generateSalePDF, generateSalePDFBuffer, generatePaymentReceiptPDF, generatePaymentReceiptPDFBuffer } = require('../../services/pdfService');
const whatsappService = require('../../services/whatsappService');
const { getCustomerWhatsappNumber } = require('../../utils/customerWhatsappPhone');
const { createMovement } = require('../inventory/movements.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const dianService = require('../../services/dian/dianService');
const taxService = require('../../services/taxService');
const aiuService = require('../../services/sales/aiu.service');
const { getOpenSession, isTreasuryEnabled } = require('../../services/finance/cashSession.service');
const { resolveBranchFilter } = require('../../utils/branchFilter');
const { buildStockWarnings } = require('../../services/inventory/stockInProcess.service');
const { resolveUnitCost } = require('../../utils/costResolver');
const { pickComboFields, presentComboLines, expandComboApprovals } = require('../../utils/comboLines');
const { applyRemisionFilter } = require('../../utils/remisionVisibility');
const { saleBalance, salePaymentStatus } = require('../../utils/saleAmounts');
const { daysOverdueOf, pendingReceivableWhere, draftSaleWhere, effectiveDueDateSql } = require('../../utils/receivables');
const { searchMatch } = require('../../utils/searchText');
const { createCustomerAdvanceRecord, afterAdvanceCommitted, splitExcess } = require('../../services/finance/customerAdvance.service');

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

// Una cotización no es venta: queda fuera de listados y totales de Ventas.
// document_type NULL (borrador de venta) se incluye explícito porque
// `<> 'cotizacion'` en SQL descarta los NULL.
const NOT_QUOTE_WHERE = { [Op.or]: [{ document_type: null }, { document_type: { [Op.ne]: 'cotizacion' } }] };

// Vigencia por defecto de una cotización (pdf_config.quote_validity_days del
// tenant, 15 días si no está configurada).
const DEFAULT_QUOTE_VALIDITY_DAYS = 15;
function defaultQuoteValidUntil(tenant, baseDate) {
  const days = parseInt(tenant?.pdf_config?.quote_validity_days) || DEFAULT_QUOTE_VALIDITY_DAYS;
  const d = baseDate ? new Date(baseDate) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Vencida = la fecha de vigencia ya pasó (se compara por día, en Colombia).
function isQuoteExpired(sale) {
  if (!sale.quote_valid_until) return false;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  return String(sale.quote_valid_until).slice(0, 10) < today;
}

// Desglose de impuestos solo sobre lo que el cliente aprobó: al rechazar
// ítems se recalculaban subtotal/IVA/total pero tax_breakdown quedaba con el
// valor original (PDF, link público y luego la remisión/factura mostraban el
// IVA de toda la cotización). Las retenciones se conservan; AIU no se toca
// (su IVA depende de la utilidad, no de las líneas).
function approvedTaxBreakdown(sale, billableItems) {
  if (sale.aiu_enabled) return sale.tax_breakdown;
  const taxes = taxService.taxLinesFromItems(billableItems);
  return [...taxes, ...(sale.tax_breakdown || []).filter(t => t.type !== 'tax')];
}

// Retenciones estimadas (las que el cliente practicará al pagar). Se
// calculan sobre la base y el IVA de las líneas; el descuento global, que se
// resta después de impuestos, reduce esa base y ese IVA en la misma
// proporción -- antes se ignoraba y la retención salía sobre el valor sin
// descuento.
const ZERO_RETENTIONS = { retefuente: { rate: 0, amount: 0 }, reteiva: { rate: 0, amount: 0 }, reteica: { rate: 0, amount: 0 }, total: 0 };
const scaleRetentions = taxService.scaleRetentions; // ver services/taxService.js
function retentionFields(ret) {
  return {
    retefuente_rate: ret.retefuente.rate, retefuente_amount: ret.retefuente.amount,
    reteiva_rate: ret.reteiva.rate, reteiva_amount: ret.reteiva.amount,
    reteica_rate: ret.reteica.rate, reteica_amount: ret.reteica.amount,
    total_retentions: ret.total,
  };
}
// Desglose guardado: impuestos de las líneas + líneas de retención.
function breakdownWithRetentions(taxItems, ret) {
  return [
    ...taxService.buildTaxBreakdown(taxItems, null),
    ...taxService.buildTaxBreakdown([], ret),
  ];
}

// Retenciones de una cotización tras la respuesta del cliente (sobre lo
// aprobado y con el descuento global vigente). Antes quedaban las de la
// cotización completa. AIU conserva las suyas (no admite descuento global y
// su base es propia).
async function quoteRetentionFields(sale, billable, totals, transaction) {
  if (sale.aiu_enabled || !sale.customer_id) return {};
  const [customer, tenant] = await Promise.all([
    Customer.findOne({ where: { id: sale.customer_id, tenant_id: sale.tenant_id }, attributes: ['retention_config', 'document_type'], transaction }),
    Tenant.findByPk(sale.tenant_id, { attributes: ['tax_config'], transaction }),
  ]);
  if (!customer) return {};
  const plain = billable.map(i => (i.toJSON ? i.toJSON() : i));
  const ret = scaleRetentions(
    taxService.calculateRetentions(plain, tenant?.tax_config || {}, taxService.customerRetentionConfig(customer)),
    totals.total_amount + totals.global_discount_amount, totals.global_discount_amount
  );
  return { ...retentionFields(ret), tax_breakdown: [...totals.tax_breakdown.filter(t => t.type === 'tax'), ...taxService.buildTaxBreakdown([], ret)] };
}

// Totales de una cotización sobre lo que el cliente aprobó (link público y
// "Registrar aprobación"). La base de cada línea se toma como total - IVA - INC
// (sirve también para líneas libres viejas, que guardaban el subtotal bruto);
// tax_amount del documento = IVA + INC, igual que en create(); y el descuento
// global se vuelve a aplicar (antes se perdía al aprobar).
function approvedQuoteTotals(sale, billable) {
  const net = (i) => parseFloat(i.total || 0) - parseFloat(i.tax_amount || 0) - parseFloat(i.inc_amount || 0);
  const preDiscountTotal = billable.reduce((s, i) => s + parseFloat(i.total || 0), 0);
  const global_discount_amount = resolveGlobalDiscount(sale.global_discount_type, sale.global_discount_value, preDiscountTotal);
  return {
    subtotal:        billable.reduce((s, i) => s + net(i), 0),
    discount_amount: billable.reduce((s, i) => s + parseFloat(i.discount_amount || 0), 0),
    tax_amount:      billable.reduce((s, i) => s + parseFloat(i.tax_amount || 0) + parseFloat(i.inc_amount || 0), 0),
    global_discount_amount,
    total_amount:    preDiscountTotal - global_discount_amount,
    tax_breakdown:   approvedTaxBreakdown(sale, billable),
  };
}

// Marca (channel_ref) de las interacciones que son recordatorios de pago
// enviados desde "Por cobrar" -- channel_ref guarda la referencia del canal
// de origen (p.ej. el leadgen_id de Meta).
const PAYMENT_REMINDER_REF = 'payment_reminder';

// Obtener todas las ventas
const getAll = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const { status, quote_status, customer_id, from_date, to_date, document_type, search, customer_name, vehicle_plate, dian_status, quote_view, payment_view, aging, limit = 50, offset = 0 } = req.query;
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

    // Cotizaciones y ventas son listados separados: una cotización
    // (document_type='cotizacion') no es venta hasta que el cliente la
    // aprueba y se convierte en remisión/factura. `quote_view` trae las
    // cotizaciones + las ya convertidas (quote_number, para ver su traza);
    // el listado de Ventas trae todo lo demás, incluidos los borradores de
    // venta (document_type=null, se tipan al confirmar).
    if (quote_view === 'true') {
      where[Op.and] = [
        ...(where[Op.and] || []),
        { [Op.or]: [{ document_type: 'cotizacion' }, { quote_number: { [Op.ne]: null } }] },
      ];
      if (status) where.status = status;
    } else {
      if (status) where.status = status;
      if (document_type) where.document_type = document_type;
      else where[Op.and] = [...(where[Op.and] || []), NOT_QUOTE_WHERE];
    }
    // En Cotizaciones, 'convertida' = ya pasó a remisión/factura; cualquier
    // otro estado se refiere a cotizaciones todavía sin convertir.
    if (quote_view === 'true' && quote_status === 'convertida') {
      where.quote_number = { [Op.ne]: null };
      where[Op.and].push(NOT_QUOTE_WHERE);
    } else if (quote_status) {
      where.quote_status = quote_status;
      if (quote_view === 'true') where.document_type = 'cotizacion';
    }
    if (customer_id) where.customer_id = customer_id;
    if (dian_status) where.dian_status = dian_status;
    // Remisiones ocultas a no-admin si el tenant lo configuró
    // (utils/remisionVisibility.js) -- va en Op.and para no chocar con el
    // Op.or de quote_view / search.
    // Facturas consolidadas sí se listan: son documentos (no se suman, ver getStats).
    applyRemisionFilter(req, where, { includeConsolidated: true });

    // "Por cobrar": mismos documentos que Cuentas por Cobrar (facturas y
    // remisiones confirmadas con saldo) más los borradores de venta, que
    // todavía no son cartera pero sí plata por recibir. `aging` acota a
    // vencidas / por vencer (solo confirmadas) o solo borradores. Va en
    // Op.and para combinarse con el filtro de tipo de documento sin pisarlo.
    const pendingView = payment_view === 'pending' && quote_view !== 'true';
    if (pendingView) {
      const dueVsToday = (op) => sequelize.where(sequelize.literal(effectiveDueDateSql()), op, sequelize.literal('CURRENT_DATE'));
      let pendingCondition;
      if (aging === 'overdue') pendingCondition = { [Op.and]: [pendingReceivableWhere(req), dueVsToday(Op.lt)] };
      else if (aging === 'upcoming') pendingCondition = { [Op.and]: [pendingReceivableWhere(req), dueVsToday(Op.gte)] };
      else if (aging === 'draft') pendingCondition = draftSaleWhere();
      else pendingCondition = { [Op.or]: [pendingReceivableWhere(req), draftSaleWhere()] };
      where[Op.and] = [...(where[Op.and] || []), pendingCondition];
    }

    if (customer_name) {
      where.customer_name = { [Op.iLike]: `%${customer_name}%` };
    }

    if (vehicle_plate) {
      where.vehicle_plate = { [Op.iLike]: `%${vehicle_plate}%` };
    }

    if (search && !customer_name && !vehicle_plate) {
      // Número, cliente, NIT, email, teléfono, placa y número DIAN en una
      // sola expresión indexada (ver utils/searchText.js).
      where[Op.and] = [...(where[Op.and] || []), searchMatch('sales', 'Sale', search)];
    }

    if (from_date && to_date) {
      where.sale_date = { [Op.between]: [from_date, to_date] };
    } else if (from_date) {
      where.sale_date = { [Op.gte]: from_date };
    } else if (to_date) {
      where.sale_date = { [Op.lte]: to_date };
    }

    const [sales, total] = await Promise.all([Sale.findAll({
      where,
      include: [
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'tax_id', 'email', 'phone', 'mobile', 'mobile_country_code']
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
      // Para cobrar, primero lo que vence antes (sin plazo = 30 días, igual
      // que daysOverdueOf); los borradores al final.
      order: pendingView
        ? [[sequelize.literal(`("Sale"."status" = 'draft')`), 'ASC'], [sequelize.literal(effectiveDueDateSql()), 'ASC'], ['created_at', 'ASC'], ['id', 'ASC']]
        : [['sale_date', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']],
      limit: safeLimit,
      offset: safeOffset,
    }), Sale.count({ where })]);

    // Saldo (neto de devoluciones) y días vencidos, para mostrar la cartera
    // directamente en el listado.
    const today = new Date();
    const data = sales.map((sale) => {
      const row = sale.toJSON();
      row.balance = saleBalance(row);
      const isReceivable = ['factura', 'remision'].includes(row.document_type)
        && ['pending', 'completed'].includes(row.status) && row.balance > 0;
      row.days_overdue = isReceivable ? daysOverdueOf(row, today) : null;
      return row;
    });

    // Recordatorios de pago enviados (POST /:id/payment-reminders), para no
    // insistirle dos veces el mismo día al mismo cliente.
    if (pendingView && data.length) {
      const reminders = await CustomerInteraction.findAll({
        where: { tenant_id: tenantId, related_sale_id: data.map(r => r.id), channel_ref: PAYMENT_REMINDER_REF },
        attributes: [
          'related_sale_id',
          [sequelize.fn('MAX', sequelize.col('created_at')), 'last_reminder_at'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'reminder_count'],
        ],
        group: ['related_sale_id'],
        raw: true,
      });
      const bySale = new Map(reminders.map(r => [r.related_sale_id, r]));
      data.forEach((row) => {
        const r = bySale.get(row.id);
        row.last_reminder_at = r?.last_reminder_at || null;
        row.reminder_count = parseInt(r?.reminder_count, 10) || 0;
      });
    }

    res.json({
      success: true,
      data,
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
        },
        // Facturación de remisiones (services/sales/remisionInvoicing.service.js)
        {
          model: Sale,
          as: 'invoiced_remisiones',
          attributes: ['id', 'sale_number', 'sale_date', 'total_amount', 'paid_amount', 'payment_status'],
          required: false,
        },
        {
          model: Sale,
          as: 'consolidated_invoice',
          attributes: ['id', 'sale_number', 'dian_status', 'status'],
          required: false,
        },
      ],
      order: [[{ model: Sale, as: 'invoiced_remisiones' }, 'sale_date', 'ASC']],
    });

    if (!sale) {
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }

    const saleData = sale.toJSON();
    saleData.created_by_name = saleData.creator
      ? [saleData.creator.first_name, saleData.creator.last_name].filter(Boolean).join(' ')
      : null;
    if (sale.document_type === 'remision') {
      const { getEligibility } = require('../../services/sales/remisionInvoicing.service');
      saleData.invoicing = await getEligibility(sale, tenantId);
    }

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
      quote_valid_until,
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
        customer_city_code: customer.city_code,
        customer_city_name: customer.city,
        customer_department_name: customer.state,
        customer_document_type: customer.document_type,
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
        customer_city_code: newCustomer.city_code,
        customer_city_name: newCustomer.city,
        customer_department_name: newCustomer.state,
        customer_document_type: newCustomer.document_type,
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

    // tax_config del tenant — se reusa para ICA por categoría (Fase D) y más
    // abajo para retenciones (Fase A/C), evita una segunda consulta.
    const tenantTaxConfigRow = await Tenant.findByPk(tenantId, { attributes: ['tax_config'], transaction });
    const tenantTaxConfig = tenantTaxConfigRow?.tax_config || {};

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
        // subtotal = base neta (después del descuento), igual que las líneas de
        // producto (taxService.base): la DIAN la usa como LineExtensionAmount y
        // contabilidad como ingreso. Antes iba el valor bruto.
        subtotal += ftb; discount_amount += fd; tax_amount += ftax;
        saleItems.push({
          tenant_id: tenantId, item_type: 'free_line', product_id: null,
          product_name: item.product_name, product_sku: null,
          quantity: item.quantity, unit_price: item.unit_price,
          discount_percentage: item.discount_percentage || 0, discount_amount: fd,
          tax_percentage: ftaxpct, tax_amount: ftax, iva_status: ftaxpct > 0 ? 'gravado' : null,
          subtotal: ftb, total: ftotal, unit_cost: 0,
          technician_id: item.technician_id || null,
          ...pickComboFields(item),
        });
        continue;
      }

      const product = productMap[item.product_id];
      if (!product) {
        await transaction.rollback();
        return res.status(404).json({ success: false, message: `Producto ${item.product_id} no encontrado` });
      }

      // Usar taxService para calcular todos los impuestos
      const taxes = taxService.calculateItemTaxes(item, product, 'sale', tenantTaxConfig);

      subtotal += taxes.base; discount_amount += taxes.discount; tax_amount += taxes.total_taxes;
      saleItems.push({
        tenant_id: tenantId,
        item_type: product.product_type === 'service' ? 'service' : 'product',
        product_id: product.id,
        product_name: product.name,
        product_sku: product.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percentage: item.discount_percentage || 0,
        discount_amount: taxes.discount,
        tax_percentage: taxes.iva.rate,
        tax_amount: taxes.iva.amount,
        iva_status: taxes.iva.status,
        inc_rate: taxes.inc.rate,
        inc_amount: taxes.inc.amount,
        ica_rate: taxes.ica.rate,
        ica_amount: taxes.ica.amount,
        subtotal: taxes.base,
        total: taxes.total_line,
        unit_cost: product.product_type === 'service' ? 0 : (product.average_cost || 0),
        technician_id: item.technician_id || null,
        ...pickComboFields(item),
      });
    }

    // Factura AIU: IVA solo sobre la Utilidad (ver services/sales/aiu.service.js).
    let aiu = null;
    let aiuResult = null;
    try {
      aiu = aiuService.resolveAiu(req.body, tenantTaxConfig);
    } catch (aiuErr) {
      await transaction.rollback();
      return res.status(aiuErr.statusCode || 400).json({ success: false, message: aiuErr.message });
    }
    if (aiu) {
      if ((parseFloat(global_discount_value) || 0) > 0) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'Una factura AIU no admite descuento global: aplique los descuentos por línea' });
      }
      aiuResult = aiuService.applyAiu(saleItems, aiu);
      subtotal = aiuResult.subtotal;
      tax_amount = aiuResult.iva;
    }

    const preDiscountTotal = aiuResult ? aiuResult.total : saleItems.reduce((sum, i) => sum + i.total, 0);
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
    let retentions = ZERO_RETENTIONS;
    if (finalCustomerId) {
      const customer = await Customer.findByPk(finalCustomerId, { transaction });
      if (customer) {
        retentions = aiuResult
          ? taxService.calculateRetentions(aiuService.aiuTaxLines(aiuResult, aiu), tenantTaxConfig, taxService.customerRetentionConfig(customer), 'sale', aiuService.aiuRetentionBases(aiuResult, aiu))
          : taxService.calculateRetentions(saleItems, tenantTaxConfig, taxService.customerRetentionConfig(customer));
        retentions = scaleRetentions(retentions, preDiscountTotal, global_discount_amount);
      }
    }

    const tax_breakdown = taxService.buildTaxBreakdown(aiuResult ? [...saleItems, ...aiuService.aiuTaxLines(aiuResult, aiu)] : saleItems, retentions);

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
      ...(aiuResult ? aiuResult.fields : {}),
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

    // Cotización: nace con su propio tipo y consecutivo COT- (no es un
    // borrador de venta) -- el resto de documentos se tipan al confirmar.
    if (document_type === 'cotizacion') {
      saleData.document_type = 'cotizacion';
      saleData.sale_number = await generateSaleNumber(tenantId, 'cotizacion', transaction);
      saleData.quote_status = 'borrador';
      saleData.quote_valid_until = quote_valid_until || defaultQuoteValidUntil(
        await Tenant.findByPk(tenantId, { attributes: ['pdf_config'] }), saleData.sale_date
      );
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
        iva_status: item.iva_status || null,
        inc_rate: item.inc_rate,
        inc_amount: item.inc_amount,
        ica_rate: item.ica_rate,
        ica_amount: item.ica_amount,
        subtotal: item.subtotal,
        total: item.total,
        unit_cost: item.unit_cost,
        notes: null,
        technician_id: item.technician_id || null,
        ...pickComboFields(item),
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

    // ── Advertencia (NO bloqueante) de "cantidad en trámite" ──────────────
    // La venta recién creada queda en 'draft' con document_type null (se
    // asigna al confirmar), así que ya cuenta como "en trámite" para sí
    // misma -- se excluye con excludeSaleId. No bloquea la respuesta 201.
    let stockWarnings = [];
    try {
      const warningRequests = saleItems
        .filter(i => i.item_type === 'product' && i.product_id)
        .map(i => ({
          product_id: i.product_id,
          product_name: i.product_name,
          quantity: i.quantity,
          current_stock: parseFloat(productMap[i.product_id]?.current_stock || 0),
          track_inventory: productMap[i.product_id]?.track_inventory,
        }));
      stockWarnings = await buildStockWarnings(tenantId, warningRequests, { excludeSaleId: sale.id });
    } catch (warnError) {
      logger.warn('No se pudo calcular advertencia de cantidad en trámite:', warnError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Venta creada exitosamente',
      data: completeSale,
      ...(stockWarnings.length > 0 ? { warnings: stockWarnings } : {}),
    });

  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
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
    // Los campos aiu_* los calcula el servidor (más abajo), no se copian tal cual.
    for (const key of Object.keys(rest)) if (key.startsWith('aiu_')) delete rest[key];
    if (Object.keys(req.body).some((k) => k.startsWith('aiu_')) && !(Array.isArray(items) && items.length > 0)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Para cambiar la configuración AIU envíe también los ítems de la venta' });
    }
    const updateData = { ...rest };
    // Numeración y ciclo de la cotización los maneja el servidor; una
    // cotización no pasa a borrador de venta (ni al revés) editándola: se
    // convierte al confirmarla, ya aprobada.
    for (const key of ['sale_number', 'quote_number', 'quote_status', 'quote_approved_by_name', 'quote_approved_by_document', 'quote_approved_ip', 'quote_responded_at', 'share_token']) {
      delete updateData[key];
    }
    if ('document_type' in updateData
      && (sale.document_type === 'cotizacion' || updateData.document_type === 'cotizacion')
      && updateData.document_type !== sale.document_type) {
      delete updateData.document_type;
    }
    if ('quote_valid_until' in updateData && sale.document_type !== 'cotizacion') delete updateData.quote_valid_until;
    if (updateData.quote_valid_until === '') updateData.quote_valid_until = null;

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
        updateData.customer_city_code        = customer.city_code;
        updateData.customer_city_name        = customer.city;
        updateData.customer_department_name  = customer.state;
        updateData.customer_document_type    = customer.document_type;
      }
    }

    let lineItemsTotal; // total pre-descuento-global -- solo se resuelve si cambian ítems o el descuento
    let pendingRetentions = null; // retenciones recalculadas con ítems nuevos (antes del descuento global)
    let retentionTaxItems = null;
    let stockWarnings = [];

    if (items && Array.isArray(items) && items.length > 0) {
      await SaleItem.destroy({ where: { sale_id: id }, transaction });

      // Ítems nuevos = la respuesta del cliente ya no aplica: si la
      // cotización ya se había enviado, vuelve a quedar pendiente de aprobar.
      if (sale.document_type === 'cotizacion' && sale.quote_status && sale.quote_status !== 'borrador') {
        Object.assign(updateData, {
          quote_status: 'enviada',
          quote_approved_by_name: null,
          quote_approved_by_document: null,
          quote_approved_ip: null,
          quote_responded_at: null,
        });
      }

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

      // tax_config del tenant — para resolver ICA por categoría (Fase D)
      const tenantTaxConfigRow = await Tenant.findByPk(tenantId, { attributes: ['tax_config'], transaction });
      const tenantTaxConfig = tenantTaxConfigRow?.tax_config || {};

      for (const item of items) {
        const itemType = item.item_type || 'product';

        if (itemType === 'free_line') {
          const fs  = item.quantity * item.unit_price;
          const fd  = fs * (item.discount_percentage || 0) / 100;
          const ftb = fs - fd;
          let ftax = 0, ftaxpct = 0, ftotal = ftb;
          if (item.tax_percentage > 0) { ftaxpct = item.tax_percentage; ftax = ftb * ftaxpct / 100; ftotal = ftb + ftax; }
          subtotal += ftb; discount_amount += fd; tax_amount += ftax; // base neta, ver create()
          newItems.push({
            sale_id: id, tenant_id: tenantId, item_type: 'free_line',
            product_id: null, product_name: item.product_name, product_sku: null,
            quantity: item.quantity, unit_price: item.unit_price,
            discount_percentage: item.discount_percentage || 0, discount_amount: fd,
            tax_percentage: ftaxpct, tax_amount: ftax, iva_status: ftaxpct > 0 ? 'gravado' : null, subtotal: ftb, total: ftotal, unit_cost: 0,
            technician_id: item.technician_id || null,
            ...pickComboFields(item),
          });
          continue;
        }

        const product = productMap[item.product_id];
        if (!product) {
          await transaction.rollback();
          return res.status(404).json({ success: false, message: `Producto ${item.product_id} no encontrado` });
        }

        const taxes = taxService.calculateItemTaxes(item, product, 'sale', tenantTaxConfig);

        subtotal += taxes.base; discount_amount += taxes.discount; tax_amount += taxes.total_taxes;
        newItems.push({
          sale_id: id, tenant_id: tenantId,
          item_type: product.product_type === 'service' ? 'service' : 'product',
          product_id: product.id, product_name: product.name, product_sku: product.sku,
          quantity: item.quantity, unit_price: item.unit_price,
          discount_percentage: item.discount_percentage || 0, discount_amount: taxes.discount,
          tax_percentage: taxes.iva.rate, tax_amount: taxes.iva.amount, iva_status: taxes.iva.status,
          inc_rate: taxes.inc.rate, inc_amount: taxes.inc.amount,
          ica_rate: taxes.ica.rate, ica_amount: taxes.ica.amount,
          subtotal: taxes.base, total: taxes.total_line,
          unit_cost: product.product_type === 'service' ? 0 : (product.average_cost || 0),
          technician_id: item.technician_id || null,
          ...pickComboFields(item),
        });
      }

      // Factura AIU (ver services/sales/aiu.service.js)
      let aiu = null;
      try {
        aiu = aiuService.resolveAiu(req.body, tenantTaxConfig, sale);
      } catch (aiuErr) {
        await transaction.rollback();
        return res.status(aiuErr.statusCode || 400).json({ success: false, message: aiuErr.message });
      }
      let aiuResult = null;
      if (aiu) {
        const effDiscount = updateData.global_discount_value !== undefined ? updateData.global_discount_value : sale.global_discount_value;
        if ((parseFloat(effDiscount) || 0) > 0) {
          await transaction.rollback();
          return res.status(400).json({ success: false, message: 'Una factura AIU no admite descuento global: aplique los descuentos por línea' });
        }
        aiuResult = aiuService.applyAiu(newItems, aiu);
        subtotal = aiuResult.subtotal;
        tax_amount = aiuResult.iva;
      }

      await SaleItem.bulkCreate(newItems, { transaction });

      lineItemsTotal = aiuResult ? aiuResult.total : newItems.reduce((sum, i) => sum + i.total, 0);
      updateData.subtotal        = subtotal;
      updateData.tax_amount      = tax_amount;
      updateData.discount_amount = discount_amount;
      Object.assign(updateData, aiuResult ? aiuResult.fields : (sale.aiu_enabled ? aiuService.AIU_OFF_FIELDS : {}));

      // Retenciones y desglose de impuestos se recalculan con los ítems
      // nuevos (antes quedaban con los valores de la creación).
      const effCustomerId = 'customer_id' in updateData ? updateData.customer_id : sale.customer_id;
      let retentions = ZERO_RETENTIONS;
      if (effCustomerId) {
        const retCustomer = await Customer.findOne({ where: { id: effCustomerId, tenant_id: tenantId }, attributes: ['retention_config', 'document_type'], transaction });
        if (retCustomer) {
          retentions = aiuResult
            ? taxService.calculateRetentions(aiuService.aiuTaxLines(aiuResult, aiu), tenantTaxConfig, taxService.customerRetentionConfig(retCustomer), 'sale', aiuService.aiuRetentionBases(aiuResult, aiu))
            : taxService.calculateRetentions(newItems, tenantTaxConfig, taxService.customerRetentionConfig(retCustomer));
        }
      }
      // Se guardan después de resolver el descuento global (más abajo).
      pendingRetentions = retentions;
      retentionTaxItems = aiuResult ? [...newItems, ...aiuService.aiuTaxLines(aiuResult, aiu)] : newItems;

      // Advertencia (NO bloqueante) de "cantidad en trámite" — excluye esta
      // misma venta (excludeSaleId) para que sus propios ítems recién
      // reemplazados no se cuenten a sí mismos.
      try {
        const warningRequests = newItems
          .filter(i => i.item_type === 'product' && i.product_id)
          .map(i => ({
            product_id: i.product_id,
            product_name: i.product_name,
            quantity: i.quantity,
            current_stock: parseFloat(productMap[i.product_id]?.current_stock || 0),
            track_inventory: productMap[i.product_id]?.track_inventory,
          }));
        stockWarnings = await buildStockWarnings(tenantId, warningRequests, { excludeSaleId: id });
      } catch (warnError) {
        logger.warn('No se pudo calcular advertencia de cantidad en trámite:', warnError.message);
      }
    } else if (discountFieldsChanged && sale.aiu_enabled && (parseFloat(updateData.global_discount_value) || 0) > 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Una factura AIU no admite descuento global: aplique los descuentos por línea' });
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

    // Retenciones: con ítems nuevos, con otro descuento global o con otro
    // cliente cambian -- antes solo se recalculaban cuando cambiaban los ítems.
    const customerChanged = 'customer_id' in updateData && updateData.customer_id !== sale.customer_id;
    if (pendingRetentions || ((discountFieldsChanged || customerChanged) && !sale.aiu_enabled)) {
      let ret = pendingRetentions;
      let taxItems = retentionTaxItems;
      if (!ret) {
        taxItems = (await SaleItem.findAll({ where: { sale_id: id }, transaction }))
          .map(i => i.toJSON()).filter(i => i.approval_status !== 'rechazado');
        ret = ZERO_RETENTIONS;
        const effCustomerId = 'customer_id' in updateData ? updateData.customer_id : sale.customer_id;
        if (effCustomerId) {
          const [retCustomer, tenantRow] = await Promise.all([
            Customer.findOne({ where: { id: effCustomerId, tenant_id: tenantId }, attributes: ['retention_config', 'document_type'], transaction }),
            Tenant.findByPk(tenantId, { attributes: ['tax_config'], transaction }),
          ]);
          if (retCustomer) ret = taxService.calculateRetentions(taxItems, tenantRow?.tax_config || {}, taxService.customerRetentionConfig(retCustomer));
        }
      }
      const pre = lineItemsTotal !== undefined ? lineItemsTotal : parseFloat(sale.total_amount) + (parseFloat(sale.global_discount_amount) || 0);
      const gd = updateData.global_discount_amount !== undefined ? updateData.global_discount_amount : sale.global_discount_amount;
      ret = scaleRetentions(ret, pre, gd);
      Object.assign(updateData, retentionFields(ret), { tax_breakdown: breakdownWithRetentions(taxItems, ret) });
    }

    await sale.update(updateData, { transaction });
    await transaction.commit();

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    res.json({
      success: true,
      message: 'Venta actualizada exitosamente',
      data: updatedSale,
      ...(stockWarnings.length > 0 ? { warnings: stockWarnings } : {}),
    });

  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
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
    const { payment_method, paid_amount, document_type, bank_account_id, payment_splits, credit_days, advance_amount, excess_advance_amount } = req.body;

    if (!payment_method) {
      return res.status(400).json({ success: false, message: 'Debe especificar el método de pago' });
    }

    // Cuenta bancaria que recibió el pago (transferencia, tarjeta...): viaja
    // en el pago inicial de payment_history y el asiento la usa. En un pago
    // mixto, cada medio trae la suya y queda como un pago aparte (antes el
    // desglose se ignoraba y todo el valor iba a Bancos, efectivo incluido).
    let selectedBankAccountId;
    let splits = null;
    try {
      if (payment_method === 'mixed') {
        if (!Array.isArray(payment_splits) || payment_splits.length === 0) {
          return res.status(400).json({ success: false, message: 'El pago mixto requiere el desglose por medio de pago' });
        }
        splits = [];
        for (const sp of payment_splits) {
          const splitAmount = Math.round(parseFloat(sp?.amount) * 100) / 100;
          if (!sp?.method || sp.method === 'mixed' || !(splitAmount > 0)) {
            return res.status(400).json({ success: false, message: 'Cada medio del pago mixto necesita un método y un monto mayor a 0' });
          }
          splits.push({
            method: sp.method,
            amount: splitAmount,
            bank_account_id: await resolveSelectedBankAccountId(tenantId, sp.bank_account_id, sp.method),
          });
        }
      } else {
        selectedBankAccountId = await resolveSelectedBankAccountId(tenantId, bank_account_id, payment_method);
      }
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
      throw err;
    }

    // Excedente que el cliente deja como anticipo (pagó más que el total):
    // en pago mixto se descuenta de los últimos medios; en pago simple usa el
    // mismo medio y cuenta bancaria del pago.
    const excessAdvanceAmount = Math.round((parseFloat(excess_advance_amount) || 0) * 100) / 100;
    let excessAdvanceParts = [];
    if (excessAdvanceAmount > 0) {
      if (document_type === 'cotizacion') {
        return res.status(400).json({ success: false, message: 'Una cotización no recibe pagos: no se puede crear un anticipo' });
      }
      if (splits) {
        const result = splitExcess(splits, excessAdvanceAmount);
        if (result.unassigned > 0.01) {
          return res.status(400).json({ success: false, message: 'El excedente a dejar como anticipo supera lo recibido en el pago mixto' });
        }
        splits = result.splits;
        excessAdvanceParts = result.advanceParts;
        if (!splits.length) {
          return res.status(400).json({ success: false, message: 'El pago mixto no cubre nada de la venta después de separar el anticipo' });
        }
      } else {
        excessAdvanceParts = [{ method: payment_method, amount: excessAdvanceAmount, bank_account_id: selectedBankAccountId }];
      }
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
    const finalDocType = document_type || (sale.document_type !== null && sale.document_type !== 'cotizacion' ? sale.document_type : 'remision');

    // Confirmar = volverlo venta (mueve inventario, caja, contabilidad). Una
    // cotización nunca se "confirma como cotización"; se convierte en
    // remisión/factura solo cuando el cliente la aprobó (link público o
    // aprobación registrada en Pitbox).
    if (finalDocType === 'cotizacion') {
      return res.status(400).json({ success: false, message: 'Una cotización no se confirma como venta. Compártela con el cliente y, cuando la apruebe, conviértela en remisión o factura.' });
    }
    if (sale.document_type === 'cotizacion' && !['aprobada', 'parcial'].includes(sale.quote_status)) {
      return res.status(409).json({ success: false, message: 'La cotización debe estar aprobada por el cliente antes de convertirla en venta.' });
    }

    // Requisitos de factura electrónica (compartidos con la facturación de
    // remisiones, ver services/sales/remisionInvoicing.service.js):
    // - productos tipo 'vehicle' con su ficha completa para tránsito -- es
    //   mejor bloquear ahora que descubrirlo ya emitida;
    // - cliente con ciudad DIVIPOLA y tipo de identificación, validado contra
    //   el registro vivo del Customer (no lo cacheado en la Sale) -- sin
    //   esto dianKitAdapter caía al fallback de Bogotá/Cundinamarca. El
    //   Customer validado se reutiliza abajo para refrescar el snapshot
    //   denormalizado de la Sale con el que realmente se factura.
    let freshCustomerForDian = null;
    if (finalDocType === 'factura') {
      const invoicing = require('../../services/sales/remisionInvoicing.service');
      const vehicleError = await invoicing.checkVehicleData(sale.items, tenantId);
      if (vehicleError) return res.status(400).json({ success: false, message: vehicleError });
      try {
        freshCustomerForDian = await invoicing.loadDianReadyCustomer(sale.customer_id, tenantId);
      } catch (err) {
        if (err.status !== 422) throw err;
        return res.status(422).json({ success: false, message: err.message, ...err.extra });
      }
    }

    // Validar límite de crédito (VEN-2). Antes solo corría con
    // payment_method === 'credito', valor que la UI nunca envía: el crédito
    // es "lo que queda sin pagar al confirmar", con cualquier medio. Cliente
    // sin cupo (credit_limit vacío o 0) = crédito sin tope.
    if (sale.customer_id && finalDocType !== 'cotizacion') {
      const settledNow = (splits
        ? splits.reduce((sum, sp) => sum + sp.amount, 0)
        : (paid_amount !== undefined ? parseFloat(paid_amount) || 0 : parseFloat(sale.total_amount)))
        + (parseFloat(advance_amount) || 0);
      const unpaid = Math.round((parseFloat(sale.total_amount) - settledNow) * 100) / 100;
      const creditCustomer = unpaid > 0.01
        ? await Customer.findOne({ where: { id: sale.customer_id, tenant_id: tenantId } })
        : null;
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
            [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('paid_amount')), 0), 'total_paid'],
            [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('returned_amount')), 0), 'total_returned']
          ],
          raw: true
        });
        const currentDebt = Math.max(
          parseFloat(pendingResult?.total_pending || 0)
            - parseFloat(pendingResult?.total_paid || 0)
            - parseFloat(pendingResult?.total_returned || 0),
          0
        );
        const newDebt = currentDebt + unpaid;
        const limit = parseFloat(creditCustomer.credit_limit);
        if (newDebt > limit) {
          const name = creditCustomer.business_name || `${creditCustomer.first_name} ${creditCustomer.last_name}`;
          return res.status(400).json({
            success: false,
            message: `Límite de crédito excedido para ${name}. Cupo: $${limit.toLocaleString('es-CO')}, Deuda actual: $${currentDebt.toLocaleString('es-CO')}, Saldo de esta venta: $${unpaid.toLocaleString('es-CO')}`,
            credit_limit: limit, current_debt: currentDebt, sale_unpaid: unpaid
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
            // El costo se recalcula AQUÍ, al confirmar -- no se reusa el
            // snapshot congelado en item.unit_cost desde que se creó el
            // borrador/cotización (resolveUnitCost() sin pasarle item.unit_cost),
            // porque el promedio ponderado pudo cambiar entre tanto (compras,
            // otras ventas). Se persiste en el SaleItem para que el kardex, el
            // asiento contable y una eventual devolución vean el mismo valor.
            const effectiveCost = resolveUnitCost({ unit_price: item.unit_price }, product);
            if (parseFloat(item.unit_cost || 0) !== effectiveCost) {
              await item.update({ unit_cost: effectiveCost }, { transaction });
            }
            await createMovement({
              tenant_id: tenantId, movement_type: 'salida', movement_reason: 'sale',
              reference_type: 'sale', reference_id: sale.id, product_id: item.product_id,
              warehouse_id: sale.warehouse_id || null, quantity: item.quantity,
              unit_cost: effectiveCost, user_id: userId,
              movement_date: sale.sale_date ? new Date(sale.sale_date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
              notes: `Venta ${sale.sale_number} - ${item.product_name}`
            }, transaction);
          }
        }
      }

      const amountPaid = splits
        ? Math.round(splits.reduce((sum, sp) => sum + sp.amount, 0) * 100) / 100
        : (paid_amount !== undefined ? parseFloat(paid_amount) : parseFloat(sale.total_amount));
      if (splits && amountPaid > parseFloat(sale.total_amount) + 1) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'El pago mixto suma más que el total de la venta' });
      }
      const updateData = { status: 'completed', payment_method, paid_amount: amountPaid };

      if (amountPaid >= parseFloat(sale.total_amount)) updateData.payment_status = 'paid';
      else if (amountPaid > 0) updateData.payment_status = 'partial';
      else updateData.payment_status = 'pending';

      // Contado / crédito (+ plazo y vencimiento) -- queda fijo en la venta
      // y de ahí sale el PaymentMeans del XML DIAN y la elegibilidad RADIAN
      // (services/sales/paymentTerms.service.js). advance_amount: anticipos
      // que el modal aplica justo después de confirmar -- cuentan como pago
      // para decidir la forma, aunque el abono llegue en otra llamada.
      if (finalDocType !== 'cotizacion') {
        const { resolvePaymentTerms } = require('../../services/sales/paymentTerms.service');
        Object.assign(updateData, resolvePaymentTerms({
          total: parseFloat(sale.total_amount),
          settled: amountPaid + (parseFloat(advance_amount) || 0),
          baseDate: sale.sale_date || new Date(),
          creditDays: credit_days,
          dueDate: sale.due_date,
          paymentTerms: sale.payment_terms,
        }));
      }

      // Registrar el pago inicial en payment_history para que Flujo de Caja
      // (que solo lee payment_history) refleje el ingreso, igual que registerPayment.
      let initialPayments = [];
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

        // in_sale_entry: se contabiliza dentro del asiento de la venta, una
        // línea por pago (ver salePaymentsForEntry en autoEntries.service.js).
        const parts = splits || [{ method: payment_method, amount: amountPaid, bank_account_id: selectedBankAccountId }];
        initialPayments = parts.map((part) => ({
          payment_id: require('crypto').randomUUID(),
          date: sale.sale_date || new Date(),
          amount: part.amount,
          method: part.method,
          bank_account_id: part.bank_account_id || null,
          in_sale_entry: true,
          user_id: userId,
          notes: 'Pago registrado al confirmar la venta',
          cash_session_id: openSession?.id || null,
          branch_id: req.branch_id,
        }));
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
        // Traza de la cotización de origen (sigue visible en Cotizaciones).
        if (sale.document_type === 'cotizacion') updateData.quote_number = sale.sale_number;
      } else if (document_type) {
        updateData.dian_status = document_type === 'factura' ? 'pending' : 'not_applicable';

      }

      // Refrescar el snapshot denormalizado del cliente con el que se va a
      // facturar -- freshCustomerForDian ya se cargó (y validó) arriba, antes
      // de la transacción. Evita facturar con un customer_city_code/
      // document_type cacheado en la Sale desde antes de que el cliente se
      // completara.
      if (finalDocType === 'factura' && freshCustomerForDian) {
        const { customerSnapshot } = require('../../services/sales/remisionInvoicing.service');
        Object.assign(updateData, customerSnapshot(freshCustomerForDian));
      }

      // El recibo se numera al final, ya con el sale_number definitivo
      // (la renumeración de arriba puede cambiarlo respecto al de la Sale
      // recién creada), y viaja en el mismo payment_history entry.
      if (initialPayments.length > 0) {
        const { generateReceiptNumber } = require('../../services/finance/receiptNumber.service');
        const { Receipt } = require('../../models');
        for (const initialPayment of initialPayments) {
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
        }

        updateData.payment_history = [...(sale.payment_history || []), ...initialPayments];
      }

      // Excedente del pago → anticipo(s) del cliente, en la misma transacción
      const excessAdvances = [];
      if (excessAdvanceParts.length > 0) {
        if (!sale.customer_id) {
          await transaction.rollback();
          return res.status(400).json({ success: false, message: 'La venta no tiene cliente: no se puede dejar el excedente como anticipo' });
        }
        if (!openSession && await isTreasuryEnabled(tenantId)) {
          openSession = await getOpenSession(tenantId, req.branch_id, transaction);
          if (!openSession) {
            await transaction.rollback();
            return res.status(400).json({ success: false, message: 'No hay una caja abierta en esta sede. Abre la caja antes de registrar anticipos.' });
          }
        }
        for (const part of excessAdvanceParts) {
          excessAdvances.push(await createCustomerAdvanceRecord({
            tenantId,
            branchId: req.branch_id,
            userId,
            customerId: sale.customer_id,
            amount: part.amount,
            method: part.method,
            bankAccountId: part.bank_account_id,
            receivedDate: sale.sale_date || new Date(),
            referenceNote: `Excedente del pago de ${updateData.sale_number || sale.sale_number}`,
            cashSessionId: openSession?.id || null,
          }, transaction));
        }
      }

      const wasQuote = sale.document_type === 'cotizacion';
      await sale.update(updateData, { transaction });
      await transaction.commit();
      if (excessAdvances.length) afterAdvanceCommitted(excessAdvances, tenantId, userId);

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
      if (!transaction.finished) await transaction.rollback();
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
    const { lifecycleBlocker } = require('../../services/sales/remisionInvoicing.service');
    const invoicingBlocker = lifecycleBlocker(sale);
    if (invoicingBlocker) return res.status(400).json({ success: false, message: invoicingBlocker });

    const transaction = await sequelize.transaction();
    try {
      if (sale.status === 'completed') {
        for (const item of sale.items) {
          // Ítem rechazado en cotización parcial: confirm() nunca sacó su
          // stock (ver mismo filtro ahí), así que reingresarlo aquí infla
          // el inventario con algo que nunca salió.
          if (item.approval_status === 'rechazado') continue;
          if (item.product_id) {
            const product = await Product.findOne({ where: { id: item.product_id, tenant_id: tenantId }, transaction });
            if (product && product.track_inventory) {
              await createMovement({
                tenant_id: tenantId, movement_type: 'entrada', movement_reason: 'sale_reversal',
                reference_type: 'sale', reference_id: sale.id, product_id: item.product_id,
                warehouse_id: sale.warehouse_id || null, quantity: item.quantity,
                // Reversa el mismo costo que se reconoció al confirmar (item.unit_cost
                // ya quedó actualizado ahí, ver confirm()), no uno recalculado.
                unit_cost: resolveUnitCost(item, product), user_id: userId,
                notes: `Reversión venta ${sale.sale_number} cancelada - ${item.product_name}`
              }, transaction);
            }
          }
        }
      }

      await sale.update({ status: 'cancelled', internal_notes: reason || 'Venta cancelada' }, { transaction });
      await transaction.commit();
    } catch (err) {
      if (!transaction.finished) await transaction.rollback();
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
                  const newBalance = parseFloat(advance.amount) - newAppliedAmount - parseFloat(advance.refunded_amount) - parseFloat(advance.reassigned_amount || 0);
                  await advance.update({
                    applied_amount: newAppliedAmount,
                    balance: newBalance,
                    // Solo reactiva si no estaba anulado/devuelto por fuera de esta aplicación.
                    status: ['fully_applied', 'reassigned'].includes(advance.status) ? 'active' : advance.status,
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

// Registrar retenciones que practicó el cliente (ReteFuente / ReteIVA /
// ReteICA): cuentan como abono a la venta (bajan el saldo pendiente) pero no
// mueven caja -- sin recibo ni caja abierta. Ver
// autoEntries.service.js#generateSaleRetentionEntry.
const registerRetentions = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const userId = req.user.id;
    const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;
    const retentions = {
      retefuente: round2(req.body.retefuente),
      reteiva: round2(req.body.reteiva),
      reteica: round2(req.body.reteica),
    };
    if (Object.values(retentions).some((v) => v < 0)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Las retenciones no pueden ser negativas' });
    }
    const amount = round2(retentions.retefuente + retentions.reteiva + retentions.reteica);
    if (amount <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Indique al menos una retención' });
    }

    const sale = await Sale.findOne({ where: { id, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }
    if (sale.status === 'draft' || sale.status === 'cancelled') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Solo se registran retenciones en ventas confirmadas' });
    }
    if (!sale.customer_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La venta no tiene cliente: no hay quién practique la retención' });
    }
    // Factura consolidada (services/sales/remisionInvoicing.service.js): el
    // cliente retiene sobre el total de la factura, pero la cartera vive en
    // sus remisiones -- cada retención se reparte en proporción al saldo
    // pendiente de cada una (un registro y un asiento por remisión).
    const invoicing = require('../../services/sales/remisionInvoicing.service');
    const targets = sale.is_consolidated_invoice
      ? await invoicing.lockPendingRemisiones(sale.id, tenantId, transaction)
      : [sale];
    const pendingOf = (t) => saleBalance(t);
    const totalPending = round2(targets.reduce((sum, t) => sum + pendingOf(t), 0));
    if (amount > totalPending + 0.01) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `Las retenciones (${amount}) superan el saldo pendiente de la venta (${totalPending})` });
    }
    const shares = invoicing.splitProportionally(retentions, targets.map(pendingOf));

    const effectiveDate = req.body.date || new Date();
    const applied = [];
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const share = shares[i];
      const shareAmount = round2(share.retefuente + share.reteiva + share.reteica);
      if (shareAmount <= 0) continue;
      const paid_amount = round2(parseFloat(target.paid_amount || 0) + shareAmount);
      const payment_status = salePaymentStatus(target, paid_amount);
      const payment_id = require('crypto').randomUUID();
      const payment_history = [...(target.payment_history || []), {
        payment_id,
        date: effectiveDate,
        amount: shareAmount,
        method: 'Retención',
        // source 'retention': no es dinero que entre a caja (cashflow lo excluye).
        source: 'retention',
        retentions: share,
        user_id: userId,
        notes: req.body.notes || (target.id !== sale.id ? `Retención sobre la factura ${sale.sale_number}` : null),
        branch_id: req.branch_id,
      }];
      await target.update({ paid_amount, payment_status, payment_history }, { transaction });
      applied.push({ target, payment_id, share, paid_amount, payment_status });
    }

    const consolidatedId = sale.is_consolidated_invoice ? sale.id : sale.invoiced_in_sale_id;
    if (consolidatedId) await invoicing.syncConsolidatedInvoice(consolidatedId, transaction);
    await transaction.commit();

    setImmediate(async () => {
      const { generateSaleRetentionEntry } = require('../../services/accounting/autoEntries.service');
      for (const { target, payment_id, share } of applied) {
        try {
          await generateSaleRetentionEntry({ payment_id, date: effectiveDate, retentions: share }, target, tenantId, userId);
        } catch (err) {
          logger.warn(`[accounting] Error generando asiento de retenciones (venta ${target.id}): ${err.message}`);
        }
      }
    });

    const refreshed = await Sale.findByPk(id, { attributes: ['paid_amount', 'payment_status'] });
    res.json({
      success: true,
      message: applied.length > 1 ? `Retenciones registradas, repartidas entre ${applied.length} remisiones` : 'Retenciones registradas',
      data: { paid_amount: refreshed.paid_amount, payment_status: refreshed.payment_status, payment_ids: applied.map((a) => a.payment_id) },
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    logger.error('Error registrando retenciones:', error);
    res.status(500).json({ success: false, message: 'Error registrando retenciones' });
  }
};

// Registrar pago
const registerPayment = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenantId = req.tenant_id;
    const userId = req.user.id;
    const { amount, payment_method, payment_date, notes, bank_account_id, excess_to_advance } = req.body;

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

    // Factura consolidada (services/sales/remisionInvoicing.service.js): la
    // cartera vive en sus remisiones, así que el pago se reparte entre las
    // que tienen saldo, la más antigua primero -- un recibo y un asiento por
    // remisión. La factura solo refleja el total (syncConsolidatedInvoice).
    const invoicing = require('../../services/sales/remisionInvoicing.service');
    const targets = sale.is_consolidated_invoice
      ? await invoicing.lockPendingRemisiones(sale.id, tenantId, transaction)
      : [sale];
    const remaining = targets.reduce((sum, t) => sum + saleBalance(t), 0);

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

    const effectiveMethod = payment_method || sale.payment_method || 'Efectivo';
    const effectiveDate = payment_date || new Date();
    const selectedBankAccountId = await resolveSelectedBankAccountId(tenantId, bank_account_id, effectiveMethod, transaction);
    const { generateReceiptNumber } = require('../../services/finance/receiptNumber.service');
    const { Receipt } = require('../../models');

    // Limitar el monto al saldo pendiente para evitar sobrepagos. Si el
    // cliente pagó de más y pidió dejar el excedente a favor, ese excedente
    // se registra como anticipo con el mismo medio de pago y cuenta bancaria.
    const excess = Math.round((parseFloat(amount) - remaining) * 100) / 100;
    let excessAdvance = null;
    if (excess_to_advance && excess >= 0.01) {
      if (!sale.customer_id) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'La venta no tiene cliente: no se puede dejar el excedente como anticipo' });
      }
      excessAdvance = await createCustomerAdvanceRecord({
        tenantId,
        branchId: req.branch_id,
        userId,
        customerId: sale.customer_id,
        amount: excess,
        method: effectiveMethod,
        bankAccountId: selectedBankAccountId,
        receivedDate: effectiveDate,
        referenceNote: `Excedente del pago de ${sale.sale_number}${notes ? ` — ${notes}` : ''}`,
        cashSessionId: openSession?.id || null,
      }, transaction);
    }
    let toApply = Math.min(parseFloat(amount), remaining);
    const appliedPayments = [];
    for (const target of targets) {
      if (toApply <= 0) break;
      const alreadyPaid = parseFloat(target.paid_amount || 0);
      const effectiveAmount = Math.round(Math.min(toApply, saleBalance(target)) * 100) / 100;
      if (effectiveAmount <= 0) continue;
      toApply = Math.round((toApply - effectiveAmount) * 100) / 100;
      // Redondeo a centavos: la suma en flotante puede quedar en .829999… y
      // la venta seguiría "parcial" estando pagada.
      const paid_amount = Math.round((alreadyPaid + effectiveAmount) * 100) / 100;

      const payment_status = salePaymentStatus(target, paid_amount);

      const payment_id = require('crypto').randomUUID();
      const payment_history = [...(target.payment_history || [])];
      const receipt_number = await generateReceiptNumber(tenantId, transaction);
      await Receipt.create({
        tenant_id: tenantId,
        branch_id: req.branch_id,
        receipt_number,
        source_type: 'sale',
        source_id: target.id,
        payment_id,
        cash_session_id: openSession?.id || null,
        amount: effectiveAmount,
        method: effectiveMethod,
        payment_date: effectiveDate,
        reference: target.id === sale.id ? sale.sale_number : `${target.sale_number} (factura ${sale.sale_number})`,
        customer_name: target.customer_name,
        created_by: userId,
      }, { transaction });

      payment_history.push({
        payment_id,
        date: effectiveDate,
        amount: effectiveAmount,
        method: effectiveMethod,
        bank_account_id: selectedBankAccountId,
        user_id: userId,
        notes: notes || null,
        cash_session_id: openSession?.id || null,
        branch_id: req.branch_id,
        receipt_number,
      });

      await target.update(
        { paid_amount, payment_status, payment_method: payment_method || target.payment_method, payment_history },
        { transaction }
      );
      appliedPayments.push({ target, payment_id, effectiveAmount });
    }

    const consolidatedId = sale.is_consolidated_invoice ? sale.id : sale.invoiced_in_sale_id;
    if (consolidatedId) await invoicing.syncConsolidatedInvoice(consolidatedId, transaction);

    await transaction.commit();

    // Asiento contable del abono (caja/bancos vs cartera), no bloqueante —
    // mismo patrón fire-and-forget que el asiento de la venta en confirm().
    setImmediate(async () => {
      for (const { target, payment_id, effectiveAmount } of appliedPayments) {
        try {
          const { generatePaymentEntry } = require('../../services/accounting/autoEntries.service');
          await generatePaymentEntry(
            { payment_id, amount: effectiveAmount, method: effectiveMethod, date: effectiveDate, bank_account_id: selectedBankAccountId },
            target,
            tenantId,
            userId
          );
        } catch (err) {
          logger.warn(`[accounting] Error generando asiento de abono (venta ${target.id}): ${err.message}`);
        }
      }
    });

    if (excessAdvance) afterAdvanceCommitted(excessAdvance, tenantId, userId);

    const updatedSale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }]
    });

    res.json({
      success: true,
      message: excessAdvance
        ? `Pago registrado. Excedente de $${Number(excessAdvance.amount).toLocaleString('es-CO')} guardado como anticipo ${excessAdvance.advance_number}`
        : 'Pago registrado exitosamente',
      data: updatedSale,
      advance: excessAdvance,
    });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    if (error.status === 400) return res.status(400).json({ success: false, message: error.message });
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
    // Ni los borradores ni las cotizaciones son ventas confirmadas — no
    // deben sumar en los totales de Ventas.
    const where = { tenant_id: tenantId, status: { [Op.ne]: 'draft' }, [Op.and]: [NOT_QUOTE_WHERE] };
    const branch_id = resolveBranchFilter(req);
    if (branch_id) where.branch_id = branch_id;
    if (from_date && to_date) where.sale_date = { [Op.between]: [from_date, to_date] };
    else if (from_date) where.sale_date = { [Op.gte]: from_date };
    else if (to_date) where.sale_date = { [Op.lte]: to_date };
    applyRemisionFilter(req, where); // mismas ventas que getAll, sin facturas consolidadas (su ingreso está en las remisiones)

    const stats = await Sale.findAll({
      where,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_sales'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_amount'],
      ],
      raw: true
    });

    // Por cobrar = saldo real (total - pagado - devuelto) de los mismos
    // documentos que Cuentas por Cobrar. Antes sumaba el total de las ventas
    // 'pending' e ignoraba los pagos parciales.
    const pendingWhere = { tenant_id: tenantId, ...pendingReceivableWhere(req) };
    if (branch_id) pendingWhere.branch_id = branch_id;
    if (where.sale_date) pendingWhere.sale_date = where.sale_date;
    const balanceSql = 'GREATEST(total_amount - COALESCE(returned_amount, 0) - COALESCE(paid_amount, 0), 0)';
    const [pending] = await Sale.findAll({
      where: pendingWhere,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'pending_count'],
        [sequelize.fn('SUM', sequelize.literal(balanceSql)), 'pending_amount'],
        [sequelize.fn('SUM', sequelize.literal(`CASE WHEN ${effectiveDueDateSql()} < CURRENT_DATE THEN ${balanceSql} ELSE 0 END`)), 'overdue_amount'],
        [sequelize.fn('SUM', sequelize.literal(`CASE WHEN ${effectiveDueDateSql()} < CURRENT_DATE THEN 1 ELSE 0 END`)), 'overdue_count'],
      ],
      raw: true
    });

    // Borradores de venta: plata por recibir que aún no es cartera (se
    // muestran aparte en "Por cobrar", ver getAll).
    const draftWhere = { tenant_id: tenantId, ...draftSaleWhere() };
    if (branch_id) draftWhere.branch_id = branch_id;
    if (where.sale_date) draftWhere.sale_date = where.sale_date;
    const [drafts] = await Sale.findAll({
      where: draftWhere,
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'draft_count'],
        [sequelize.fn('SUM', sequelize.col('total_amount')), 'draft_amount'],
      ],
      raw: true
    });

    res.json({
      success: true,
      data: {
        total_sales:    parseInt(stats[0].total_sales)    || 0,
        total_amount:   parseFloat(stats[0].total_amount) || 0,
        pending_amount: parseFloat(pending.pending_amount) || 0,
        pending_count:  parseInt(pending.pending_count)    || 0,
        overdue_amount: parseFloat(pending.overdue_amount) || 0,
        overdue_count:  parseInt(pending.overdue_count)    || 0,
        draft_count:    parseInt(drafts.draft_count)       || 0,
        draft_amount:   parseFloat(drafts.draft_amount)    || 0,
        sales_count:    parseInt(stats[0].total_sales)    || 0
      }
    });
  } catch (error) {
    logger.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo estadísticas' });
  }
};

// Recordatorio de pago enviado por WhatsApp desde "Por cobrar". Se registra
// como interacción del cliente (la ve el CRM en la vista 360°) aunque el
// tenant no tenga el módulo CRM. Solo se sabe que se abrió el enlace wa.me,
// no si se entregó: outcome 'sin_respuesta'.
const registerPaymentReminder = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const sale = await Sale.findOne({
      where: { id: req.params.id, tenant_id: tenantId },
      attributes: ['id', 'customer_id', 'sale_number', 'branch_id', 'total_amount', 'paid_amount', 'returned_amount'],
    });
    if (!sale) return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    if (!sale.customer_id) {
      return res.status(400).json({ success: false, message: 'La venta no tiene cliente registrado: el recordatorio no queda en su historial' });
    }

    const message = String(req.body?.message || '').trim();
    const summary = `Recordatorio de pago por WhatsApp (${sale.sale_number}, saldo ${saleBalance(sale).toLocaleString('es-CO')})`
      + (message ? `: "${message.length > 300 ? `${message.slice(0, 300)}…` : message}"` : '');
    const interaction = await CustomerInteraction.create({
      tenant_id: tenantId,
      branch_id: sale.branch_id || req.branch_id || null,
      customer_id: sale.customer_id,
      user_id: req.user.id,
      type: 'whatsapp',
      summary,
      outcome: 'sin_respuesta',
      channel_ref: PAYMENT_REMINDER_REF,
      related_sale_id: sale.id,
    });
    // underscored: el atributo es createdAt (la columna, created_at).
    await Customer.update({ last_interaction_at: interaction.createdAt }, { where: { id: sale.customer_id, tenant_id: tenantId } });

    res.status(201).json({ success: true, data: { id: interaction.id, created_at: interaction.createdAt } });
  } catch (error) {
    logger.error('Error registrando recordatorio de pago:', error);
    res.status(500).json({ success: false, message: 'Error registrando el recordatorio' });
  }
};

// Link público que ve el cliente (QuotePublicPage). /public/quote/:token
// sigue resolviendo en el frontend para los enlaces ya enviados.
function publicDocumentUrl(frontendUrl, isQuote, token) {
  return `${frontendUrl}/${isQuote ? 'cotizacion' : 'documento'}/${token}`;
}

// PDF de una venta: la cotización tiene su propio formato
// (services/sales/quotePdfService.js), el resto usa el de venta.
function buildSalePdfBuffer(sale, tenant) {
  if (sale.document_type === 'cotizacion') {
    const { generateQuotePDFBuffer } = require('../../services/sales/quotePdfService');
    return generateQuotePDFBuffer(sale, tenant);
  }
  return generateSalePDFBuffer(sale, tenant);
}

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
    const pdfBuffer = await buildSalePdfBuffer(sale, tenant);
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
// El provisional de una factura es prefijo + current_number de la
// resolución, que solo avanza al ENVIAR a la DIAN: si otra factura todavía
// no se ha enviado, ya tiene ese mismo número y el índice único
// (tenant_id, sale_number) revienta la confirmación. Se toma el siguiente libre.
async function nextFreeSaleNumber(tenant_id, prefix, startNumber, transaction, excludeId = null) {
  let n = startNumber;
  const taken = (number) => Sale.count({
    where: { tenant_id, sale_number: number, ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}) },
    transaction,
  });
  while (await taken(`${prefix || ''}${n}`)) n += 1;
  return `${prefix || ''}${n}`;
}

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
    // Una remisión convertida a factura guarda su REM-XXXX en
    // remision_number (y una cotización convertida en venta, su COT-XXXX en
    // quote_number): ese número ya se usó y no se puede volver a emitir.
    const convertedColumn = prefix === 'REM' ? 'remision_number' : 'quote_number';
    const lastConverted = await Sale.findOne({
      where: { tenant_id, [convertedColumn]: { [Op.like]: `${prefix}-${year}-%` } },
      order: [[convertedColumn, 'DESC']],
      transaction,
    });
    if (lastConverted) {
      sequence = Math.max(sequence, parseInt(lastConverted[convertedColumn].split('-').pop()) + 1);
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
    return nextFreeSaleNumber(tenant_id, resolution.prefix, Number(resolution.current_number), transaction, excludeId);
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
    // Solo una cotización tiene flujo de aprobación -- un borrador de venta
    // (document_type null) se comparte como documento, no como cotización.
    const isQuote = sale.document_type === 'cotizacion';
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
    // página pública (QuotePublicPage) es genérica por document_type, pero
    // la URL distingue la cotización (/cotizacion) del resto (/documento).
    const documentUrl = publicDocumentUrl(frontendUrl, isQuote, token);

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

    const customerPhone = getCustomerWhatsappNumber(sale.customer) || sale.customer_phone;
    if (!customerPhone) {
      return res.status(400).json({ success: false, message: 'El cliente no tiene número de teléfono registrado.' });
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const TYPES = { factura: 'Factura', remision: 'Remisión', cotizacion: 'Cotización' };
    const docLabel = TYPES[sale.document_type] || 'Cotización';
    // Mismo criterio que generateShareLink.
    const isQuote = sale.document_type === 'cotizacion';

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
    const documentUrl = publicDocumentUrl(frontendUrl, isQuote, token);

    let caption;
    if (isQuote) {
      caption = `Hola! Aquí tienes tu ${docLabel} *${sale.sale_number}* de *${tenant.company_name}*.\nTotal: *$${Number(sale.total_amount).toLocaleString('es-CO')}*\n\n📄 Revisa y aprueba tu cotización aquí:\n${documentUrl}\n\nCualquier duda estamos a tu servicio. 😊`;
    } else {
      caption = `Hola! Aquí tienes tu ${docLabel} *${sale.sale_number}* de *${tenant.company_name}*.\nTotal: *$${Number(sale.total_amount).toLocaleString('es-CO')}*\n\n📄 Consulta tu documento aquí:\n${documentUrl}\n\nCualquier duda estamos a tu servicio. 😊`;
    }

    // Preferir Cloud API si el tenant tiene WhatsApp conectado; si no, wa.me
    try {
      const waCloud = require('../../services/whatsappCloud.service');
      const status = await waCloud.getWhatsAppStatus(tenantId);
      if (status.operational) {
        const sent = await waCloud.sendTextFromTenant({
          tenantId,
          to: customerPhone,
          body: caption,
          userId: req.user?.id || null,
          source: 'api',
        });
        return res.json({
          success: true,
          channel: 'cloud_api',
          pdfUrl,
          conversation_id: sent.conversation_id,
          message: `Documento enviado por WhatsApp Cloud API a ${customerPhone}.`,
        });
      }
    } catch (cloudErr) {
      logger.warn('WhatsApp Cloud fallback a wa.me:', cloudErr.message);
    }

    const result = await whatsappService.sendText(customerPhone, caption);

    res.json({
      success: true,
      channel: 'wa_me',
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

// Ítems que ve el cliente en el link público. Un combo "solo nombre y total"
// se muestra (y se aprueba/rechaza) como una sola línea -- ver
// presentComboLines / expandComboApprovals en utils/comboLines.js.
function publicQuoteItems(items) {
  return presentComboLines(items, i => ({
    id: i.id,
    product_name: i.product?.name || i.product_name || i.description,
    image_url: i.product?.image_url || null,
    quantity: i.quantity,
    unit_price: i.unit_price,
    subtotal: i.subtotal,
    discount_percentage: i.discount_percentage,
    discount_amount: i.discount_amount,
    tax_percentage: i.tax_percentage,
    tax_amount: i.tax_amount,
    iva_status: i.iva_status,
    inc_rate: i.inc_rate,
    inc_amount: i.inc_amount,
    total: i.total,
    approval_status: i.approval_status,
  }));
}

async function getPublicSaleBody(saleId, res) {
  const sale = await Sale.findOne({
    where: { id: saleId },
    include: [{ model: SaleItem, as: 'items', include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku', 'image_url'] }] }],
  });
  if (!sale) return res.status(404).json({ success: false, message: 'Documento no encontrado' });

  const tenant = await Tenant.findByPk(sale.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

  const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');

  // Una cotización enviada cuya vigencia ya pasó se marca vencida al
  // consultarla (no hay job que lo haga): el cliente ya no puede aprobarla.
  if (sale.document_type === 'cotizacion' && sale.quote_status === 'enviada' && isQuoteExpired(sale)) {
    await sale.update({ quote_status: 'vencida' });
  }

  res.json({
    success: true,
    data: {
      sale_number: sale.sale_number,
      document_type: sale.document_type,
      status: sale.status,
      quote_status: sale.quote_status,
      quote_valid_until: sale.quote_valid_until,
      pdf_url: `${backendUrl}/api/public/pdf/${sale.share_token}`,
      customer_name: sale.customer_name,
      customer_tax_id: sale.customer_tax_id,
      sale_date: sale.sale_date,
      vehicle_plate: sale.vehicle_plate,
      vehicle_brand: sale.vehicle_brand,
      vehicle_model: sale.vehicle_model,
      vehicle_year: sale.vehicle_year,
      subtotal: sale.subtotal,
      tax_amount: sale.tax_amount,
      // Desde las líneas (misma fuente que el total); AIU conserva el suyo.
      tax_breakdown: sale.aiu_enabled
        ? (sale.tax_breakdown || []).filter(t => t.type === 'tax')
        : taxService.taxLinesFromItems(sale.items || []),
      discount_amount: sale.discount_amount,
      global_discount_amount: sale.global_discount_amount,
      total_amount: sale.total_amount,
      notes: sale.notes,
      items: publicQuoteItems(sale.items || []),
      quote_approved_by_name: sale.quote_approved_by_name,
      quote_responded_at: sale.quote_responded_at,
      tenant: {
        company_name: tenant.company_name,
        tax_id: tenant.tax_id,
        logo_url: tenant.logo_url,
        primary_color: tenant.primary_color,
        phone: tenant.phone,
        email: tenant.email,
        address: tenant.address,
        quote_terms: tenant.pdf_config?.quote_terms || null,
      },
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
    if (isQuoteExpired(sale)) {
      await sale.update({ quote_status: 'vencida' }, { transaction });
      await transaction.commit();
      return res.status(409).json({ success: false, message: 'Esta cotización ya venció. Comunícate con nosotros para actualizarla.' });
    }

    // Un combo aprobado/rechazado como una sola línea aplica a todos sus componentes.
    const expandedApprovals = expandComboApprovals(approvals, sale.items);
    const itemIds = new Set(sale.items.map(i => i.id));
    const validApprovals = expandedApprovals.filter(a => itemIds.has(a.item_id));
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
    const totals = approvedQuoteTotals(sale, billable);
    Object.assign(totals, await quoteRetentionFields(sale, billable, totals, transaction));

    const anyApproved = refreshedItems.some(i => i.approval_status === 'aprobado');
    const anyRejected = refreshedItems.some(i => i.approval_status === 'rechazado');
    const quote_status = anyApproved && anyRejected ? 'parcial' : anyApproved ? 'aprobada' : 'rechazada';

    await sale.update({
      quote_status,
      ...totals,
      quote_approved_by_name: approved_by_name,
      quote_approved_by_document: approved_by_document,
      quote_approved_ip: req.ip,
      quote_responded_at: new Date(),
    }, { transaction });

    await transaction.commit();
    res.json({ success: true, message: 'Respuesta registrada correctamente' });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    logger.error('[Cotización pública] Error en respondPublicQuoteBody:', error);
    res.status(500).json({ success: false, message: 'Error al procesar la respuesta' });
  }
}

// POST /sales/:id/quote-status { status: 'aprobada' | 'rechazada', approved_by_name?, approved_by_document? }
// El asesor registra la respuesta que el cliente dio fuera del link público.
// Aprobar así aprueba todos los ítems que sigan pendientes (los que el
// cliente ya rechazó por el link se respetan).
const setQuoteStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, approved_by_name, approved_by_document } = req.body;
    if (!['aprobada', 'rechazada'].includes(status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "status debe ser 'aprobada' o 'rechazada'" });
    }
    const sale = await Sale.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
      include: [{ model: SaleItem, as: 'items' }],
      transaction,
    });
    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cotización no encontrada' });
    }
    if (sale.document_type !== 'cotizacion' || sale.status !== 'draft') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Solo se puede responder una cotización vigente' });
    }

    const user = req.user || {};
    const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Asesor';
    const updateData = {
      quote_approved_by_name: approved_by_name?.trim() || `${sale.customer_name || 'Cliente'} (registrada por ${userName})`,
      quote_approved_by_document: approved_by_document?.trim() || sale.customer_tax_id || null,
      quote_approved_ip: req.ip,
      quote_responded_at: new Date(),
    };

    if (status === 'aprobada') {
      await SaleItem.update(
        { approval_status: 'aprobado' },
        { where: { sale_id: sale.id, approval_status: { [Op.ne]: 'rechazado' } }, transaction }
      );
      const items = await SaleItem.findAll({ where: { sale_id: sale.id }, transaction });
      const billable = items.filter(i => i.approval_status === 'aprobado');
      if (!billable.length) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'Todos los ítems fueron rechazados: no hay nada que aprobar' });
      }
      const anyRejected = items.some(i => i.approval_status === 'rechazado');
      updateData.quote_status = anyRejected ? 'parcial' : 'aprobada';
      // Mismo recálculo que respondPublicQuoteBody: lo rechazado no se cobra.
      if (anyRejected) {
        const totals = approvedQuoteTotals(sale, billable);
        Object.assign(updateData, totals, await quoteRetentionFields(sale, billable, totals, transaction));
      }
    } else {
      updateData.quote_status = 'rechazada';
    }

    await sale.update(updateData, { transaction });
    await transaction.commit();
    await audit({
      tenant_id: req.tenant_id, user_id: req.user?.id, action: 'SET_QUOTE_STATUS',
      entity: 'sale', entity_id: sale.id, changes: { quote_status: updateData.quote_status }, req,
    });
    res.json({ success: true, message: updateData.quote_status === 'rechazada' ? 'Cotización marcada como rechazada' : 'Cotización aprobada', data: { quote_status: updateData.quote_status } });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    logger.error('Error registrando respuesta de cotización:', error);
    res.status(500).json({ success: false, message: 'Error registrando la respuesta de la cotización' });
  }
};

// ── Facturación de remisiones (services/sales/remisionInvoicing.service.js) ──
function invoicingErrorResponse(res, error, fallbackMessage) {
  if (error.status) {
    return res.status(error.status).json({ success: false, message: error.message, ...(error.extra || {}) });
  }
  logger.error(fallbackMessage, error);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

// POST /sales/:id/convert-to-invoice -- la misma remisión pasa a factura
const convertToInvoice = async (req, res) => {
  try {
    const userId = req.user_id || req.user?.id;
    const { convertRemisionToInvoice } = require('../../services/sales/remisionInvoicing.service');
    const result = await convertRemisionToInvoice({ saleId: req.params.id, tenantId: req.tenant_id, userId });
    await audit({
      tenant_id: req.tenant_id, user_id: userId, action: 'CONVERT_REMISION_TO_INVOICE',
      entity: 'sale', entity_id: result.sale_id, changes: result, req,
    });
    const updatedSale = await Sale.findByPk(result.sale_id, {
      include: [{ model: SaleItem, as: 'items' }, { model: Customer, as: 'customer' }],
    });
    res.json({ success: true, message: `Remisión ${result.remision_number} convertida en la factura ${result.sale_number}. Se está enviando a la DIAN.`, data: updatedSale });
  } catch (error) {
    invoicingErrorResponse(res, error, 'Error convirtiendo la remisión a factura');
  }
};

// POST /sales/consolidate-invoice { sale_ids, notes } -- varias remisiones → una factura
const consolidateInvoice = async (req, res) => {
  try {
    const userId = req.user_id || req.user?.id;
    const { consolidateRemisiones } = require('../../services/sales/remisionInvoicing.service');
    const result = await consolidateRemisiones({
      saleIds: req.body?.sale_ids, tenantId: req.tenant_id, userId, notes: req.body?.notes,
    });
    await audit({
      tenant_id: req.tenant_id, user_id: userId, action: 'CONSOLIDATE_REMISIONES_INVOICE',
      entity: 'sale', entity_id: result.sale_id, changes: result, req,
    });
    res.status(201).json({
      success: true,
      message: `Factura ${result.sale_number} creada con las remisiones ${result.remision_numbers.join(', ')}. Se está enviando a la DIAN.`,
      data: result,
    });
  } catch (error) {
    invoicingErrorResponse(res, error, 'Error agrupando las remisiones en una factura');
  }
};

// POST /sales/:id/revert-invoicing -- solo si la DIAN la rechazó o falló el envío
const revertInvoicing = async (req, res) => {
  try {
    const userId = req.user_id || req.user?.id;
    const invoicing = require('../../services/sales/remisionInvoicing.service');
    const result = await invoicing.revertInvoicing({ saleId: req.params.id, tenantId: req.tenant_id, userId });
    await audit({
      tenant_id: req.tenant_id, user_id: userId, action: 'REVERT_REMISION_INVOICING',
      entity: 'sale', entity_id: req.params.id, changes: result, req,
    });
    res.json({
      success: true,
      message: result.reverted === 'consolidated'
        ? `Factura anulada; las remisiones ${result.released.join(', ')} quedaron libres para facturar de nuevo.`
        : `La venta volvió a ser la remisión ${result.sale_number}.`,
      data: result,
    });
  } catch (error) {
    invoicingErrorResponse(res, error, 'Error revirtiendo la facturación');
  }
};

// POST /sales/:id/annul-consolidated { reason } -- NC de anulación de una
// factura agrupada ya aceptada (solo efecto fiscal; libera las remisiones)
const annulConsolidated = async (req, res) => {
  try {
    const userId = req.user_id || req.user?.id;
    const { annulConsolidatedInvoice } = require('../../services/sales/remisionInvoicing.service');
    const result = await annulConsolidatedInvoice({ saleId: req.params.id, tenantId: req.tenant_id, userId, reason: req.body?.reason });
    await audit({
      tenant_id: req.tenant_id, user_id: userId, action: 'ANNUL_CONSOLIDATED_INVOICE',
      entity: 'sale', entity_id: req.params.id, changes: result, req,
    });
    res.status(201).json({
      success: true,
      message: `Se está enviando a la DIAN la nota crédito que anula la factura ${result.invoice_number}. Cuando la acepte, las remisiones quedarán libres para facturar de nuevo.`,
      data: result,
    });
  } catch (error) {
    invoicingErrorResponse(res, error, 'Error anulando la factura agrupada');
  }
};

module.exports = {
  generateSaleNumber,
  nextFreeSaleNumber,
  getAll,
  getById,
  create,
  update,
  confirm,
  cancel,
  registerPayment,
  registerRetentions,
  convertToInvoice,
  consolidateInvoice,
  revertInvoicing,
  annulConsolidated,
  delete: deleteById,
  getStats,
  registerPaymentReminder,
  generatePDF,
  sendWhatsApp,
  generateShareLink,
  generatePaymentReceipt,
  resolveSaleSchemaByToken,
  getPublicSale,
  respondPublicQuote,
  setQuoteStatus,
};