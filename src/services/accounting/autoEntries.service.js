// backend/src/services/accounting/autoEntries.service.js
const { sequelize } = require('../../config/database');
const { createDraftEntry, getMappedAccountId, safeAutoGenerate, reverseEntry } = require('./journalEntry.service');

/**
 * Busca el (los) JournalEntry vigentes de un movimiento origen (venta, compra,
 * gasto, cierre de caja) y los reversa. "Vigente" = no voided y sin
 * reversed_by_entry_id todavía (evita reversar dos veces si se llama más de
 * una vez por error, ej. doble clic en cancelar).
 *
 * Es el contrapunto de generateSaleEntry/generatePurchaseEntry/etc.: se debe
 * llamar cuando el movimiento origen deja de ser válido (venta cancelada,
 * devolución de cliente/proveedor). Igual que los generadores, es
 * fire-and-forget seguro — un problema acá no debe bloquear la cancelación
 * ni la devolución real.
 *
 * @param {string} sourceType 'sale' | 'purchase' | 'expense' | 'cash_session'
 * @param {string} sourceId
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} reason
 */
async function reverseSourceEntries(sourceType, sourceId, tenantId, userId, reason) {
  return safeAutoGenerate(async () => {
    const { JournalEntry } = require('../../models');
    const { Op } = require('sequelize');

    const entries = await JournalEntry.findAll({
      where: {
        tenant_id: tenantId,
        source_type: sourceType,
        source_id: sourceId,
        status: { [Op.ne]: 'voided' },
        reversed_by_entry_id: null,
      },
    });

    if (entries.length === 0) return null; // nunca tuvo asiento (mapeo no configurado) — nada que reversar

    const results = [];
    for (const entry of entries) {
      const t = await sequelize.transaction();
      try {
        const result = await reverseEntry(entry.id, tenantId, userId, reason, t);
        await t.commit();
        results.push(result);
      } catch (error) {
        await t.rollback();
        throw error;
      }
    }
    return results;
  }, `reversión ${sourceType} ${sourceId}`);
}

/**
 * Genera el asiento en borrador de una venta completada.
 * Separa ingreso/costo de producto vs servicio (taller) usando SaleItem.item_type,
 * y el medio de pago (caja/bancos/cartera) usando Sale.payment_method y paid_amount.
 *
 * Las líneas libres ('free_line') se agrupan con 'service': no tienen
 * producto de catálogo ni costo asociado (unit_cost siempre 0), así que su
 * naturaleza contable es la misma que un servicio — ingreso puro, sin COGS.
 * Antes se quedaban fuera de ambos grupos y su ingreso nunca se registraba
 * en el Haber, dejando el asiento desbalanceado frente al Debe (que sí toma
 * el total completo de la venta vía sale.total_amount).
 *
 * Limitación conocida: si el mapeo contable del tenant no está configurado
 * para algún evento, el asiento no se genera (se loguea el warning) — no
 * bloquea la venta. Revisar logs periódicamente mientras se afina el mapeo.
 */
const LEGACY_CONFIRM_NOTE = 'Pago registrado al confirmar la venta';

/**
 * Pagos de payment_history que se contabilizan dentro del asiento de la
 * venta (no tienen asiento propio):
 *  - los marcados `in_sale_entry` (pagos al confirmar, incluido cada medio
 *    de un pago mixto, y abonos de OT trasladados al facturarla);
 *  - si no hay marcados, los pagos al confirmar de antes de la marca
 *    (reconocibles por su nota);
 *  - y si tampoco, el paid_amount de la venta como un solo pago con su
 *    payment_method (ventas muy viejas), descontando lo que vino de
 *    anticipos o retenciones, que tienen su propio asiento.
 */
function salePaymentsForEntry(sale) {
  const history = sale.payment_history || [];
  const flagged = history.filter((p) => p.in_sale_entry);
  if (flagged.length) return flagged;
  const legacyConfirm = history.filter((p) => p.notes === LEGACY_CONFIRM_NOTE);
  if (legacyConfirm.length) return legacyConfirm;
  const ownEntries = history
    .filter((p) => p.source === 'advance' || p.source === 'retention')
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  const legacyPaid = Number(sale.paid_amount || 0) - ownEntries;
  return legacyPaid > 0 ? [{ amount: legacyPaid, method: sale.payment_method }] : [];
}

async function generateSaleEntry(sale, items, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      // Ítems rechazados al aprobar una cotización parcial (approval_status
      // 'rechazado') nunca se cobran ni descuentan inventario (ver confirm()
      // en sales.controller.js) -- si entraran aquí, el asiento reconocería
      // ingreso/CMV de algo que la venta real nunca incluyó.
      const validItems = (items || []).filter((i) => i.approval_status !== 'rechazado');
      const productItems = validItems.filter((i) => i.item_type === 'product');
      const serviceItems = validItems.filter((i) => i.item_type === 'service' || i.item_type === 'free_line');

      let productRevenue = productItems.reduce((s, i) => s + Number(i.subtotal || 0), 0);
      let serviceRevenue = serviceItems.reduce((s, i) => s + Number(i.subtotal || 0), 0);
      // Factura AIU: Administración, Imprevistos y Utilidad también son
      // ingreso del contrato de servicios (el IVA, solo sobre la U, ya viene
      // en sale.tax_amount).
      if (sale.aiu_enabled) {
        serviceRevenue += Number(sale.aiu_admin_amount || 0) + Number(sale.aiu_unforeseen_amount || 0) + Number(sale.aiu_profit_amount || 0);
      }

      // CMV solo de productos con control de inventario (track_inventory):
      // uno sin control nunca tuvo una salida real de kardex que respalde el
      // crédito a 143501, aunque tenga un average_cost > 0 heredado. La
      // devolución (generateCustomerReturnEntry) ya aplicaba este mismo
      // filtro; acá faltaba.
      const { Op } = require('sequelize');
      const { Product } = require('../../models');
      const productIds = [...new Set(productItems.map((i) => i.product_id).filter(Boolean))];
      const trackedProducts = productIds.length
        ? await Product.findAll({ where: { id: { [Op.in]: productIds }, tenant_id: tenantId }, attributes: ['id', 'track_inventory'], transaction: t })
        : [];
      const trackInventoryMap = new Map(trackedProducts.map((p) => [p.id, p.track_inventory]));
      const productCogs = productItems
        .filter((i) => trackInventoryMap.get(i.product_id))
        .reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_cost || 0), 0);
      const totalTax = Number(sale.tax_amount || 0);

      // Descuento GLOBAL de la venta/cotización (resolveGlobalDiscount en
      // sales.controller.js): se resta de sale.total_amount DESPUÉS de
      // impuestos, así que el IVA por línea no cambia -- reduce el ingreso
      // reconocido. Se prorratea entre producto y servicio según su peso para
      // no desbalancear el asiento frente a sale.total_amount, que ya lo trae
      // descontado (antes, generateSaleEntry ni lo leía y el asiento quedaba
      // descuadrado, así que createDraftEntry lo rechazaba y la venta se
      // quedaba sin CMV/ingreso contabilizados).
      const globalDiscount = Number(sale.global_discount_amount || 0);
      if (globalDiscount > 0) {
        const revenueBase = productRevenue + serviceRevenue;
        if (revenueBase > 0) {
          const productDiscount = Math.round(globalDiscount * (productRevenue / revenueBase));
          productRevenue -= productDiscount;
          serviceRevenue -= (globalDiscount - productDiscount);
        }
      }

      const total = Number(sale.total_amount || 0);
      const lines = [];

      // Debe: una línea por cada pago que entra en ESTE asiento (cada uno a
      // su caja/banco, o a Anticipos si era un abono de OT ya contabilizado)
      // + cartera por lo pendiente. Los abonos posteriores tienen su propio
      // asiento (generatePaymentEntry) y no entran acá.
      let paid = 0;
      for (const p of salePaymentsForEntry(sale)) {
        const amount = Math.round(Math.min(Number(p.amount || 0), total - paid) * 100) / 100;
        if (amount <= 0) continue;
        const fromWorkOrderAdvance = p.source === 'work_order' && p.advance_accounted;
        const account_id = fromWorkOrderAdvance
          ? await getMappedAccountId(tenantId, 'customer_advance_liability', t)
          : await resolvePaymentAccount(tenantId, p, t, SALE_ACCOUNTS);
        lines.push({
          account_id, debit: amount, credit: 0,
          description: fromWorkOrderAdvance ? 'Abono recibido en la OT' : 'Cobro de la venta',
          third_party_id: fromWorkOrderAdvance ? (sale.customer_id || null) : undefined,
        });
        paid += amount;
      }
      const pending = Math.round((total - paid) * 100) / 100;
      if (pending > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_receivable', t);
        // third_party_id solo en la línea de cartera: es lo que alimenta el
        // Libro Auxiliar por cliente (conciliar cuentas por cobrar uno a uno).
        lines.push({ account_id, debit: pending, credit: 0, description: 'Saldo pendiente por cobrar', third_party_id: sale.customer_id || null });
      }

      // Haber: ingresos por producto y/o servicio
      if (productRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_product', t);
        lines.push({ account_id, debit: 0, credit: productRevenue, description: 'Ingreso por venta de mercancía' });
      }
      if (serviceRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_service', t);
        lines.push({ account_id, debit: 0, credit: serviceRevenue, description: 'Ingreso por servicios' });
      }
      if (totalTax > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_tax_iva', t);
        lines.push({ account_id, debit: 0, credit: totalTax, description: 'IVA generado' });
      }

      // Costo de venta / inventario (solo productos, requiere unit_cost en los items)
      if (productCogs > 0) {
        const cogsAccount = await getMappedAccountId(tenantId, 'sale_cogs_product', t);
        const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
        lines.push({ account_id: cogsAccount, debit: productCogs, credit: 0, description: 'Costo de mercancía vendida' });
        lines.push({ account_id: inventoryAccount, debit: 0, credit: productCogs, description: 'Salida de inventario por venta' });
      }

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: sale.branch_id,
          entryDate: sale.sale_date || sale.createdAt || new Date(),
          sourceType: 'sale',
          sourceId: sale.id,
          description: `Venta ${sale.sale_number || sale.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `venta ${sale.id}`, options);
}

/**
 * Genera el asiento en borrador de UN abono/pago puntual sobre una venta ya
 * existente (venta manual confirmada o remisión/factura generada desde una
 * OT de Taller). Es el contrapunto del hueco donde `registerPayment` solo
 * actualizaba `Sale.payment_history` sin mover nunca caja/bancos vs cartera.
 *
 * A diferencia de `generateSaleEntry` (un asiento por venta, con el reparto
 * pagado/pendiente de ESE momento), este genera un asiento nuevo por CADA
 * abono, así cada uno es reversable individualmente (ej. si se cancela la
 * venta después de varios abonos) sin tocar el asiento original de la venta.
 *
 * @param {object} payment - { payment_id, amount, method, date, bank_account_id? }
 * @param {object} sale - venta (para customer_id, branch_id, sale_number)
 */
async function generatePaymentEntry(payment, sale, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Number(payment.amount || 0);
      if (amount <= 0) return null;

      const debitAccount = await resolvePaymentAccount(tenantId, payment, t, SALE_ACCOUNTS);
      const receivableAccount = await getMappedAccountId(tenantId, 'sale_receivable', t);

      const lines = [
        { account_id: debitAccount, debit: amount, credit: 0, description: 'Cobro de abono' },
        {
          account_id: receivableAccount, debit: 0, credit: amount,
          description: 'Reducción de cartera por abono',
          third_party_id: sale.customer_id || null,
        },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: sale.branch_id,
          entryDate: payment.date || new Date(),
          sourceType: 'payment',
          sourceId: payment.payment_id,
          description: `Abono a venta ${sale.sale_number || sale.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `abono ${payment.payment_id} (venta ${sale.id})`, options);
}

