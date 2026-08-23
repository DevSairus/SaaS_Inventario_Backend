// backend/src/services/finance/advanceNumber.service.js
// Consecutivo de Anticipo por tenant. Mismo patrón que
// receiptNumber.service.js: prefijo por año, lock sobre el último número
// para evitar colisiones en recepciones concurrentes.
const { Op } = require('sequelize');

async function generateAdvanceNumber(tenant_id, transaction) {
  const { CustomerAdvance } = require('../../models');
  const year = new Date().getFullYear();
  const prefix = `ANT-${year}-`;

  const last = await CustomerAdvance.findOne({
    where: { tenant_id, advance_number: { [Op.like]: `${prefix}%` } },
    order: [['advance_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });

  const lastSeq = last ? parseInt(last.advance_number.replace(prefix, ''), 10) : 0;
  const seq = (isNaN(lastSeq) ? 0 : lastSeq) + 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
}

module.exports = { generateAdvanceNumber };
