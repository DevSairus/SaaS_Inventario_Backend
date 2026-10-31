// backend/src/services/workshop/vehiclePlate.service.js
//
// Búsqueda de vehículo por placa "normalizada" -- la usa la OT rápida
// (workOrders.controller.js#quickCreate) y su lookup previo en el modal
// (vehicles.controller.js#getByPlate). La placa se guarda como la tecleó
// cada quien (mayúsculas + trim, ver vehicles.controller#create), así que
// "ABC-123", "ABC 123" y "abc123" son el mismo carro: se comparan sin
// espacios ni guiones para no crear un duplicado solo por cómo se escribió.
// Las placas NO son únicas en BD (hay históricos duplicados): si coinciden
// varias, se toma la actualizada más recientemente, que es la que el taller
// viene usando.
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const { Vehicle, Customer } = require('../../models');

/** "abc-123 " -> "ABC123" (solo para comparar, no para guardar). */
function normalizePlate(plate) {
  return String(plate || '').toUpperCase().replace(/[\s-]/g, '');
}

/** Placa tal como se guarda al crear: mayúsculas + trim (igual que vehicles.controller#create). */
function cleanPlate(plate) {
  return String(plate || '').toUpperCase().trim();
}

/**
 * Vehículo activo del tenant cuya placa normalizada coincide, o null.
 * Incluye el propietario (customer) para precargarlo como cliente de la OT.
 */
async function findVehicleByPlate(tenant_id, plate, { transaction } = {}) {
  const normalized = normalizePlate(plate);
  if (!normalized) return null;
  return Vehicle.findOne({
    where: {
      tenant_id,
      is_active: true,
      [Op.and]: [
        sqlWhere(fn('regexp_replace', fn('upper', col('Vehicle.plate')), '[[:space:]-]', '', 'g'), normalized),
      ],
    },
    include: [{
      model: Customer, as: 'customer', required: false,
      attributes: ['id', 'first_name', 'last_name', 'business_name', 'tax_id', 'phone', 'mobile', 'is_assigned_account', 'owner_user_id'],
    }],
    order: [['updated_at', 'DESC']],
    transaction,
  });
}

module.exports = { normalizePlate, cleanPlate, findVehicleByPlate };
