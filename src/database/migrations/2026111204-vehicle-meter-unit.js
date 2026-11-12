'use strict';

// Horómetro para cuatrimotos y UTV: unidad del medidor por vehículo y unidad
// del intervalo por tipo de mantenimiento ('km' u 'h'). Las lecturas siguen en
// las mismas columnas (mileage_in/out, current_mileage, interval_km).
// Cuatrimotos y UTV ya registrados pasan a horas. Corre en cada schema.
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const has = async (table) => {
      const [[{ n }]] = await q(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '${table}'`);
      return n > 0;
    };
    if (await has('vehicles')) {
      await q(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS meter_unit VARCHAR(2) NOT NULL DEFAULT 'km'`);
      await q(`UPDATE vehicles SET meter_unit = 'h' WHERE meter_unit = 'km' AND vehicle_type::text IN ('cuatrimoto', 'utv')`);
    }
    if (await has('maintenance_types')) {
      await q(`ALTER TABLE maintenance_types ADD COLUMN IF NOT EXISTS interval_unit VARCHAR(2) NOT NULL DEFAULT 'km'`);
      await q(`UPDATE maintenance_types SET interval_unit = 'h' WHERE interval_unit = 'km' AND vehicle_type IN ('cuatrimoto', 'utv')`);
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS vehicles DROP COLUMN IF EXISTS meter_unit`);
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS maintenance_types DROP COLUMN IF EXISTS interval_unit`);
  },
};