/**
 * Asiento de un abono cobrado en una OT antes de facturarla. Todavía no hay
 * venta ni cartera, así que se reconoce como anticipo del cliente:
 *   Débito  1105 Caja / 1110 Bancos (o la subcuenta de la cuenta bancaria)
 *   Crédito 2805 Anticipos de clientes (tercero = cliente)
 * Al facturar la OT, el asiento de la venta debita 2805 por estos abonos
 * (ver salePaymentsForEntry / generateSale en workOrders.controller.js).
 *
 * @param {object} payment - { payment_id, amount, method, date, bank_account_id?, branch_id? }
 * @param {object} order - OT (para customer_id, order_number)
 */
async function generateWorkOrderPaymentEntry(payment, order, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Math.round(Number(payment.amount || 0) * 100) / 100;
      if (amount <= 0) return null;
      const debitAccount = await resolvePaymentAccount(tenantId, payment, t, SALE_ACCOUNTS);
      const liabilityAccount = await getMappedAccountId(tenantId, 'customer_advance_liability', t);
      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: payment.branch_id || null,
          entryDate: payment.date ? String(payment.date).slice(0, 10) : new Date(),
          sourceType: 'work_order_payment',
          sourceId: payment.payment_id,
          description: `Abono a OT ${order.order_number || order.id}${payment.method ? ` (${payment.method})` : ''}`,
          lines: [
            { account_id: debitAccount, debit: amount, credit: 0, description: 'Cobro de abono a OT' },
            { account_id: liabilityAccount, debit: 0, credit: amount, description: 'Abono recibido antes de facturar la OT', third_party_id: order.customer_id || null },
          ],
          createdBy: userId,
        },
        t
      );
      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `abono ${payment.payment_id} (OT ${order.id})`, options);
}

/**
 * Reapertura de un abono de OT cuya factura se anuló con nota crédito al
 * reversar la OT (revertStatus). El asiento de la venta había cruzado el
 * abono (D 2805, o D Caja si no tenía asiento propio) y la nota crédito,
 * con el abono ya sacado de la venta, acredita toda la cartera; este ajuste
 * deja la cartera en cero y el abono otra vez como anticipo de la OT:
 *   Débito  1305 Clientes (tercero = cliente)
 *   Crédito 2805 Anticipos de clientes
 * Usa source 'work_order_payment' con el payment_id del abono: al volver a
 * facturar la OT, generateSale lo reconoce como abono ya contabilizado.
 */
async function generateWorkOrderPaymentReopenEntry(payment, order, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Math.round(Number(payment.amount || 0) * 100) / 100;
      if (amount <= 0) return null;
      const receivableAccount = await getMappedAccountId(tenantId, 'sale_receivable', t);
      const liabilityAccount = await getMappedAccountId(tenantId, 'customer_advance_liability', t);
      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: payment.branch_id || null,
          entryDate: new Date(),
          sourceType: 'work_order_payment',
          sourceId: payment.payment_id,
          description: `Reapertura de abono a OT ${order.order_number || order.id} (factura anulada)`,
          lines: [
            { account_id: receivableAccount, debit: amount, credit: 0, description: 'Abono de OT sacado de la factura anulada', third_party_id: order.customer_id || null },
            { account_id: liabilityAccount, debit: 0, credit: amount, description: 'Abono vuelve a quedar como anticipo de la OT', third_party_id: order.customer_id || null },
          ],
          createdBy: userId,
        },
        t
      );
      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `reapertura de abono ${payment.payment_id} (OT ${order.id})`, options);
}

/**
 * Valores de una compra (o de una recepción parcial de ella) para su asiento.
 * Sin `portion` → la compra completa (comportamiento de siempre).
 */
function purchaseEntryAmounts(purchase, portion) {
  if (portion) return portion;
  const total = Number(purchase.total_amount || 0);
  const tax = Number(purchase.tax_amount || 0);
  return {
    // Simplificación MVP: todo lo que no es IVA (subtotal, descuento, flete,
    // otros costos) se lleva a inventario como costo.
    inventory: total - tax,
    tax,
    retefuente: Number(purchase.retefuente_amount || 0),
    reteiva: Number(purchase.reteiva_amount || 0),
    reteica: Number(purchase.reteica_amount || 0),
    retention_lines: Array.isArray(purchase.applied_retentions) ? purchase.applied_retentions : [],
  };
}

/**
 * Genera el asiento en borrador de una compra recibida, o de una recepción
 * parcial (options.portion = valores de lo recibido, ver
 * purchases.controller.buildReceiptPortion).
 *
 * La contrapartida es SIEMPRE la cuenta por pagar al proveedor (neto de
 * retenciones). Los pagos —de contado al confirmar o abonos después—
 * generan su propio asiento (generatePurchasePaymentEntry: débito
 * proveedores / crédito caja-bancos). Antes, una compra ya pagada al
 * recibirse acreditaba Caja directo y los abonos no generaban asiento: la
 * 2205 nunca bajaba y caja/bancos no reflejaban los pagos a proveedores.
 */
