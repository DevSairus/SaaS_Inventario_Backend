'use strict';

// Catálogo de vehículos v2: triciclos Can-Am (Spyder, Ryker) y Polaris
// Slingshot como moto, Indian, y más líneas/marcas de cuatrimotos y UTV
// (Tao Motor, Coolster, Kayo, Cushman, E-Z-GO, Mahindra Roxor…).
// seedVehicleCatalog solo inserta lo que falta; corre una vez, en public.
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const [[{ schema }]] = await sequelize.query(`SELECT current_schema() AS schema`);
    if (schema !== 'public') return;
    const { seedVehicleCatalog } = require('../../services/workshop/vehicleCatalog.service');
    await seedVehicleCatalog(sequelize);
  },

  // Las líneas agregadas no se quitan: pueden estar ya en vehículos registrados.
  down: async () => {},
};
