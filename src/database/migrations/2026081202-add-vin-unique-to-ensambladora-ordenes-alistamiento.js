'use strict';

// A diferencia de ensambladora_ordenes_entrega (que ya nació con
// `vin: { unique: true }`, ver 2026080201-create-ensambladora-ordenes-locales.js),
// ensambladora_ordenes_alistamiento no tenía esta constraint -- un CSA podía
// registrar el mismo alistamiento más de una vez para el mismo VIN sin que
// nada lo impidiera. Mismo criterio de "1 por vehículo" que entrega.
module.exports = {
  up: async (queryInterface) => {
    try {
      await queryInterface.addConstraint('ensambladora_ordenes_alistamiento', {
        fields: ['vin'],
        type: 'unique',
        name: 'ensambladora_ordenes_alistamiento_vin_key',
      });
    } catch (error) {
      // Ya existe (reproceso de la migración, o el schema ya la tenía) --
      // idempotente, no es un error real.
      if (!/already exists/i.test(error.message)) throw error;
    }
  },

  down: async (queryInterface) => {
    try {
      await queryInterface.removeConstraint('ensambladora_ordenes_alistamiento', 'ensambladora_ordenes_alistamiento_vin_key');
    } catch (error) {
      if (!/does not exist/i.test(error.message)) throw error;
    }
  },
};
