'use strict';

// Mismo patrón que ensambladora_ventas/_ordenes_alistamiento/_ordenes_entrega
// (ver 2026080201-create-ensambladora-ordenes-locales.js): vive en el
// schema del tenant, con sync_estado/evento_sync_id para saber si ya se
// confirmó con el Core. `politica_id` es el UUID de la política tal como
// la devolvió el Core en `proxima_revision.politica_id` (GET /vehiculos/{vin})
// -- Pitbox no necesita su propia copia del catálogo de políticas, solo
// referenciar cuál se cerró.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('ensambladora_ordenes_revision')) return;

    await queryInterface.createTable('ensambladora_ordenes_revision', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      vin: { type: Sequelize.STRING, allowNull: false },
      politica_id: { type: Sequelize.UUID, allowNull: false },
      fecha_realizada: { type: Sequelize.DATE, allowNull: false },
      kilometraje_registrado: { type: Sequelize.INTEGER, allowNull: true },
      sync_estado: {
        type: Sequelize.ENUM('pendiente', 'enviado', 'confirmado', 'error'),
        allowNull: false,
        defaultValue: 'pendiente',
      },
      evento_sync_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ensambladora_ordenes_revision');
  },
};