async function generatePurchaseEntry(purchase, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amounts = purchaseEntryAmounts(purchase, options.portion);
      const inventory = Number(amounts.inventory || 0);
      const tax = Number(amounts.tax || 0);

      // Retenciones PRACTICADAS al proveedor (Fase 0 de Declaraciones
      // Periódicas / Formulario 350): cada una va a su cuenta de pasivo y
      // SOLO se resta de lo que se le debe al proveedor.
      const retefuente = Number(amounts.retefuente || 0);
      const reteiva = Number(amounts.reteiva || 0);
      const reteica = Number(amounts.reteica || 0);
      const totalRetentions = retefuente + reteiva + reteica;
      const netPayable = inventory + tax - totalRetentions;

      const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
      const lines = [{ account_id: inventoryAccount, debit: inventory, credit: 0, description: 'Ingreso de mercancía a inventario' }];

      if (tax > 0) {
        const ivaAccount = await getMappedAccountId(tenantId, 'purchase_iva_descontable', t);
        lines.push({ account_id: ivaAccount, debit: tax, credit: 0, description: 'IVA descontable de la compra' });
      }

      const payableAccount = await getMappedAccountId(tenantId, 'purchase_payable', t);
      // third_party_id: alimenta el Libro Auxiliar por proveedor.
      lines.push({
        account_id: payableAccount,
        debit: 0,
        credit: netPayable,
        description: 'Cuenta por pagar a proveedor',
        third_party_id: purchase.supplier_id || null,
      });

      // Con detalle por concepto (applied_retentions), cada línea va a la
      // subcuenta que el proveedor tenga configurada para ese concepto
      // (ej. 236525 servicios vs 236540 compras); sin cuenta propia, a la
      // del mapeo por tipo. Solo se usa el detalle si cuadra con los totales
      // por tipo — si no (datos viejos/manuales), se cae al comportamiento
      // por tipo para no descuadrar el asiento.
      const detail = Array.isArray(amounts.retention_lines) ? amounts.retention_lines : [];
      const detailTotal = detail.reduce((sum, l) => sum + Number(l.amount || 0), 0);
      const useDetail = detail.length > 0 && Math.abs(detailTotal - totalRetentions) < 0.01;
      const RETENTION_EVENT = { '07': 'purchase_retefuente_payable', '05': 'purchase_reteiva_payable', '06': 'purchase_reteica_payable' };
      // Las cuentas 2365/2367/2368 se llevan por tercero: es el soporte del
      // certificado de retención y de Exógena (1001) por proveedor.
      const retentionThirdParty = purchase.supplier_id || null;

      if (useDetail) {
        const { ChartOfAccount } = require('../../models');
        for (const l of detail) {
          const amount = Number(l.amount || 0);
          if (amount <= 0 || !RETENTION_EVENT[l.code]) continue;
          let account_id = null;
          if (l.account_id) {
            const acc = await ChartOfAccount.findOne({
              where: { id: l.account_id, tenant_id: tenantId, accepts_entries: true },
              attributes: ['id'],
              transaction: t,
            });
            account_id = acc?.id || null;
          }
          if (!account_id) account_id = await getMappedAccountId(tenantId, RETENTION_EVENT[l.code], t);
          lines.push({ account_id, debit: 0, credit: amount, description: `${l.concept || 'Retención'} (${l.rate}${l.code === '06' ? '‰' : '%'}) practicada al proveedor`, third_party_id: retentionThirdParty });
        }
      } else {
        if (retefuente > 0) {
          const account_id = await getMappedAccountId(tenantId, 'purchase_retefuente_payable', t);
          lines.push({ account_id, debit: 0, credit: retefuente, description: 'Retención en la fuente practicada al proveedor', third_party_id: retentionThirdParty });
        }
        if (reteiva > 0) {
          const account_id = await getMappedAccountId(tenantId, 'purchase_reteiva_payable', t);
          lines.push({ account_id, debit: 0, credit: reteiva, description: 'IVA retenido al proveedor', third_party_id: retentionThirdParty });
        }
        if (reteica > 0) {
          const account_id = await getMappedAccountId(tenantId, 'purchase_reteica_payable', t);
          lines.push({ account_id, debit: 0, credit: reteica, description: 'ICA retenido al proveedor', third_party_id: retentionThirdParty });
        }
      }

      const label = options.portion?.label ? ` — ${options.portion.label}` : '';
      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: purchase.branch_id,
          entryDate: options.portion?.entry_date || purchase.purchase_date || purchase.createdAt || new Date(),
          sourceType: 'purchase',
          sourceId: purchase.id,
          description: `Compra ${purchase.purchase_number || purchase.id}${label}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `compra ${purchase.id}`, options);
}

/**
 * Cuenta de caja o bancos para un cobro o pago: la subcuenta de la cuenta
 * bancaria elegida (bank_account_id) si viene; si no, Caja para efectivo y
 * Bancos para lo demás (transferencia, tarjeta, cheque...).
 *
 * `cashEvent` / `bankEvents` eligen el mapeo según el flujo (compras por
 * defecto; ventas y gastos pasan los suyos). Los bankEvents se prueban en
 * orden: no todos los flujos tienen mapeo propio de bancos.
 */
async function resolvePaymentAccount(tenantId, payment, t, {
  cashEvent = 'purchase_cash_account',
  bankEvents = ['purchase_bank_account', 'expense_bank_account', 'sale_bank_account'],
} = {}) {
  if (payment.bank_account_id) {
    const { BankAccount } = require('../../models');
    const bank = await BankAccount.findOne({ where: { id: payment.bank_account_id, tenant_id: tenantId }, attributes: ['chart_of_account_id'], transaction: t });
    if (bank?.chart_of_account_id) return bank.chart_of_account_id;
  }
  const pm = String(payment.method || '').toLowerCase();
  if (pm.includes('efectivo') || pm.includes('cash')) {
    return getMappedAccountId(tenantId, cashEvent, t);
  }
  for (const event of bankEvents) {
    try { return await getMappedAccountId(tenantId, event, t); } catch (e) { /* siguiente */ }
  }
  throw new Error(`No hay cuenta de bancos mapeada (${bankEvents.join(' / ')})`);
}

const SALE_ACCOUNTS = { cashEvent: 'sale_cash_account', bankEvents: ['sale_bank_account'] };
const EXPENSE_ACCOUNTS = { cashEvent: 'expense_cash_account', bankEvents: ['expense_bank_account', 'sale_bank_account'] };

/**
 * Asiento de un pago (o abono) a proveedor sobre una compra:
 *   Débito  2205 Proveedores (tercero = proveedor)
 *   Crédito 1105 Caja / 1110 Bancos
 * payment = { amount, date, method, bank_account_id?, notes? }
 */
async function generatePurchasePaymentEntry(purchase, payment, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Math.round(Number(payment.amount || 0) * 100) / 100;
      if (amount <= 0) throw new Error('Pago sin monto');
      const payableAccount = await getMappedAccountId(tenantId, 'purchase_payable', t);
      const creditAccount = await resolvePaymentAccount(tenantId, payment, t);
      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: purchase.branch_id,
          entryDate: payment.date ? String(payment.date).slice(0, 10) : new Date(),
          sourceType: 'purchase_payment',
          sourceId: purchase.id,
          description: `Pago a proveedor — Compra ${purchase.purchase_number || purchase.id}${payment.method ? ` (${payment.method})` : ''}`,
          lines: [
            { account_id: payableAccount, debit: amount, credit: 0, description: 'Pago a proveedor', third_party_id: purchase.supplier_id || null },
            { account_id: creditAccount, debit: 0, credit: amount, description: payment.notes || 'Salida por pago a proveedor' },
          ],
          createdBy: userId,
        },
        t
      );
      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `pago a proveedor (compra ${purchase.id})`, options);
}

/**
 * Genera el asiento en borrador de un gasto.
 */
async function generateExpenseEntry(expense, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const total = Number(expense.total_amount || 0);
      const isPaid = expense.payment_status === 'paid';

      // Mismo caso que en generatePurchaseEntry: Expense también calcula
      // retefuente/reteiva/reteica (Fase C de impuestos) y hasta ahora no se
      // contabilizaban -- ver Fase 0 de Declaraciones Periódicas.
      const retefuente = Number(expense.retefuente_amount || 0);
      const reteiva = Number(expense.reteiva_amount || 0);
      const reteica = Number(expense.reteica_amount || 0);
      const totalRetentions = retefuente + reteiva + reteica;
      const netPayable = total - totalRetentions;

      const expenseAccount = await getMappedAccountId(tenantId, `expense_category:${expense.category}`, t);
      const creditAccount = isPaid
        ? await resolvePaymentAccount(tenantId, { method: expense.payment_method, bank_account_id: expense.bank_account_id }, t, EXPENSE_ACCOUNTS)
        : await getMappedAccountId(tenantId, 'expense_payable', t);

      const lines = [
        { account_id: expenseAccount, debit: total, credit: 0, description: expense.description },
        { account_id: creditAccount, debit: 0, credit: netPayable, description: isPaid ? 'Pago del gasto' : 'Gasto pendiente de pago' },
      ];

      if (retefuente > 0) {
        const account_id = await getMappedAccountId(tenantId, 'expense_retefuente_payable', t);
        lines.push({ account_id, debit: 0, credit: retefuente, description: 'Retención en la fuente practicada', third_party_id: expense.supplier_id || null });
      }
      if (reteiva > 0) {
        const account_id = await getMappedAccountId(tenantId, 'expense_reteiva_payable', t);
        lines.push({ account_id, debit: 0, credit: reteiva, description: 'IVA retenido', third_party_id: expense.supplier_id || null });
      }
      if (reteica > 0) {
        const account_id = await getMappedAccountId(tenantId, 'expense_reteica_payable', t);
        lines.push({ account_id, debit: 0, credit: reteica, description: 'ICA retenido', third_party_id: expense.supplier_id || null });
      }

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: expense.branch_id,
          entryDate: expense.expense_date || expense.createdAt || new Date(),
          sourceType: 'expense',
          sourceId: expense.id,
          description: `Gasto ${expense.expense_number || expense.id} — ${expense.description}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `gasto ${expense.id}`, options);
}

