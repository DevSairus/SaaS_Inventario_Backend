'use strict';

// Agrega vehicle_type a sales — necesario para que una cotización
// (document_type = 'cotizacion') con el campo vehículo habilitado
// (tenant features.vehicle_field_enabled) pueda usar el mismo catálogo de
// diagramas de intervención que ya usan las órdenes de trabajo. A diferencia
// de WorkOrder, la cotización NO se vincula a un registro real de Vehicle
// (sigue con placa/marca/modelo en texto libre) — por eso vehicle_type va
// como selector simple aquí, no como FK.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Guard: algunos schemas ya traen esta columna de fábrica (baseline).
    const existingColumns = await queryInterface.describeTable('sales');
    if (!existingColumns.vehicle_type) {
      await queryInterface.addColumn('sales', 'vehicle_type', {
        type: Sequelize.STRING(20),
        allowNull: true,
        comment: 'automovil | camioneta | motocicleta | camion | otro — solo relevante si document_type=cotizacion y hay diagrama de intervención asociado',
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('sales', 'vehicle_type');
  },
};
