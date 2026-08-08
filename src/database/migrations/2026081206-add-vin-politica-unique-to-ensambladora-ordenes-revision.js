'use strict';

// Mismo bug que tenía ensambladora_ordenes_alistamiento (ver
// 2026081202-add-vin-unique-to-ensambladora-ordenes-alistamiento.js): nada
// impedía registrar la misma revisión dos veces para el mismo vehículo. La
// diferencia es que una revisión NO es "1 por vehículo en toda su vida"
// (hay revisión 1, 2, 3...) sino "1 por vehículo POR política de
// mantenimiento" -- el constraint va sobre (vin, politica_id), no sobre vin
// solo.
module.exports = {
  up: async (queryInterface) => {
    // Deduplicar antes de constraint -- el bug que motiva esta migración ya
    // alcanzó a crear más de una fila para el mismo (vin, politica_id) en
    // al menos un tenant ("Taller Demo", revisión #3 registrada dos veces).
    // Si no se limpia primero, addConstraint de abajo falla justo en ese
    // schema. Se conserva la fila más reciente (created_at) de cada grupo
    // duplicado y se borran las anteriores.
    await queryInterface.sequelize.query(`
      DELETE FROM ensambladora_ordenes_revision a
      USING ensambladora_ordenes_revision b
      WHERE a.vin = b.vin
        AND a.politica_id = b.politica_id
        AND a.id <> b.id
        AND a.created_at < b.created_at;
    `);

    try {
      await queryInterface.addConstraint('ensambladora_ordenes_revision', {
        fields: ['vin', 'politica_id'],
        type: 'unique',
        name: 'ensambladora_ordenes_revision_vin_politica_key',
      });
    } catch (error) {
      // Ya existe (reproceso de la migración, o el schema ya la tenía) --
      // idempotente, no es un error real.
      if (!/already exists/i.test(error.message)) throw error;
    }
  },

  down: async (queryInterface) => {
    try {
      await queryInterface.removeConstraint('ensambladora_ordenes_revision', 'ensambladora_ordenes_revision_vin_politica_key');
    } catch (error) {
      if (!/does not exist/i.test(error.message)) throw error;
    }
  },
};