/**
 * Asiento de un abono sobre un gasto que se registró pendiente (el asiento
 * del gasto acreditó expense_payable). Mismo esquema que el pago a proveedor:
 *   Débito  2335 Costos y gastos por pagar (tercero = proveedor)
 *   Crédito 1105 Caja / 1110 Bancos (o la subcuenta de la cuenta bancaria)
 * payment = { amount, date, method, bank_account_id?, notes? }
 */
async function generateExpensePaymentEntry(expense, payment, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Math.round(Number(payment.amount || 0) * 100) / 100;
      if (amount <= 0) throw new Error('Pago sin monto');
      const payableAccount = await getMappedAccountId(tenantId, 'expense_payable', t);
      const creditAccount = await resolvePaymentAccount(tenantId, payment, t, EXPENSE_ACCOUNTS);
      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: expense.branch_id,
          entryDate: payment.date ? String(payment.date).slice(0, 10) : new Date(),
          sourceType: 'expense_payment',
          sourceId: expense.id,
          description: `Pago de gasto ${expense.expense_number || expense.id}${payment.method ? ` (${payment.method})` : ''}`,
          lines: [
            { account_id: payableAccount, debit: amount, credit: 0, description: 'Pago de gasto', third_party_id: expense.supplier_id || null },
            { account_id: creditAccount, debit: 0, credit: amount, description: payment.notes || 'Salida por pago de gasto' },
          ],
          createdBy: userId,
        },
        t
      );
      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `pago de gasto ${expense.id}`, options);
}

/**
 * Genera el asiento en borrador del cierre de una caja, si hubo diferencias
 * (sobrante o faltante) entre lo esperado y lo contado. Si la caja cuadró
 * exacto en todos los métodos, no genera nada (no hay nada que contabilizar).
 *
 * Reutiliza sale_cash_account (efectivo) y sale_bank_account (tarjeta,
 * transferencia, otro) como la cuenta que se ajusta — son las mismas cuentas
 * que ya se usan para registrar el cobro de ventas por esos medios de pago,
 * así que el saldo contable de "caja"/"bancos" queda consistente con lo que
 * físicamente se contó al cerrar.
 */
async function generateCashSessionEntry(session, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const differences = session.differences || {};
    const nonZero = Object.entries(differences).filter(([, v]) => Math.abs(Number(v || 0)) > 0.01);
    if (nonZero.length === 0) return null; // caja cuadrada, nada que contabilizar

    const t = await sequelize.transaction();
    try {
      const lines = [];

      for (const [bucket, rawDiff] of nonZero) {
        const diff = Number(rawDiff);
        const baseEvent = bucket === 'efectivo' ? 'sale_cash_account' : 'sale_bank_account';
        const baseAccount = await getMappedAccountId(tenantId, baseEvent, t);

        if (diff > 0) {
          // Sobrante: contado > esperado
          const surplusAccount = await getMappedAccountId(tenantId, 'cash_session_surplus', t);
          lines.push({ account_id: baseAccount, debit: diff, credit: 0, description: `Sobrante en caja — ${bucket}` });
          lines.push({ account_id: surplusAccount, debit: 0, credit: diff, description: `Sobrante en caja — ${bucket}` });
        } else {
          // Faltante: contado < esperado
          const shortageAccount = await getMappedAccountId(tenantId, 'cash_session_shortage', t);
          const amount = Math.abs(diff);
          lines.push({ account_id: shortageAccount, debit: amount, credit: 0, description: `Faltante en caja — ${bucket}` });
          lines.push({ account_id: baseAccount, debit: 0, credit: amount, description: `Faltante en caja — ${bucket}` });
        }
      }

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: session.branch_id,
          entryDate: session.session_date || session.closed_at || new Date(),
          sourceType: 'cash_session',
          sourceId: session.id,
          description: `Cierre de caja ${session.session_date} — ajuste por diferencias`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `cierre de caja ${session.id}`, options);
}

/**
 * Genera el asiento en borrador de una devolución de cliente (nota crédito),
 * aprobada parcial o totalmente sobre una venta ya contabilizada.
 *
 * Es el contrapunto de generateSaleEntry, pero NO es una reversión total del
 * asiento de la venta (reverseSourceEntries) porque una devolución casi
 * siempre es parcial (algunos ítems, no toda la venta). En cambio, genera un
 * asiento nuevo con las mismas cuentas que usó la venta original, en la
 * proporción de lo devuelto:
 *
 *  - Debe: ingreso por producto/servicio devuelto + IVA devuelto (reversan
 *    ingreso e impuesto generado).
 *  - Haber: efectivo/bancos (si la venta ya estaba cobrada) y/o cartera (si
 *    aún tenía saldo pendiente), repartido en la MISMA proporción pagado/
 *    pendiente que tenía la venta original — evita asumir que la devolución
 *    siempre se paga en efectivo o siempre se descuenta de cartera.
 *  - Si el producto vuelve a inventario vendible (mismo criterio que ya usa
 *    el controller para el movimiento físico: track_inventory + destino
 *    'inventory'), se revierte también el costo de venta (COGS) de esos
 *    ítems específicos.
 *
 * @param {object} customerReturn - instancia de CustomerReturn
 * @param {Array} items - CustomerReturnItem[] con `product` y `saleItem` (item_type) incluidos
 * @param {object} sale - venta original (para conocer payment_method, paid_amount, total_amount, customer_id, branch_id)
 */
