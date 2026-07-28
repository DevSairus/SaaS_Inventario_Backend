'use strict';

// Checklist de control de calidad al cierre de la OT (limpieza final, torques
// finales, entrega de repuestos) — se muestra en el PDF final de la orden de
// trabajo, sección "Proceso Calidad y Servicio al Cliente" del nuevo formato.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Guard: algunos schemas ya traen esta columna de fábrica (baseline).
    const existingColumns = await queryInterface.describeTable('work_orders');
    if (!existingColumns.quality_checklist) {
      await queryInterface.addColumn('work_orders', 'quality_checklist', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: { limpieza_final: false, torques_finales: false, entrega_repuestos: false },
        comment: 'Checklist de calidad al cierre: {limpieza_final, torques_finales, entrega_repuestos}',
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('work_orders', 'quality_checklist');
  },
};
