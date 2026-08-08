'use strict';

// Token público persistente para que el cliente consulte/descargue su
// cotización, factura o remisión sin autenticarse -- mismo patrón que
// WorkOrder.share_token (ver backend/src/models/workshop/WorkOrder.js).
// Antes, el link de "Compartir por WhatsApp" de sales.controller.js generaba
// un JWT firmado al vuelo (expiresIn: '48h') que nunca se guardaba en BD:
// cada clic en "compartir" producía una URL distinta y, pasadas 48h, la
// anterior dejaba de servir. NULL hasta que alguien pida compartir; Postgres
// permite múltiples NULL bajo una constraint UNIQUE.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('sales');
    if (!existingColumns.share_token) {
      await queryInterface.addColumn('sales', 'share_token', {
        type: Sequelize.UUID,
        allowNull: true,
        unique: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('sales', 'share_token');
  },
};