async function generateCustomerReturnEntry(customerReturn, items, sale, tenantId, userId) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      // free_line se agrupa con 'service' — mismo criterio que generateSaleEntry
      // (sin producto de catálogo ni costo, es ingreso puro igual que un servicio).
      const grossProductRevenue = (items || [])
        .filter((i) => (i.saleItem?.item_type || 'product') === 'product')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
      const grossServiceRevenue = (items || [])
        .filter((i) => i.saleItem?.item_type === 'service' || i.saleItem?.item_type === 'free_line')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
      // Descuento global: la venta reconoció el ingreso ya descontado
      // (generateSaleEntry); la devolución reversa la misma proporción, no el
      // valor de lista. total_amount de la devolución ya viene neto.
      const { productRevenue, serviceRevenue } = require('../sales/globalDiscount.service')
        .splitRevenueDiscount(grossProductRevenue, grossServiceRevenue, Number(customerReturn.discount_amount || 0));
      const totalTax = Number(customerReturn.tax || 0);
      const totalReturned = Number(customerReturn.total_amount || 0);

      // COGS solo de ítems que sí vuelven a inventario vendible — mismo
      // criterio que ya usa approveCustomerReturn para el movimiento físico.
      const cogsReturned = (items || [])
        .filter((i) => i.product?.track_inventory && i.destination === 'inventory')
        .reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_cost || 0), 0);

      // Reparto pagado/pendiente en la misma proporción que tenía la venta
      // original — una devolución no siempre implica devolver efectivo.
      const saleTotal = Number(sale.total_amount || 0);
      const salePaid = Math.min(Number(sale.paid_amount || 0), saleTotal);
      const paidRatio = saleTotal > 0 ? salePaid / saleTotal : 0;
      const moneyBackPaid = Math.round(totalReturned * paidRatio * 100) / 100;
      const moneyBackPending = Math.round((totalReturned - moneyBackPaid) * 100) / 100;

      const lines = [];

      // Debe: reversa de ingreso e IVA
      if (productRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_product', t);
        lines.push({ account_id, debit: productRevenue, credit: 0, description: 'Reversión de ingreso por devolución de mercancía' });
      }
      if (serviceRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_service', t);
        lines.push({ account_id, debit: serviceRevenue, credit: 0, description: 'Reversión de ingreso por devolución de servicio' });
      }
      if (totalTax > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_tax_iva', t);
        lines.push({ account_id, debit: totalTax, credit: 0, description: 'Reversión de IVA generado por devolución' });
      }

      // Haber: sale efectivo/bancos (reintegro) y/o se reduce cartera
      if (moneyBackPaid > 0) {
        const pm = (sale.payment_method || '').toLowerCase();
        const isCash = pm.includes('efectivo') || pm.includes('cash');
        const account_id = await getMappedAccountId(tenantId, isCash ? 'sale_cash_account' : 'sale_bank_account', t);
        lines.push({ account_id, debit: 0, credit: moneyBackPaid, description: 'Reintegro por devolución (parte ya cobrada)' });
      }
      if (moneyBackPending > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_receivable', t);
        lines.push({ account_id, debit: 0, credit: moneyBackPending, description: 'Reducción de cartera por devolución', third_party_id: sale.customer_id || null });
      }

      // Reversión de costo de venta / inventario, solo lo que vuelve a stock
      if (cogsReturned > 0) {
        const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
        const cogsAccount = await getMappedAccountId(tenantId, 'sale_cogs_product', t);
        lines.push({ account_id: inventoryAccount, debit: cogsReturned, credit: 0, description: 'Reingreso a inventario por devolución' });
        lines.push({ account_id: cogsAccount, debit: 0, credit: cogsReturned, description: 'Reversión de costo de venta por devolución' });
      }

      if (lines.length === 0) return null; // nada que contabilizar (devolución de $0, caso raro pero posible)

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: sale.branch_id,
          entryDate: customerReturn.return_date || new Date(),
          sourceType: 'customer_return',
          sourceId: customerReturn.id,
          description: `Devolución de cliente ${customerReturn.return_number} — venta ${sale.sale_number || sale.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `devolución de cliente ${customerReturn.id}`);
}

/**
 * Genera el asiento en borrador de una nota crédito emitida a un cliente
 * (NC contra una factura ya aceptada por la DIAN, creada desde
 * `createAndSendCreditNote`). Simétrico a generateCustomerReturnEntry pero
 * a partir del propio `Sale` de la nota (document_type: 'nota_credito'),
 * que ya trae subtotal/tax_amount/total_amount calculados.
 *
 * `createAndSendCreditNote` siempre deja la NC con `payment_status: 'paid'`
 * y `paid_amount = total_amount`, así que en la práctica todo el
 * contravalor se acredita a caja/bancos (mismo medio de pago de la factura
 * original) — no hay reparto contra cartera hoy en ese flujo.
 *
 * No reversa costo de venta/inventario: los ítems de la NC se crean con
 * `unit_cost: 0` (no hay dato de costo que reversar en este flujo).
 *
 * @param {object} noteSale - instancia de Sale con document_type: 'nota_credito'
 * @param {Array} items - ítems de la nota (con item_type, subtotal)
 */
async function generateCreditNoteEntry(noteSale, items, tenantId, userId) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      let productRevenue = (items || [])
        .filter((i) => (i.item_type || 'product') === 'product')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
      let serviceRevenue = (items || [])
        .filter((i) => i.item_type === 'service' || i.item_type === 'free_line')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
      // Nota sobre factura AIU: también se reversa el ingreso de A + I + U.
      if (noteSale.aiu_enabled) {
        serviceRevenue += Number(noteSale.aiu_admin_amount || 0) + Number(noteSale.aiu_unforeseen_amount || 0) + Number(noteSale.aiu_profit_amount || 0);
      }
      // Parte del descuento global de la factura (la nota ya trae el total
      // neto): se reversa el ingreso descontado, igual que se reconoció.
      ({ productRevenue, serviceRevenue } = require('../sales/globalDiscount.service')
        .splitRevenueDiscount(productRevenue, serviceRevenue, Number(noteSale.global_discount_amount || 0)));
      const totalTax = Number(noteSale.tax_amount || 0);
      const total = Number(noteSale.total_amount || 0);
      const paid = Math.min(Number(noteSale.paid_amount || 0), total);
      const pending = total - paid;

      const lines = [];

      // Debe: reversa de ingreso e IVA
      if (productRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_product', t);
        lines.push({ account_id, debit: productRevenue, credit: 0, description: 'Reversión de ingreso por nota crédito' });
      }
      if (serviceRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_service', t);
        lines.push({ account_id, debit: serviceRevenue, credit: 0, description: 'Reversión de ingreso por nota crédito' });
      }
      if (totalTax > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_tax_iva', t);
        lines.push({ account_id, debit: totalTax, credit: 0, description: 'Reversión de IVA por nota crédito' });
      }

      // Haber: reintegro de caja/bancos y/o reducción de cartera
      if (paid > 0) {
        const pm = (noteSale.payment_method || '').toLowerCase();
        const isCash = pm.includes('efectivo') || pm.includes('cash');
        const account_id = await getMappedAccountId(tenantId, isCash ? 'sale_cash_account' : 'sale_bank_account', t);
        lines.push({ account_id, debit: 0, credit: paid, description: 'Reintegro por nota crédito' });
      }
      if (pending > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_receivable', t);
        lines.push({ account_id, debit: 0, credit: pending, description: 'Reducción de cartera por nota crédito', third_party_id: noteSale.customer_id || null });
      }

      if (lines.length === 0) return null;

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: noteSale.branch_id,
          entryDate: noteSale.sale_date || noteSale.createdAt || new Date(),
          sourceType: 'credit_note',
          sourceId: noteSale.id,
          description: `Nota crédito ${noteSale.sale_number || noteSale.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `nota crédito ${noteSale.id}`);
}

/**
 * Genera el asiento en borrador de una nota débito (cargo adicional sobre
 * una factura ya aceptada por la DIAN, creada desde
 * `createAndSendDebitNote`). Es un cargo nuevo, mismo signo que una venta
 * (Debe cartera/caja, Haber ingreso + IVA).
 *
 * `createAndSendDebitNote` siempre deja la ND con `payment_status: 'pending'`
 * y `paid_amount: 0`, así que en la práctica todo el monto queda en cartera.
 *
 * @param {object} noteSale - instancia de Sale con document_type: 'nota_debito'
 * @param {Array} items - ítems de la nota (con item_type, subtotal)
 */
