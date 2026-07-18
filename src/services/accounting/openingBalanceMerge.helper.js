// backend/src/services/accounting/openingBalanceMerge.helper.js
//
// Convierte filas de `OpeningBalance` (saldos iniciales) al mismo shape que
// ya usan accounts-receivable.controller.js / accountsPayable.controller.js
// para cada Sale/Purchase, así se pueden concatenar ANTES de correr la
// lógica existente de balance/antigüedad/agrupado — sin duplicar esa lógica
// ni tocarla.
//
// Los controllers acceden a los campos por punto (invoice.total_amount,
// purchase.due_date, etc.) y en un par de sitios llaman `.toJSON()` sobre
// cada fila (getCustomerAccountsReceivable / getSupplierAccountsPayable) —
// por eso cada objeto normalizado trae un `toJSON()` no enumerable que se
// comporta igual que en una instancia real de Sequelize.

function withToJson(obj) {
  Object.defineProperty(obj, 'toJSON', {
    value() {
      return { ...this };
    },
    enumerable: false,
  });
  return obj;
}

/**
 * Normaliza un OpeningBalance de tipo 'receivable' al shape de una fila Sale
 * usada en accounts-receivable.controller.js.
 */
function normalizeOpeningBalanceAsSaleRow(ob) {
  return withToJson({
    id: ob.id,
    sale_number: ob.reference || `SI-${ob.id.slice(0, 8)}`,
    sale_date: ob.issue_date,
    due_date: ob.due_date,
    customer_id: ob.customer_id,
    customer_name: ob.customer ? `${ob.customer.first_name || ''} ${ob.customer.last_name || ''}`.trim() : 'Cliente',
    customer: ob.customer || null,
    total_amount: parseFloat(ob.total_amount),
    paid_amount: parseFloat(ob.paid_amount || 0),
    payment_status: ob.payment_status,
    payment_method: null,
    payment_history: ob.payment_history || [],
    document_type: 'saldo_inicial',
    is_opening_balance: true,
  });
}

/**
 * Normaliza un OpeningBalance de tipo 'payable' al shape de una fila
 * Purchase usada en accountsPayable.controller.js.
 */
function normalizeOpeningBalanceAsPurchaseRow(ob) {
  return withToJson({
    id: ob.id,
    purchase_number: ob.reference || `SI-${ob.id.slice(0, 8)}`,
    purchase_date: ob.issue_date,
    due_date: ob.due_date,
    invoice_number: ob.reference || null,
    supplier_id: ob.supplier_id,
    supplier: ob.supplier || null,
    total_amount: parseFloat(ob.total_amount),
    paid_amount: parseFloat(ob.paid_amount || 0),
    payment_status: ob.payment_status,
    payment_method: null,
    payment_history: ob.payment_history || [],
    status: 'confirmed',
    is_opening_balance: true,
  });
}

module.exports = { normalizeOpeningBalanceAsSaleRow, normalizeOpeningBalanceAsPurchaseRow };
