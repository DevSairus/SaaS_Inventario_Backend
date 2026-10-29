// backend/src/services/inventory/purchaseNumber.service.js
//
// Siguiente número de compra (PC-AAAA-NNNNN) del tenant. Única fuente: antes
// había dos generadores -- la compra manual rellenaba a 5 dígitos y ordenaba
// el último número como TEXTO, la importación desde XML rellenaba a 4 y
// ordenaba por fecha de creación. Con los dos formatos mezclados,
// "PC-2026-0002" > "PC-2026-00003" como texto: la compra manual calculaba
// siempre un número que ya existía y fallaba en todos sus reintentos.
//
// Ahora se toma el MAYOR número real (comparado como número, sirve con
// cualquier relleno que ya exista) bajo un advisory lock del tenant que dura
// hasta el commit: dos compras simultáneas del mismo tenant no pueden sacar
// el mismo número. El lock solo frena a otra creación de compra del mismo
// tenant, y solo mientras se guarda esta.

const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');

async function nextPurchaseNumber(tenant_id, transaction) {
  if (!transaction) throw new Error('nextPurchaseNumber necesita una transacción (el lock dura hasta el commit)');
  const year = new Date().getFullYear();
  const prefix = `PC-${year}-`;
  const schema = getCurrentSchema() || 'public';

  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: `pitbox:purchase-number:${schema}:${tenant_id}` },
    transaction,
  });
  const [[{ max }]] = await sequelize.query(`
    SELECT COALESCE(MAX((substring(purchase_number FROM :pattern))::bigint), 0) AS max
      FROM "${schema}".purchases
     WHERE tenant_id = :tenant_id AND purchase_number LIKE :like
  `, { replacements: { pattern: `^PC-${year}-(\\d+)$`, like: `${prefix}%`, tenant_id }, transaction });

  return `${prefix}${String(Number(max) + 1).padStart(5, '0')}`;
}

module.exports = { nextPurchaseNumber };