async function generateDebitNoteEntry(noteSale, items, tenantId, userId) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const productRevenue = (items || [])
        .filter((i) => (i.item_type || 'product') === 'product')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
      const serviceRevenue = (items || [])
        .filter((i) => i.item_type === 'service' || i.item_type === 'free_line')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
      const totalTax = Number(noteSale.tax_amount || 0);
      const total = Number(noteSale.total_amount || 0);
      const paid = Math.min(Number(noteSale.paid_amount || 0), total);
      const pending = total - paid;

      const lines = [];

      // Debe: cobro (si ya se pagó) y/o cartera nueva
      if (paid > 0) {
        const pm = (noteSale.payment_method || '').toLowerCase();
        const isCash = pm.includes('efectivo') || pm.includes('cash');
        const account_id = await getMappedAccountId(tenantId, isCash ? 'sale_cash_account' : 'sale_bank_account', t);
        lines.push({ account_id, debit: paid, credit: 0, description: 'Cobro de nota débito' });
      }
      if (pending > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_receivable', t);
        lines.push({ account_id, debit: pending, credit: 0, description: 'Cartera por nota débito', third_party_id: noteSale.customer_id || null });
      }

      // Haber: ingreso e IVA generados por el cargo
      if (productRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_product', t);
        lines.push({ account_id, debit: 0, credit: productRevenue, description: 'Ingreso por nota débito' });
      }
      if (serviceRevenue > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_revenue_service', t);
        lines.push({ account_id, debit: 0, credit: serviceRevenue, description: 'Ingreso por nota débito' });
      }
      if (totalTax > 0) {
        const account_id = await getMappedAccountId(tenantId, 'sale_tax_iva', t);
        lines.push({ account_id, debit: 0, credit: totalTax, description: 'IVA generado por nota débito' });
      }

      if (lines.length === 0) return null;

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: noteSale.branch_id,
          entryDate: noteSale.sale_date || noteSale.createdAt || new Date(),
          sourceType: 'debit_note',
          sourceId: noteSale.id,
          description: `Nota débito ${noteSale.sale_number || noteSale.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `nota débito ${noteSale.id}`);
}

/**
 * Genera el asiento en borrador de una devolución a proveedor (nota crédito
 * recibida), simétrico-invertido de generatePurchaseEntry.
 *
 * A diferencia de la venta, la compra no distingue pagado/pendiente en
 * proporción — generatePurchaseEntry usa un booleano (`payment_status ===
 * 'paid'`), así que acá se replica esa misma simplificación: si la compra
 * original quedó pagada, el dinero "vuelve" a caja/bancos; si no, se reduce
 * la cuenta por pagar al proveedor.
 *
 * @param {object} supplierReturn - instancia de SupplierReturn
 * @param {Array} items - SupplierReturnItem[]
 * @param {object} purchase - compra original (para payment_status, branch_id, supplier_id)
 */
async function generateSupplierReturnEntry(supplierReturn, items, purchase, tenantId, userId) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const totalReturned = Number(supplierReturn.total_amount || 0);
      const taxReturned = Number(supplierReturn.tax || 0);
      const inventoryReturned = totalReturned - taxReturned; // mismo criterio que generatePurchaseEntry: todo lo no-IVA es inventario

      const lines = [];

      // Haber: sale de inventario (activo baja) y se revierte el IVA descontable ya tomado
      if (inventoryReturned > 0) {
        const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
        lines.push({ account_id: inventoryAccount, debit: 0, credit: inventoryReturned, description: 'Salida de inventario por devolución a proveedor' });
      }
      if (taxReturned > 0) {
        const ivaAccount = await getMappedAccountId(tenantId, 'purchase_iva_descontable', t);
        lines.push({ account_id: ivaAccount, debit: 0, credit: taxReturned, description: 'Reversión de IVA descontable por devolución' });
      }

      // Debe: reintegro de dinero (si ya se había pagado) o reducción de cuenta por pagar
      const isCash = purchase.payment_status === 'paid';
      const debitAccount = await getMappedAccountId(tenantId, isCash ? 'purchase_cash_account' : 'purchase_payable', t);
      lines.push({
        account_id: debitAccount,
        debit: totalReturned,
        credit: 0,
        description: isCash ? 'Reintegro por devolución a proveedor' : 'Reducción de cuenta por pagar por devolución',
        third_party_id: isCash ? null : (purchase.supplier_id || null),
      });

      if (lines.length === 0) return null;

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: purchase.branch_id,
          entryDate: supplierReturn.return_date || new Date(),
          sourceType: 'supplier_return',
          sourceId: supplierReturn.id,
          description: `Devolución a proveedor ${supplierReturn.return_number} — compra ${purchase.purchase_number || purchase.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `devolución a proveedor ${supplierReturn.id}`);
}

/**
 * Genera el asiento en borrador al RECIBIR un anticipo de cliente
 * (`source_type: 'customer_advance'`). Ver Anticipos-Clientes-Analisis-y-Plan.md §7.2.a.
 *
 * Caja/Bancos (débito) vs 280505 Anticipos de Clientes (crédito) — no toca
 * ingresos ni IVA. La excepción de IVA en anticipos de servicio no
 * terminado (Art. 429 lit. c ET, ver §7.3 del análisis) se deja marcada en
 * `advance.triggers_iva` como dato informativo para el informe y para que
 * el usuario decida con su contador cómo tratarla — automatizar aquí el
 * prorrateo de IVA asumiría una tarifa que este módulo no conoce (el
 * anticipo no está itemizado), así que el asiento siempre sale "limpio".
 *
 * @param {object} advance - instancia de CustomerAdvance ya creada
 */
