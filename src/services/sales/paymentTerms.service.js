// backend/src/services/sales/paymentTerms.service.js
//
// Forma de pago de una venta (contado / crédito) y su vencimiento.
//
// Se decide UNA vez, cuando la venta se vuelve documento (confirmar, cerrar
// la OT, facturar remisiones), y queda en sales.payment_form. De ahí la toman:
//   - el XML DIAN (PaymentMeans: ID 1/2 + PaymentDueDate), ver dianKitAdapter;
//   - RADIAN: solo una factura a crédito es título valor -- el 034
//     (aceptación tácita) y el 036 (inscripción) la exigen.
// No se recalcula al enviar a la DIAN: un anticipo se aplica en una llamada
// aparte, después de confirmar, y para entonces la factura ya puede haber
// salido -- se habría reportado a crédito una venta que no lo es.

const TIMEZONE = 'America/Bogota';

// 'YYYY-MM-DD' en hora de Colombia. Un DATEONLY ('2026-10-31') ya es la
// fecha: parsearlo lo volvería medianoche UTC = día anterior en Colombia.
function toDateOnly(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(date));
}

function addDays(dateOnly, days) {
  const d = new Date(`${dateOnly}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromDateOnly, toDateOnly_) {
  const ms = new Date(`${toDateOnly_}T12:00:00Z`) - new Date(`${fromDateOnly}T12:00:00Z`);
  return Math.round(ms / 86400000);
}

/**
 * @param {object} p
 * @param {number} p.total
 * @param {number} p.settled      pagado + anticipos aplicados (o por aplicar)
 * @param {Date|string} [p.baseDate] fecha desde la que corre el plazo
 * @param {number} [p.creditDays]  plazo elegido al confirmar
 * @param {string} [p.dueDate]     vencimiento ya pactado (YYYY-MM-DD)
 * @param {number} [p.paymentTerms] plazo por defecto (venta / cliente)
 * @returns {{ payment_form: 'contado'|'credito', credit_days: number|null, due_date: string|null }}
 */
function resolvePaymentTerms({ total, settled, baseDate = new Date(), creditDays, dueDate, paymentTerms }) {
  if (Number(settled || 0) >= Number(total || 0) - 0.01) {
    return { payment_form: 'contado', credit_days: null, due_date: null };
  }
  const base = toDateOnly(baseDate);
  // 0 días es una elección válida ("vence hoy"); null/undefined = no se eligió.
  const days = parseInt(creditDays, 10);
  if (days >= 0) return { payment_form: 'credito', credit_days: days, due_date: addDays(base, days) };
  if (dueDate) {
    const due = toDateOnly(dueDate) < base ? base : toDateOnly(dueDate);
    return { payment_form: 'credito', credit_days: daysBetween(base, due), due_date: due };
  }
  const terms = parseInt(paymentTerms, 10);
  if (terms > 0) return { payment_form: 'credito', credit_days: terms, due_date: addDays(base, terms) };
  // Saldo pendiente sin plazo pactado: crédito con vencimiento el mismo día.
  return { payment_form: 'credito', credit_days: 0, due_date: base };
}

function isCreditSale(sale) {
  return sale?.payment_form === 'credito';
}

// Medio de pago (tabla 13.3.4.2 del Anexo FE) a partir de payment_method.
const PAYMENT_METHOD_CODES = {
  cash: '10', efectivo: '10',
  check: '20', cheque: '20',
  transfer: '47', transferencia: '47',
  credit_card: '48', tarjeta: '48', tarjeta_credito: '48',
  debit_card: '49', tarjeta_debito: '49',
};

/**
 * PaymentMeans del XML de la factura. Crédito → ID 2, código ZZZ (acuerdo
 * mutuo) y PaymentDueDate (nunca anterior a la emisión). Contado → ID 1 y el
 * medio real si es uno solo (mixto/otros → ZZZ).
 * Ventas sin payment_form (anteriores a este campo): se infiere del saldo.
 */
function dianPaymentMeans(sale, issueDate = new Date()) {
  const credit = sale.payment_form
    ? sale.payment_form === 'credito'
    : sale.payment_status !== 'paid';
  if (credit) {
    const issue = toDateOnly(issueDate);
    let due = sale.due_date ? toDateOnly(sale.due_date) : null;
    if (!due && Number(sale.credit_days) > 0) due = addDays(toDateOnly(sale.sale_date || issueDate), Number(sale.credit_days));
    if (!due || due < issue) due = issue;
    return { paymentForm: '2', paymentMethod: 'ZZZ', dueDate: new Date(`${due}T12:00:00Z`) };
  }
  const method = String(sale.payment_method || '').toLowerCase();
  return { paymentForm: '1', paymentMethod: PAYMENT_METHOD_CODES[method] || 'ZZZ' };
}

module.exports = { resolvePaymentTerms, isCreditSale, dianPaymentMeans, toDateOnly };
