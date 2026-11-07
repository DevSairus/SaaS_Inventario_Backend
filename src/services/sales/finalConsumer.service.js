// backend/src/services/sales/finalConsumer.service.js
//
// Cliente predeterminado de ventas y cotizaciones: CONSUMIDOR FINAL con el
// documento genérico que acepta la DIAN (222222222222, cédula). Si la venta
// llega sin cliente se usa este, para no obligar a buscar o crear uno en cada
// venta de mostrador. Se busca por documento (índice único tenant_id +
// tax_id): muchos tenants ya lo habían creado a mano y se reutiliza ese.
// La ciudad la completa el hook beforeValidate de Customer con la del tenant.

const { Customer } = require('../../models');
const { sequelize } = require('../../config/database');

const FINAL_CONSUMER_TAX_ID = '222222222222';

async function getOrCreateFinalConsumer(tenantId, transaction) {
  const where = { tenant_id: tenantId, tax_id: FINAL_CONSUMER_TAX_ID };
  const existing = await Customer.findOne({ where, transaction });
  if (existing) return existing;
  try {
    // Savepoint: si otra venta lo creó al mismo tiempo, el choque con el
    // índice único no aborta la transacción de la venta.
    return await sequelize.transaction({ transaction }, (t) => Customer.create({
      tenant_id: tenantId,
      customer_type: 'individual',
      first_name: 'CONSUMIDOR',
      last_name: 'FINAL',
      tax_id: FINAL_CONSUMER_TAX_ID,
      document_type: '13',
      is_active: true,
    }, { transaction: t }));
  } catch (err) {
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    return Customer.findOne({ where, transaction });
  }
}

module.exports = { getOrCreateFinalConsumer, FINAL_CONSUMER_TAX_ID };
