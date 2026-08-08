'use strict';

// Token público para que el cliente consulte el estado de su revisión o
// garantía sin autenticarse -- mismo patrón que WorkOrder.share_token (ver
// backend/src/models/workshop/WorkOrder.js). NULL hasta que alguien pida
// "Compartir seguimiento" desde el formulario; Postgres permite múltiples
// NULL bajo una constraint UNIQUE, así que no hace falta un índice parcial.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const revision = await queryInterface.describeTable('ensambladora_ordenes_revision');
    if (!revision.share_token) {
      await queryInterface.addColumn('ensambladora_ordenes_revision', 'share_token', {
        type: Sequelize.UUID,
        allowNull: true,
        unique: true,
      });
    }

    const garantia = await queryInterface.describeTable('ensambladora_ordenes_garantia');
    if (!garantia.share_token) {
      await queryInterface.addColumn('ensambladora_ordenes_garantia', 'share_token', {
        type: Sequelize.UUID,
        allowNull: true,
        unique: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('ensambladora_ordenes_revision', 'share_token');
    await queryInterface.removeColumn('ensambladora_ordenes_garantia', 'share_token');
  },
};
