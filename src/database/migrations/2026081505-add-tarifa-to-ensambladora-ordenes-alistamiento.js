'use strict';

// Alistamiento nunca enviaba ningún valor de mano de obra al Core (a
// diferencia de Revisión, que sí manda tarifario_servicio_id/valor_mano_obra
// en su evento) -- por eso no se cobraba en liquidaciones. Se agregan los
// mismos 2 campos que ya tiene ensambladora_ordenes_revision.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('ensambladora_ordenes_alistamiento');
    if (!table.tarifario_servicio_id) {
      await queryInterface.addColumn('ensambladora_ordenes_alistamiento', 'tarifario_servicio_id', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }
    if (!table.valor_mano_obra) {
      await queryInterface.addColumn('ensambladora_ordenes_alistamiento', 'valor_mano_obra', {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('ensambladora_ordenes_alistamiento', 'tarifario_servicio_id');
    await queryInterface.removeColumn('ensambladora_ordenes_alistamiento', 'valor_mano_obra');
  },
};
