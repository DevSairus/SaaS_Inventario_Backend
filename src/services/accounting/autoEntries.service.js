// backend/src/services/accounting/autoEntries.service.js
const { sequelize } = require('../../config/database');
const { createDraftEntry, getMappedAccountId, safeAutoGenerate } = require('./journalEntry.service');

/**
 * Genera el asiento en borrador de una venta completada.
 * Separa ingreso/costo de producto vs servicio (taller) usando SaleItem.item_type,
 * y el medio de pago (caja/bancos/cartera) usando Sale.payment_method y paid_amount.
 *
 * Limitación conocida: si el mapeo contable del tenant no está configurado
 * para algún evento, el asiento no se genera (se loguea el warning) — no
 * bloquea la venta. Revisar logs periódicamente mientras se afina el mapeo.
 */
async function generateSaleEntry(sale, items, tenantId, userId) {
  return safeAutoGenerate(async () => {
    const t = await sequelize.transaction();
    try {
      const productItems = (items || []).filter((i) => i.item_type === 'product');
      const serviceItems = (items || []).filter((i) => i.item_type === 'service');

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
  }, `venta ${sale.id}`);
}

/**
 * Genera el asiento en borrador de una compra recibida.
 */
async function generatePurchaseEntry(purchase, tenantId, userId) {
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
  }, `compra ${purchase.id}`);
}

/**
 * Genera el asiento en borrador de un gasto.
 */
async function generateExpenseEntry(expense, tenantId, userId) {
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
  }, `gasto ${expense.id}`);
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
async function generateCashSessionEntry(session, tenantId, userId) {
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
  }, `cierre de caja ${session.id}`);
}

module.exports = { generateSaleEntry, generatePurchaseEntry, generateExpenseEntry, generateCashSessionEntry };
