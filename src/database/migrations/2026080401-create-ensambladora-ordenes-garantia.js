'use strict';

// Mismo patrón que ensambladora_ventas/_ordenes_alistamiento/etc: vive en
// el schema del tenant. `items` va como JSONB acá (no una tabla aparte) --
// Pitbox solo necesita mandarlos y mostrarlos, no consultarlos
// relacionalmente; la relación de verdad (con costo_reconocido por pieza)
// vive en el Core. `core_orden_garantia_id` se llena con el id que
// devuelve el Core al confirmar la radicación -- se necesita para poder
// mandar después el evento garantia.cerrada (que referencia ese id).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('ensambladora_ordenes_garantia')) return;

    await queryInterface.createTable('ensambladora_ordenes_garantia', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      vin: { type: Sequelize.STRING, allowNull: false },
      tecnico_documento: { type: Sequelize.STRING, allowNull: true },
      items: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      core_orden_garantia_id: { type: Sequelize.UUID, allowNull: true },
      cerrada: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      fecha_cierre: { type: Sequelize.DATEONLY, allowNull: true },
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
    await queryInterface.dropTable('ensambladora_ordenes_garantia');
  },
};