async function generateAdvanceEntry(advance, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Number(advance.amount || 0);
      if (amount <= 0) return null;

      const debitAccount = await resolvePaymentAccount(tenantId, advance, t, SALE_ACCOUNTS);
      const liabilityAccount = await getMappedAccountId(tenantId, 'customer_advance_liability', t);

      const lines = [
        { account_id: debitAccount, debit: amount, credit: 0, description: 'Recepción de anticipo de cliente' },
        {
          account_id: liabilityAccount, debit: 0, credit: amount,
          description: 'Anticipo recibido — pasivo con el cliente',
          third_party_id: advance.customer_id || null,
        },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: advance.branch_id,
          entryDate: advance.received_date || new Date(),
          sourceType: 'customer_advance',
          sourceId: advance.id,
          description: `Anticipo ${advance.advance_number || advance.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `anticipo ${advance.id}`, options);
}

/**
 * Genera el asiento en borrador al APLICAR un anticipo (o parte de él) a
 * una factura (`source_type: 'customer_advance_application'`). Ver §7.2.b.
 *
 * 280505 Anticipos de Clientes (débito) vs 130505 Clientes/cartera
 * (crédito) — el efectivo ya se reconoció al recibir el anticipo
 * (generateAdvanceEntry), así que este asiento no vuelve a tocar caja; solo
 * "paga" la cartera que generó la venta, igual que un abono en efectivo.
 *
 * @param {object} application - { id, amount, application_date }
 * @param {object} sale - venta a la que se aplicó (para customer_id, branch_id, sale_number)
 */
async function generateAdvanceApplicationEntry(application, sale, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Number(application.amount || 0);
      if (amount <= 0) return null;

      const liabilityAccount = await getMappedAccountId(tenantId, 'customer_advance_liability', t);
      const receivableAccount = await getMappedAccountId(tenantId, 'sale_receivable', t);

      const lines = [
        { account_id: liabilityAccount, debit: amount, credit: 0, description: 'Aplicación de anticipo a factura' },
        {
          account_id: receivableAccount, debit: 0, credit: amount,
          description: 'Reducción de cartera por anticipo aplicado',
          third_party_id: sale.customer_id || null,
        },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: sale.branch_id,
          entryDate: application.application_date || new Date(),
          sourceType: 'customer_advance_application',
          sourceId: application.id,
          description: `Aplicación de anticipo a venta ${sale.sale_number || sale.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `aplicación de anticipo ${application.id} (venta ${sale.id})`, options);
}

/**
 * Genera el asiento en borrador al DEVOLVER un anticipo (total o parcial)
 * a un cliente (`source_type: 'customer_advance_refund'`). Ver §7.2.c.
 *
 * 280505 Anticipos de Clientes (débito) vs Caja/Bancos (crédito) — sale
 * dinero de caja, no hay factura de por medio.
 *
 * @param {object} refund - { id, amount, method, bank_account_id?, refund_date }
 * @param {object} advance - anticipo original (para customer_id, branch_id, advance_number)
 */
async function generateAdvanceRefundEntry(refund, advance, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Number(refund.amount || 0);
      if (amount <= 0) return null;

      const creditAccount = await resolvePaymentAccount(tenantId, {
        method: refund.method || advance.method,
        bank_account_id: refund.bank_account_id,
      }, t, SALE_ACCOUNTS);
      const liabilityAccount = await getMappedAccountId(tenantId, 'customer_advance_liability', t);

      const lines = [
        {
          account_id: liabilityAccount, debit: amount, credit: 0,
          description: 'Devolución de anticipo a cliente',
          third_party_id: advance.customer_id || null,
        },
        { account_id: creditAccount, debit: 0, credit: amount, description: 'Salida de caja/bancos por devolución de anticipo' },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: advance.branch_id,
          entryDate: refund.refund_date || new Date(),
          sourceType: 'customer_advance_refund',
          sourceId: refund.id,
          description: `Devolución de anticipo ${advance.advance_number || advance.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `devolución de anticipo ${refund.id} (anticipo ${advance.id})`, options);
}

/**
 * Asiento de las retenciones que el CLIENTE le practicó a una venta
 * (ReteFuente / ReteIVA / ReteICA), registradas desde cartera como un abono
 * sin movimiento de caja (sales.controller.js#registerRetentions).
 * source_type 'payment' con el payment_id del abono: así la cancelación de la
 * venta lo reversa igual que cualquier otro abono.
 *
 *   D sale_retefuente_receivable / sale_reteiva_receivable / sale_reteica_receivable
 *   C sale_receivable (cartera del cliente)
 *
 * La ReteICA queda en 135518 hasta que se cruza en la causación del ICA del
 * municipio (services/tax/ica.service.js).
 *
 * @param {object} payment - { payment_id, date, retentions: { retefuente, reteiva, reteica } }
 */
async function generateSaleRetentionEntry(payment, sale, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const r = payment.retentions || {};
      const parts = [
        { key: 'retefuente', event: 'sale_retefuente_receivable', label: 'ReteFuente practicada por el cliente' },
        { key: 'reteiva', event: 'sale_reteiva_receivable', label: 'ReteIVA practicada por el cliente' },
        { key: 'reteica', event: 'sale_reteica_receivable', label: 'ReteICA practicada por el cliente' },
      ].filter((p) => Number(r[p.key] || 0) > 0);
      if (!parts.length) return null;

      const lines = [];
      let total = 0;
      for (const p of parts) {
        const amount = Number(r[p.key]);
        total += amount;
        lines.push({ account_id: await getMappedAccountId(tenantId, p.event, t), debit: amount, credit: 0, description: p.label, third_party_id: sale.customer_id || null });
      }
      lines.push({
        account_id: await getMappedAccountId(tenantId, 'sale_receivable', t), debit: 0, credit: total,
        description: 'Retenciones aplicadas a la cartera', third_party_id: sale.customer_id || null,
      });

      const entry = await createDraftEntry(tenantId, {
        branchId: sale.branch_id,
        entryDate: payment.date || new Date(),
        sourceType: 'payment',
        sourceId: payment.payment_id,
        description: `Retenciones de la venta ${sale.sale_number || sale.id}`,
        lines,
        createdBy: userId,
      }, t);

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `retenciones de venta ${sale.id}`, options);
}

/**
 * Genera el asiento en borrador al REASIGNAR saldo de un anticipo a otro
 * cliente (`source_type: 'customer_advance_reassignment'`, source = anticipo
 * nuevo del cliente destino). No toca caja: solo cambia el tercero del
 * pasivo 280505.
 *
 * @param {object} newAdvance - anticipo creado para el cliente destino
 * @param {object} original - anticipo de origen (customer_id del tercero que sale)
 */
async function generateAdvanceReassignmentEntry(newAdvance, original, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Number(newAdvance.amount || 0);
      if (amount <= 0) return null;

      const liabilityAccount = await getMappedAccountId(tenantId, 'customer_advance_liability', t);
      const lines = [
        {
          account_id: liabilityAccount, debit: amount, credit: 0,
          description: `Reasignación de anticipo ${original.advance_number} — sale del cliente`,
          third_party_id: original.customer_id || null,
        },
        {
          account_id: liabilityAccount, debit: 0, credit: amount,
          description: `Reasignación de anticipo — entra como ${newAdvance.advance_number}`,
          third_party_id: newAdvance.customer_id || null,
        },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: newAdvance.branch_id,
          entryDate: new Date(),
          sourceType: 'customer_advance_reassignment',
          sourceId: newAdvance.id,
          description: `Reasignación de anticipo ${original.advance_number} → ${newAdvance.advance_number}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `reasignación de anticipo ${original.id} → ${newAdvance.id}`, options);
}

/**
 * Última fecha calendario de un período 'YYYY-MM' (fecha del asiento de
 * depreciación -- se contabiliza al cierre del mes, no al día 1). Cálculo
 * duplicado a propósito frente a periodEndDate en fixedAssetDepreciation.service.js
 * para no crear un require circular entre ambos servicios (ese servicio ya
 * requiere generateDepreciationEntry desde acá).
 */
function lastDayOfPeriod(period) {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Genera el asiento en borrador de la depreciación mensual de UN activo fijo
 * en UN período (`source_type: 'fixed_asset_depreciation'`). Ver
 * Contabilidad-Plan-Ejecucion-Fases-1-4.md — Fase 1.
 *
 * Débito: gasto de depreciación, mapeado por categoría del activo (evento
 * `fixed_asset_depreciation_expense:<category>`) -- una camioneta y un
 * computador no deberían caer en la misma cuenta de gasto, mismo criterio
 * que ya usa `expense_category:*` para gastos operativos.
 *
 * Crédito: depreciación acumulada -- NO se resuelve vía AccountMapping
 * porque cada activo ya trae su propia cuenta
 * (`accumulated_depreciation_account_id`, elegida al darlo de alta; ver
 * FixedAsset.js), necesaria para poder tener más de una subcuenta 1592 por
 * categoría/activo si el plan de cuentas del tenant así lo requiere.
 *
 * @param {object} asset - instancia de FixedAsset (status 'activo')
 * @param {string} period - 'YYYY-MM'
 * @param {number} amount - monto a depreciar en este período
 */
async function generateDepreciationEntry(asset, period, amount, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    if (!(amount > 0)) return null;

    const t = await sequelize.transaction();
    try {
      const expenseAccount = await getMappedAccountId(tenantId, `fixed_asset_depreciation_expense:${asset.category}`, t);

      const lines = [
        { account_id: expenseAccount, debit: amount, credit: 0, description: `Depreciación ${period} — ${asset.name}` },
        { account_id: asset.accumulated_depreciation_account_id, debit: 0, credit: amount, description: `Depreciación acumulada — ${asset.name}` },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: asset.branch_id,
          entryDate: lastDayOfPeriod(period),
          sourceType: 'fixed_asset_depreciation',
          sourceId: asset.id,
          description: `Depreciación ${period} — ${asset.name}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `depreciación ${asset.id} (${period})`, options);
}

/**
 * Genera el asiento en borrador del pago de UNA cuota de un crédito
 * (`source_type: 'loan_payment'`). Ver
 * Contabilidad-Plan-Ejecucion-Fases-1-4.md — Fase 2.
 *
 * Débito: pasivo financiero (por `principal_amount`) + gasto financiero
 * (por `interest_amount`, si aplica) -- ambas cuentas propias del crédito
 * (`liability_account_id`/`interest_expense_account_id`, elegidas al darlo
 * de alta; ver Loan.js), NO vía AccountMapping.
 *
 * Crédito: caja/bancos -- reutiliza `expense_cash_account`/
 * `expense_bank_account` (las mismas cuentas que ya usan los pagos de
 * gastos): pagar una cuota de crédito es una salida de caja/banco como
 * cualquier otra, no hace falta un mapeo nuevo por esto.
 *
 * @param {object} installment - instancia de LoanInstallment
 * @param {object} loan - instancia de Loan (dueña de la cuota)
 * @param {string} paymentMethod - texto libre, ej. 'Efectivo'/'Transferencia' (mismo criterio que Expense.payment_method)
 */
async function generateLoanPaymentEntry(installment, loan, paymentMethod, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const principal = Number(installment.principal_amount);
      const interest = Number(installment.interest_amount);

      const pm = (paymentMethod || '').toLowerCase();
      const isCash = pm.includes('efectivo') || pm.includes('cash');
      const creditAccount = await getMappedAccountId(tenantId, isCash ? 'expense_cash_account' : 'expense_bank_account', t);

      const lines = [
        { account_id: loan.liability_account_id, debit: principal, credit: 0, description: `Abono a capital cuota ${installment.installment_number} — ${loan.lender_name}` },
      ];
      if (interest > 0) {
        lines.push({ account_id: loan.interest_expense_account_id, debit: interest, credit: 0, description: `Intereses cuota ${installment.installment_number} — ${loan.lender_name}` });
      }
      lines.push({ account_id: creditAccount, debit: 0, credit: principal + interest, description: `Pago cuota ${installment.installment_number} — ${loan.lender_name}` });

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: loan.branch_id,
          entryDate: installment.paid_date || new Date(),
          sourceType: 'loan_payment',
          sourceId: installment.id,
          description: `Pago cuota ${installment.installment_number}/${loan.term_months} — ${loan.lender_name}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `pago cuota ${installment.id}`, options);
}

/**
 * Genera el asiento en borrador de un ajuste de inventario CONFIRMADO
 * (entrada o salida manual, incluida la toma física — ver physicalCounts.controller.js,
 * que crea sus ajustes de entrada/salida vía createAdjustmentCore/confirmAdjustmentCore).
 * Antes, confirmAdjustmentCore movía stock y average_cost vía createMovement
 * pero nunca tocaba el libro diario -- una merma o un sobrante de conteo
 * cambiaba el valor del inventario sin que ese cambio llegara jamás a
 * resultados (ni gasto por faltante, ni ingreso por sobrante).
 *
 * MVP: se usan las cuentas genéricas de "diferencia no explicada" que ya
 * existen para el cierre de caja (Ingresos/Gastos Diversos) -- mismo criterio
 * que cash_session_surplus/shortage. Si se necesita separar mermas de
 * sobrantes por motivo (robo, vencimiento, daño) en cuentas distintas, es un
 * ajuste puntual a futuro sobre este mismo servicio.
 *
 * @param {object} adjustment - InventoryAdjustment (adjustment_type, adjustment_date, adjustment_number)
 * @param {Array} items - InventoryAdjustmentItem[] (quantity, unit_cost)
 */
async function generateAdjustmentEntry(adjustment, items, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const totalValue = (items || []).reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_cost || 0), 0);
      if (totalValue <= 0) return null; // ajuste sin costo (ej. producto con average_cost=0) -- nada que contabilizar

      const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
      const lines = adjustment.adjustment_type === 'entrada'
        ? [
            { account_id: inventoryAccount, debit: totalValue, credit: 0, description: 'Sobrante de inventario' },
            { account_id: await getMappedAccountId(tenantId, 'inventory_adjustment_surplus', t), debit: 0, credit: totalValue, description: 'Sobrante de inventario' },
          ]
        : [
            { account_id: await getMappedAccountId(tenantId, 'inventory_adjustment_shortage', t), debit: totalValue, credit: 0, description: 'Faltante/merma de inventario' },
            { account_id: inventoryAccount, debit: 0, credit: totalValue, description: 'Faltante/merma de inventario' },
          ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: adjustment.branch_id,
          entryDate: adjustment.adjustment_date || adjustment.createdAt || new Date(),
          sourceType: 'inventory_adjustment',
          sourceId: adjustment.id,
          description: `Ajuste de inventario ${adjustment.adjustment_number || adjustment.id} (${adjustment.reason || adjustment.adjustment_type})`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `ajuste de inventario ${adjustment.id}`, options);
}

/**
 * Genera el asiento en borrador de un consumo interno APROBADO (repuestos o
 * insumos que la propia empresa consume, no un cliente -- ej. aceite para el
 * vehículo de la empresa). Antes, approveInternalConsumption sacaba stock vía
 * createMovement pero el gasto correspondiente nunca se reconocía: el
 * inventario bajaba de valor sin ningún gasto que lo explique en el Estado de
 * Resultados.
 *
 * @param {object} consumption - InternalConsumption (total_cost, consumption_date, consumption_number)
 */
async function generateInternalConsumptionEntry(consumption, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const totalCost = Number(consumption.total_cost || 0);
      if (totalCost <= 0) return null;

      const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
      const expenseAccount = await getMappedAccountId(tenantId, 'internal_consumption_expense', t);

      const lines = [
        { account_id: expenseAccount, debit: totalCost, credit: 0, description: `Consumo interno — ${consumption.department || 'sin depto.'}` },
        { account_id: inventoryAccount, debit: 0, credit: totalCost, description: 'Salida de inventario por consumo interno' },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: consumption.branch_id,
          entryDate: consumption.consumption_date || consumption.createdAt || new Date(),
          sourceType: 'internal_consumption',
          sourceId: consumption.id,
          description: `Consumo interno ${consumption.consumption_number || consumption.id}`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `consumo interno ${consumption.id}`, options);
}

/**
 * Genera los comprobantes contables en borrador de un periodo de nómina ya
 * emitido (todos los Documentos Soporte de Pago de Nómina Electrónica
 * aceptados por la DIAN -- ver submitPayrollPeriod en
 * payrollPeriodEmissionService.js y la liquidación definitiva en
 * payrollTerminationService.js).
 *
 * La lógica vive en services/payroll/payrollAccountingService.js:
 * comprobante de nómina por empleado y concepto (cédula como tercero),
 * aportes del empleador y provisiones por fondo de destino, en el mismo
 * asiento o en uno aparte según la configuración de nómina del tenant.
 *
 * Mantiene el contrato anterior (devuelve un asiento o null, nunca lanza
 * salvo `options.rethrow`) para los dos llamadores existentes.
 *
 * @param {object} period - PayrollPeriod
 * @param {Array} liquidations - [{ employee, liquidation }] (ver payrollService.js#liquidarEmpleado)
 */
async function generatePayrollEntry(period, liquidations, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const { generarComprobantesNomina } = require('../payroll/payrollAccountingService');
    const { entries } = await generarComprobantesNomina(period, liquidations, tenantId, userId);
    return entries[0] || null;
  }, `nómina periodo ${period.id}`, options);
}

