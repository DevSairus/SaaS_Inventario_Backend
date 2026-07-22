// backend/src/services/finance/receiptNumber.service.js
// Consecutivo de Recibo de Caja por tenant. Mismo patrón que
// generateOrderNumber (workOrders.controller.js): prefijo por año, lock de
// fila sobre el último número para evitar colisiones en pagos concurrentes.
const { Op } = require('sequelize');

async function generateReceiptNumber(tenant_id, transaction) {
  const { Receipt } = require('../../models');
  const year = new Date().getFullYear();
  const prefix = `REC-${year}-`;

  const last = await Receipt.findOne({
    where: { tenant_id, receipt_number: { [Op.like]: `${prefix}%` } },
    order: [['receipt_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });

  const lastSeq = last ? parseInt(last.receipt_number.replace(prefix, ''), 10) : 0;
  const seq = (isNaN(lastSeq) ? 0 : lastSeq) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

module.exports = { generateReceiptNumber };
