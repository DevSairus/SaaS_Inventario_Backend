'use strict';

// Cotización de una moto todavía no vendida, creada por el asesor desde el
// CSA -- mismo patrón que ensambladora_ordenes_garantia/_revision (JSONB
// libre para los rubros, sync_estado/evento_sync_id/core_*_id para el
// seguimiento de sincronización). Vive en el schema del tenant, igual que
// esas tablas (ver 2026080201-create-ensambladora-ordenes-locales.js).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('ensambladora_cotizaciones')) return;

    await queryInterface.createTable('ensambladora_cotizaciones', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      // vin nullable -- una cotización no está atada a una unidad física.
      vin: { type: Sequelize.STRING, allowNull: true },
      linea_id: { type: Sequelize.UUID, allowNull: false },
      // Snapshot -- si la línea cambia de nombre/precio en el Core después,
      // esta cotización sigue mostrando lo que se cotizó en su momento.
      linea_nombre: { type: Sequelize.STRING, allowNull: true },
      tecnico_documento: { type: Sequelize.STRING, allowNull: true },
      cliente_nombre: { type: Sequelize.STRING, allowNull: true },
      cliente_documento: { type: Sequelize.STRING, allowNull: true },
      cliente_telefono: { type: Sequelize.STRING, allowNull: true },
      fecha: { type: Sequelize.DATEONLY, allowNull: false },
      items: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      total: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      core_cotizacion_id: { type: Sequelize.UUID, allowNull: true },
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
    await queryInterface.dropTable('ensambladora_cotizaciones');
  },
};
