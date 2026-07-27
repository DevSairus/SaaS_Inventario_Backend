'use strict';

// Prerrequisito para el sistema de diagramas interactivos de diagnóstico
// (ver propuesta): hoy no existe ningún campo en `vehicles` que distinga
// carro de moto, así que no hay forma de sugerir automáticamente el
// diagrama correcto (suspensión de moto vs. de automóvil, etc.).
//
// Vehículos existentes se backfillean como 'automovil' (el caso más común
// hoy en Pitbox) — el taller puede corregir puntualmente los que sean moto
// desde el formulario de edición del vehículo.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('vehicles', 'vehicle_type', {
      type: Sequelize.ENUM('automovil', 'camioneta', 'motocicleta', 'camion', 'otro'),
      allowNull: false,
      defaultValue: 'automovil',
      comment: 'Tipo de vehículo: automovil, camioneta, motocicleta, camion, otro',
    });
    await queryInterface.addIndex('vehicles', ['tenant_id', 'vehicle_type'], {
      name: 'vehicles_tenant_vehicle_type_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('vehicles', 'vehicles_tenant_vehicle_type_idx');
    await queryInterface.removeColumn('vehicles', 'vehicle_type');
    // Limpiar el tipo ENUM huérfano en Postgres
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_vehicles_vehicle_type";');
  },
};
