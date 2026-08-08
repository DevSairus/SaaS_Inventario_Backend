'use strict';

// Amplía ensambladora_ordenes_revision (creada en
// 2026080301-create-ensambladora-ordenes-revision.js, que solo tenía
// fecha_realizada + kilometraje_registrado) con el detalle que ahora captura
// el formulario de mantenimiento en taller -- ver
// requerimientos-pitbox-formulario-mantenimiento.md, secciones 2 y 3.
//
// `checklist` y `piezas` van como JSONB (mismo criterio que
// ensambladora_ordenes_alistamiento.checklist): el Core no valida contra un
// esquema fijo, así que tampoco hace falta modelarlos como tablas propias
// acá. `core_orden_revision_id` guarda `resultado.orden_revision_id` que
// devuelve el Core al confirmar el evento -- mismo patrón que
// core_orden_garantia_id en ensambladora_ordenes_garantia, útil si más
// adelante hace falta cruzar/mostrar el detalle guardado en el Core.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('ensambladora_ordenes_revision');

    if (!table.checklist) {
      await queryInterface.addColumn('ensambladora_ordenes_revision', 'checklist', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      });
    }
    if (!table.observaciones) {
      await queryInterface.addColumn('ensambladora_ordenes_revision', 'observaciones', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
    if (!table.tarifario_servicio_id) {
      await queryInterface.addColumn('ensambladora_ordenes_revision', 'tarifario_servicio_id', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }
    if (!table.valor_mano_obra) {
      await queryInterface.addColumn('ensambladora_ordenes_revision', 'valor_mano_obra', {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
      });
    }
    if (!table.piezas) {
      await queryInterface.addColumn('ensambladora_ordenes_revision', 'piezas', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      });
    }
    if (!table.core_orden_revision_id) {
      await queryInterface.addColumn('ensambladora_ordenes_revision', 'core_orden_revision_id', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('ensambladora_ordenes_revision', 'checklist');
    await queryInterface.removeColumn('ensambladora_ordenes_revision', 'observaciones');
    await queryInterface.removeColumn('ensambladora_ordenes_revision', 'tarifario_servicio_id');
    await queryInterface.removeColumn('ensambladora_ordenes_revision', 'valor_mano_obra');
    await queryInterface.removeColumn('ensambladora_ordenes_revision', 'piezas');
    await queryInterface.removeColumn('ensambladora_ordenes_revision', 'core_orden_revision_id');
  },
};