/**
 * Genera el asiento en borrador del stock inicial de un producto NUEVO (ver
 * createProduct en products.controller.js). Antes, un producto creado con
 * current_stock/average_cost > 0 escribía esos valores directo en la fila,
 * sin ningún movimiento ni asiento -- al venderlo, se acreditaba 143501 por
 * algo que nunca se había debitado, y el saldo terminaba negativo.
 *
 * Mismo criterio contable que createInventoryOpeningBalance (saldo inicial
 * de un tenant que migra a Pitbox): débito a inventario, crédito a la cuenta
 * puente de saldos iniciales -- un producto nuevo con stock de arranque es,
 * en el fondo, el mismo caso (inventario que entra sin una compra real
 * registrada en el sistema). A diferencia de esa función (que postea de una
 * vez, en un flujo explícito de apertura contable), este queda en borrador y
 * no bloquea la creación del producto si el mapeo no está configurado.
 */
async function generateInitialStockEntry(product, quantity, unitCost, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const totalValue = Number(quantity || 0) * Number(unitCost || 0);
      if (totalValue <= 0) return null;

      const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
      const suspenseAccount = await getMappedAccountId(tenantId, 'opening_balance_suspense', t);

      const lines = [
        { account_id: inventoryAccount, debit: totalValue, credit: 0, description: 'Stock inicial al crear el producto' },
        { account_id: suspenseAccount, debit: 0, credit: totalValue, description: 'Contrapartida stock inicial' },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          entryDate: new Date(),
          sourceType: 'product_initial_stock',
          sourceId: product.id,
          description: `Stock inicial — ${product.name} (${product.sku})`,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `stock inicial producto ${product.id}`, options);
}

/**
 * Igual que generateInitialStockEntry pero consolidado en UN asiento para
 * toda una importación masiva de productos (ver productsBulkImport.controller.js)
 * -- llamar al generador por producto ahí adentro (miles de filas) abriría
 * miles de transacciones/asientos, lo mismo que bulkCreate evita para la
 * escritura de los productos.
 *
 * @param {object} params - { description, totalValue }
 */
async function generateBulkInventoryEntry({ description, totalValue }, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      if (!(Number(totalValue) > 0)) return null;

      const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
      const suspenseAccount = await getMappedAccountId(tenantId, 'opening_balance_suspense', t);

      const lines = [
        { account_id: inventoryAccount, debit: totalValue, credit: 0, description },
        { account_id: suspenseAccount, debit: 0, credit: totalValue, description: 'Contrapartida stock inicial' },
      ];

      const entry = await createDraftEntry(
        tenantId,
        {
          entryDate: new Date(),
          sourceType: 'product_bulk_import',
          description,
          lines,
          createdBy: userId,
        },
        t
      );

      await t.commit();
      return entry;
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }, `importación masiva de inventario (tenant ${tenantId})`, options);
}

module.exports = {
  generateSaleEntry,
  salePaymentsForEntry,
  generatePaymentEntry,
  generateWorkOrderPaymentEntry,
  generateWorkOrderPaymentReopenEntry,
  generatePurchaseEntry,
  generatePurchasePaymentEntry,
  generateExpenseEntry,
  generateExpensePaymentEntry,
  generateCashSessionEntry,
  generateCustomerReturnEntry,
  generateCreditNoteEntry,
  generateDebitNoteEntry,
  generateSupplierReturnEntry,
  generateAdvanceEntry,
  generateAdvanceApplicationEntry,
  generateAdvanceRefundEntry,
  generateAdvanceReassignmentEntry,
  generateSaleRetentionEntry,
  generateDepreciationEntry,
  generateLoanPaymentEntry,
  generateAdjustmentEntry,
  generateInternalConsumptionEntry,
  generateInitialStockEntry,
  generateBulkInventoryEntry,
  generatePayrollEntry,
  reverseSourceEntries,
};
