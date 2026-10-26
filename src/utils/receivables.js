// backend/src/utils/receivables.js
//
// Qué ventas son cartera y cuántos días llevan vencidas. Lo comparten
// Cuentas por Cobrar y el filtro "Por cobrar" del historial de ventas, para
// que ambos muestren exactamente los mismos documentos.

'use strict';

const { Op } = require('sequelize');
const { shouldHideRemisiones, consolidatedExclusionWhere } = require('./remisionVisibility');

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Días vencidos (negativo = aún no vence). Con due_date se vence al día
// siguiente; sin due_date (ventas históricas sin plazo) se asumen 30 días
// desde la venta.
const daysOverdueOf = (invoice, today = new Date()) => {
  const referenceDate = new Date(invoice.due_date || invoice.sale_date);
  const days = Math.floor((today - referenceDate) / MS_PER_DAY);
  return invoice.due_date ? days : days - 30;
};

// Cartera = facturas y remisiones con saldo. Si el tenant oculta las
// remisiones a no-admin (utils/remisionVisibility.js), esos usuarios solo
// ven las facturas.
const receivableDocumentTypes = (req) => (shouldHideRemisiones(req) ? ['factura'] : ['factura', 'remision']);

// Con remisiones visibles, el saldo de una factura consolidada ya está en
// sus remisiones agrupadas -- se excluye para no cobrarlo dos veces. Con
// remisiones ocultas es al revés: la factura consolidada es la que se ve
// (su paid_amount se sincroniza desde las remisiones).
const receivableWhere = (req) => ({
  document_type: { [Op.in]: receivableDocumentTypes(req) },
  ...(shouldHideRemisiones(req) ? {} : consolidatedExclusionWhere()),
});

// Documentos con saldo pendiente: confirmados o entregados, sin pagar del todo.
const pendingReceivableWhere = (req) => ({
  ...receivableWhere(req),
  status: { [Op.in]: ['pending', 'completed'] }, // pending = confirmada, completed = entregada
  payment_status: { [Op.in]: ['pending', 'partial'] },
});

// Borradores de venta (document_type null, se tipan al confirmar). No son
// cartera -- sin asiento ni inventario, y no admiten abonos hasta
// confirmarse -- pero el dinero sigue pendiente, así que el historial de
// ventas los muestra aparte en "Por cobrar". Las cotizaciones no entran.
const draftSaleWhere = () => ({ status: 'draft', document_type: null });

// Vencimiento efectivo en SQL, mismo criterio que daysOverdueOf. `alias` es
// como se referencia la tabla de ventas en la query.
const effectiveDueDateSql = (alias = 'Sale') =>
  `COALESCE("${alias}"."due_date", "${alias}"."sale_date" + INTERVAL '30 days')`;

module.exports = {
  MS_PER_DAY, daysOverdueOf, receivableDocumentTypes, receivableWhere, pendingReceivableWhere,
  draftSaleWhere, effectiveDueDateSql,
};
