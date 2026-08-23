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
async function generateSaleEntry(sale, items, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const productItems = (items || []).filter((i) => i.item_type === 'product');
      const serviceItems = (items || []).filter((i) => i.item_type === 'service' || i.item_type === 'free_line');

      const productRevenue = productItems.reduce((s, i) => s + Number(i.subtotal || 0), 0);
      const serviceRevenue = serviceItems.reduce((s, i) => s + Number(i.subtotal || 0), 0);
      const productCogs = productItems.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_cost || 0), 0);
      const totalTax = Number(sale.tax_amount || 0);
      const total = Number(sale.total_amount || 0);
      const paid = Math.min(Number(sale.paid_amount || 0), total);
      const pending = total - paid;

      const lines = [];

      // Debe: efectivo/bancos por lo pagado + cartera por lo pendiente
      if (paid > 0) {
        const pm = (sale.payment_method || '').toLowerCase();
        const isCash = pm.includes('efectivo') || pm.includes('cash');
        const account_id = await getMappedAccountId(tenantId, isCash ? 'sale_cash_account' : 'sale_bank_account', t);
        lines.push({ account_id, debit: paid, credit: 0, description: 'Cobro de la venta' });
      }
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
 * @param {object} payment - { payment_id, amount, method, date }
 * @param {object} sale - venta (para customer_id, branch_id, sale_number)
 */
async function generatePaymentEntry(payment, sale, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Number(payment.amount || 0);
      if (amount <= 0) return null;

      const pm = (payment.method || '').toLowerCase();
      const isCash = pm.includes('efectivo') || pm.includes('cash');
      const debitAccount = await getMappedAccountId(tenantId, isCash ? 'sale_cash_account' : 'sale_bank_account', t);
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
 * Genera el asiento en borrador de una compra recibida.
 */
async function generatePurchaseEntry(purchase, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const total = Number(purchase.total_amount || 0);
      const tax = Number(purchase.tax_amount || 0);
      // Simplificación MVP: todo lo que no es IVA (subtotal, descuento, flete,
      // otros costos) se lleva a inventario como costo. Si se necesita mayor
      // detalle contable (flete y descuentos en cuentas separadas), es un
      // ajuste puntual a futuro sobre este mismo servicio.
      const subtotal = total - tax;
      const isCash = purchase.payment_status === 'paid';

      const inventoryAccount = await getMappedAccountId(tenantId, 'purchase_inventory', t);
      const lines = [{ account_id: inventoryAccount, debit: subtotal, credit: 0, description: 'Ingreso de mercancía a inventario' }];

      if (tax > 0) {
        const ivaAccount = await getMappedAccountId(tenantId, 'purchase_iva_descontable', t);
        lines.push({ account_id: ivaAccount, debit: tax, credit: 0, description: 'IVA descontable de la compra' });
      }

      const creditAccount = await getMappedAccountId(tenantId, isCash ? 'purchase_cash_account' : 'purchase_payable', t);
      // third_party_id solo cuando queda cuenta por pagar: es lo que alimenta
      // el Libro Auxiliar por proveedor (conciliar cuentas por pagar uno a uno).
      lines.push({
        account_id: creditAccount,
        debit: 0,
        credit: total,
        description: isCash ? 'Pago de contado' : 'Cuenta por pagar a proveedor',
        third_party_id: isCash ? null : (purchase.supplier_id || null),
      });

      const entry = await createDraftEntry(
        tenantId,
        {
          branchId: purchase.branch_id,
          entryDate: purchase.purchase_date || purchase.createdAt || new Date(),
          sourceType: 'purchase',
          sourceId: purchase.id,
          description: `Compra ${purchase.purchase_number || purchase.id}`,
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
 * Genera el asiento en borrador de un gasto.
 */
async function generateExpenseEntry(expense, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const total = Number(expense.total_amount || 0);
      const isPaid = expense.payment_status === 'paid';

      const expenseAccount = await getMappedAccountId(tenantId, `expense_category:${expense.category}`, t);
      const pm = (expense.payment_method || '').toLowerCase();
      const isCash = pm.includes('efectivo') || pm.includes('cash');
      const creditAccount = await getMappedAccountId(
        tenantId,
        !isPaid ? 'expense_payable' : (isCash ? 'expense_cash_account' : 'expense_bank_account'),
        t
      );

      const lines = [
        { account_id: expenseAccount, debit: total, credit: 0, description: expense.description },
        { account_id: creditAccount, debit: 0, credit: total, description: isPaid ? 'Pago del gasto' : 'Gasto pendiente de pago' },
      ];

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
      const productRevenue = (items || [])
        .filter((i) => (i.saleItem?.item_type || 'product') === 'product')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
      const serviceRevenue = (items || [])
        .filter((i) => i.saleItem?.item_type === 'service' || i.saleItem?.item_type === 'free_line')
        .reduce((s, i) => s + Number(i.subtotal || 0), 0);
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

      const pm = (advance.method || '').toLowerCase();
      const isCash = pm.includes('efectivo') || pm.includes('cash');
      const debitAccount = await getMappedAccountId(tenantId, isCash ? 'sale_cash_account' : 'sale_bank_account', t);
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
 * @param {object} refund - { id, amount, method, refund_date }
 * @param {object} advance - anticipo original (para customer_id, branch_id, advance_number)
 */
async function generateAdvanceRefundEntry(refund, advance, tenantId, userId, options = {}) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const amount = Number(refund.amount || 0);
      if (amount <= 0) return null;

      const pm = (refund.method || advance.method || '').toLowerCase();
      const isCash = pm.includes('efectivo') || pm.includes('cash');
      const creditAccount = await getMappedAccountId(tenantId, isCash ? 'sale_cash_account' : 'sale_bank_account', t);
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

module.exports = {
  generateSaleEntry,
  generatePaymentEntry,
  generatePurchaseEntry,
  generateExpenseEntry,
  generateCashSessionEntry,
  generateCustomerReturnEntry,
  generateSupplierReturnEntry,
  generateAdvanceEntry,
  generateAdvanceApplicationEntry,
  generateAdvanceRefundEntry,
  reverseSourceEntries,
};
